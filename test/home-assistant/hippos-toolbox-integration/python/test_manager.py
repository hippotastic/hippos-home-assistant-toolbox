"""Regression tests that run inside the Home Assistant container."""

from pathlib import Path
import tempfile
import unittest

from repository import find_repository_root

from custom_components.hippos_toolbox.api import _parse_catalog
from custom_components.hippos_toolbox.hashing import blueprint_hash
from custom_components.hippos_toolbox.manager import (
    BlueprintManager,
    STATUS_CURRENT,
    STATUS_MISSING,
    STATUS_MODIFIED,
)
from custom_components.hippos_toolbox.models import CatalogEntry, RemoteSnapshot


class FakeConfig:
    """Resolve Home Assistant configuration paths into a temporary directory."""

    def __init__(self, root: Path) -> None:
        self._root = root

    def path(self, *parts: str) -> str:
        return str(self._root.joinpath(*parts))


class FakeHass:
    """Provide the executor and path APIs used by the manager."""

    def __init__(self, root: Path) -> None:
        self.config = FakeConfig(root)
        self.data = {}
        self.services = FakeServices()

    async def async_add_executor_job(self, target, *args):
        return target(*args)


class FakeServices:
    """Report that no reload service is available in isolated manager tests."""

    @staticmethod
    def has_service(domain: str, service: str) -> bool:
        return False


class FakeApi:
    """Return one published blueprint source without making a network request."""

    def __init__(self, source: str) -> None:
        self.source = source

    async def async_fetch_blueprint(
        self, remote_snapshot: RemoteSnapshot, entry: CatalogEntry
    ) -> str:
        return self.source


class FakeStore:
    """Capture storage writes without a running Home Assistant instance."""

    def __init__(self) -> None:
        self.saved = None

    async def async_save(self, value) -> None:
        self.saved = value


def catalog_entry(source: str) -> CatalogEntry:
    """Create the active catalog entry shared by the tests."""

    return CatalogEntry(
        id="example",
        name="Example",
        domain="automation",
        path="blueprints/automation/example.yaml",
        sha256=blueprint_hash(source),
        status="active",
    )


def snapshot(entry: CatalogEntry) -> RemoteSnapshot:
    """Create a remote snapshot containing one blueprint."""

    return RemoteSnapshot(
        entries=(entry,),
        revision="2026.08.06.abcdef0",
        commit_sha="a" * 40,
        release_url="https://github.com/example/commit/abcdef0",
    )


class BlueprintManagerTests(unittest.IsolatedAsyncioTestCase):
    """Verify ownership, conflict, and backup behavior."""

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.manager = object.__new__(BlueprintManager)
        self.manager.hass = FakeHass(self.root)
        self.manager.api = None
        self.manager._store = FakeStore()
        self.manager._state = {"blueprints": {}, "installed_revision": None}
        self.manager.snapshot = None
        self.manager._sync_issues = lambda data: None

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def installed_path(self) -> Path:
        return (
            self.root
            / "blueprints"
            / "automation"
            / "hippotastic"
            / "example.yaml"
        )

    def adoptable_path(self) -> Path:
        return self.root / "blueprints" / "automation" / "hippo" / "example.yaml"

    def test_published_catalog_matches_python_hash_contract(self) -> None:
        repo_root = find_repository_root(Path(__file__))
        entries = _parse_catalog(
            (repo_root / "blueprints" / "catalog.json").read_text(encoding="utf-8")
        )

        for entry in entries:
            if entry.status == "active":
                source = (repo_root / entry.path).read_text(encoding="utf-8")
                self.assertEqual(blueprint_hash(source), entry.sha256, entry.path)

    async def test_line_endings_and_boundary_whitespace_are_current(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation"
        entry = catalog_entry(source)
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        crlf_source = source.replace("\n", "\r\n")
        path.write_text(f" \r\n{crlf_source}\r\n", encoding="utf-8", newline="")
        self.manager._state["blueprints"][entry.id] = {
            "hash": entry.sha256,
            "path": entry.path,
        }

        data = await self.manager.async_evaluate(snapshot(entry))

        self.assertEqual(data.blueprints[0].status, STATUS_CURRENT)
        self.assertEqual(data.update_ids, ())
        self.assertEqual(data.conflict_ids, ())

    async def test_missing_file_is_a_safe_update(self) -> None:
        entry = catalog_entry("blueprint:\n  name: Example\n  domain: automation")

        data = await self.manager.async_evaluate(snapshot(entry))

        self.assertEqual(data.blueprints[0].status, STATUS_MISSING)
        self.assertEqual(data.update_ids, (entry.id,))

    async def test_unexpected_local_content_is_a_conflict(self) -> None:
        entry = catalog_entry("blueprint:\n  name: Example\n  domain: automation")
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        path.write_text("locally changed", encoding="utf-8")

        data = await self.manager.async_evaluate(snapshot(entry))

        self.assertEqual(data.blueprints[0].status, STATUS_MODIFIED)
        self.assertEqual(data.update_ids, ())
        self.assertEqual(data.conflict_ids, (entry.id,))

    async def test_finds_an_exact_blueprint_in_hippo_for_adoption(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = catalog_entry(source)
        path = self.adoptable_path()
        path.parent.mkdir(parents=True)
        path.write_text(source, encoding="utf-8")

        data = await self.manager.async_evaluate(snapshot(entry))

        self.assertEqual(data.blueprints[0].status, STATUS_CURRENT)
        self.assertEqual(data.blueprints[0].installed_path, str(path))
        self.assertEqual(self.manager._state["blueprints"], {})

    async def test_does_not_adopt_unrecognized_content_from_hippo(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = catalog_entry(source)
        path = self.adoptable_path()
        path.parent.mkdir(parents=True)
        path.write_text("locally changed", encoding="utf-8")
        self.manager.api = FakeApi(source)

        initial = await self.manager.async_evaluate(snapshot(entry))
        result = await self.manager.async_install_initial(initial)

        self.assertEqual(result.blueprints[0].status, STATUS_MODIFIED)
        self.assertEqual(result.blueprints[0].installed_path, str(path))
        self.assertEqual(result.conflict_ids, (entry.id,))
        self.assertFalse(self.installed_path().exists())
        self.assertEqual(path.read_text(encoding="utf-8"), "locally changed")

    async def test_migrates_adopted_blueprint_files_and_references(self) -> None:
        source = (
            "blueprint:\n"
            "  name: Example\n"
            "  domain: automation\n"
            "  source_url: https://github.com/hippotastic/"
            "hippos-home-assistant-toolbox/blob/main/"
            "blueprints/automation/example.yaml\n"
        )
        entry = catalog_entry(source)
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text(
            source.replace("  name:", "  # Imported by Home Assistant\n  name:"),
            encoding="utf-8",
        )
        automations_path = self.root / "automations.yaml"
        automations_path.write_text(
            "# Existing comments and quotes are preserved\n"
            "- id: example\n"
            "  use_blueprint:\n"
            "    path: 'hippo/example.yaml' # Existing automation\n",
            encoding="utf-8",
        )
        package_path = self.root / "packages" / "example.yml"
        package_path.parent.mkdir()
        package_path.write_text(
            "automation:\n"
            "  - use_blueprint:\n"
            '      path: "hippo/example.yaml"\n',
            encoding="utf-8",
        )
        self.manager.api = FakeApi(source)

        initial = await self.manager.async_evaluate(snapshot(entry))
        result = await self.manager.async_install_initial(initial)

        self.assertEqual(result.blueprints[0].status, STATUS_CURRENT)
        self.assertEqual(self.installed_path().read_text(encoding="utf-8"), source)
        self.assertFalse(adopted_path.exists())
        self.assertIn(
            "path: 'hippotastic/example.yaml' # Existing automation",
            automations_path.read_text(encoding="utf-8"),
        )
        self.assertIn(
            'path: "hippotastic/example.yaml"',
            package_path.read_text(encoding="utf-8"),
        )
        configuration_backups = self.root.glob(
            "blueprints/.hippos_toolbox_backups/configuration/**/*.bak"
        )
        self.assertEqual(len(list(configuration_backups)), 2)

    async def test_keeps_adopted_file_for_an_unmigrated_reference(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = catalog_entry(source)
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text(source, encoding="utf-8")
        automations_path = self.root / "automations.yaml"
        automations_path.write_text(
            "- id: example\n"
            "  use_blueprint: {path: hippo/example.yaml, input: {}}\n",
            encoding="utf-8",
        )
        self.manager.api = FakeApi(source)

        initial = await self.manager.async_evaluate(snapshot(entry))
        with self.assertLogs(
            "custom_components.hippos_toolbox.manager", level="WARNING"
        ):
            result = await self.manager.async_install_initial(initial)

        self.assertEqual(result.blueprints[0].status, STATUS_CURRENT)
        self.assertTrue(adopted_path.exists())
        self.assertTrue(self.installed_path().exists())
        self.assertIn(
            "hippo/example.yaml", automations_path.read_text(encoding="utf-8")
        )

    def test_only_three_configuration_migration_backups_are_retained(self) -> None:
        path = self.root / "automations.yaml"

        for version in range(5):
            path.write_text(f"version: {version}\n", encoding="utf-8")
            self.manager._backup_configuration_file(path, self.root)

        backup_directory = (
            self.root
            / "blueprints"
            / ".hippos_toolbox_backups"
            / "configuration"
        )
        self.assertEqual(len(list(backup_directory.glob("*.bak"))), 3)

    async def test_recognizes_a_legacy_home_assistant_import(self) -> None:
        entry = catalog_entry("blueprint:\n  name: Example\n  domain: automation")
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        path.write_text(
            "blueprint:\n"
            "  name: Example\n"
            "  domain: automation\n"
            "  source_url: https://github.com/hippotastic/"
            "hippos-home-assistant-toolbox/blob/main/"
            "blueprints/automation/example.yaml\n",
            encoding="utf-8",
        )

        self.assertTrue(self.manager._is_matching_legacy_import(path, entry))

    async def test_recognizes_a_legacy_beta_import(self) -> None:
        entry = catalog_entry("blueprint:\n  name: Example\n  domain: automation")
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        path.write_text(
            "blueprint:\n"
            "  name: Example\n"
            "  domain: automation\n"
            "  source_url: https://raw.githubusercontent.com/hippotastic/"
            "hippos-home-assistant-toolbox/beta/"
            "blueprints/automation/example.yaml\n",
            encoding="utf-8",
        )

        self.assertTrue(self.manager._is_matching_legacy_import(path, entry))

    async def test_only_three_backups_are_retained(self) -> None:
        entry = catalog_entry("blueprint:\n  name: Example\n  domain: automation")
        path = self.installed_path()

        for version in range(5):
            self.manager._write_blueprint(path, entry, f"version: {version}\n")

        backup_directory = (
            self.root
            / "blueprints"
            / ".hippos_toolbox_backups"
            / "automation"
            / entry.id
        )
        self.assertEqual(len(list(backup_directory.glob("*.bak"))), 3)
        self.assertEqual(path.read_text(encoding="utf-8"), "version: 4\n")


if __name__ == "__main__":
    unittest.main()
