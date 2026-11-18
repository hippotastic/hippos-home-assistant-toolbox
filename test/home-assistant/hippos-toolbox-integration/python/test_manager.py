"""Regression tests that run inside the Home Assistant container."""

from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from homeassistant.exceptions import HomeAssistantError

from repository import find_repository_root

from custom_components.hippos_toolbox import catalog
from custom_components.hippos_toolbox.hashing import blueprint_hash
from custom_components.hippos_toolbox.manager import (
    BlueprintManager,
    STATUS_CURRENT,
    STATUS_MISSING,
    STATUS_MODIFIED,
)
from custom_components.hippos_toolbox.models import (
    AffectedAutomation,
    CatalogEntry,
)


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


class FakeStore:
    """Capture storage writes without a running Home Assistant instance."""

    def __init__(self) -> None:
        self.loaded = None
        self.saved = None

    async def async_load(self):
        return self.loaded

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


def compatibility_blueprint_source() -> str:
    """Return a valid blueprint with one required and one optional input."""

    return (
        "blueprint:\n"
        "  name: Example\n"
        "  domain: automation\n"
        "  input:\n"
        "    required_entity:\n"
        "      selector:\n"
        "        entity: {}\n"
        "    optional_entity:\n"
        "      default: sensor.default\n"
        "      selector:\n"
        "        entity: {}\n"
        "triggers: []\n"
        "actions: []\n"
    )


class BlueprintManagerTests(unittest.IsolatedAsyncioTestCase):
    """Verify ownership, conflict, and backup behavior."""

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.manager = object.__new__(BlueprintManager)
        self.manager.hass = FakeHass(self.root)
        self.manager._store = FakeStore()
        self.manager._state = {"blueprints": {}}
        self.manager._entries = ()
        self.manager._sync_issues = lambda states: None
        self.package = self.root / "package"
        patcher = patch.object(catalog, "_PACKAGE_ROOT", self.package)
        patcher.start()
        self.addCleanup(patcher.stop)

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

    def bundle(self, source: str) -> CatalogEntry:
        entry = catalog_entry(source)
        path = self.package / entry.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
        (self.package / "blueprints" / "catalog.json").write_text(
            json.dumps({"schema_version": 1, "blueprints": [asdict(entry)]}),
            encoding="utf-8",
        )
        self.manager._entries = (entry,)
        return entry

    def test_bundled_catalog_matches_python_hash_contract(self) -> None:
        package = find_repository_root(Path(__file__)) / "custom_components" / "hippos_toolbox"
        with patch.object(catalog, "_PACKAGE_ROOT", package):
            entries = catalog.load_catalog()
            self.assertTrue(entries)
            for entry in entries:
                if entry.status == "active":
                    source = catalog.read_blueprint(entry)
                    self.assertEqual(blueprint_hash(source), entry.sha256, entry.path)
                    self.assertNotIn("source_url:", source)

    async def test_line_endings_and_boundary_whitespace_are_current(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation"
        entry = self.bundle(source)
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        crlf_source = source.replace("\n", "\r\n")
        path.write_text(f" \r\n{crlf_source}\r\n", encoding="utf-8", newline="")
        self.manager._state["blueprints"][entry.id] = {
            "hash": entry.sha256,
            "path": entry.path,
        }

        data = await self.manager._async_evaluate()

        self.assertEqual(data[0].status, STATUS_CURRENT)

    async def test_missing_file_is_a_safe_update(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)

        data = await self.manager._async_evaluate()

        self.assertEqual(data[0].status, STATUS_MISSING)
        await self.manager.async_setup()
        self.assertEqual(self.installed_path().read_text(), source)
        self.assertEqual(self.manager._store.saved["blueprints"][entry.id]["hash"], entry.sha256)

    async def test_setup_replaces_a_previously_managed_file_at_the_same_path(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        previous_source = source.replace("name: Example", "name: Previous version")
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        path.write_text(previous_source, encoding="utf-8")
        self.manager._store.loaded = {
            "blueprints": {entry.id: {"path": entry.path, "hash": blueprint_hash(previous_source)}},
            "installed_revision": "main-before-bundling",
        }
        automations_path = self.root / "automations.yaml"
        automations_source = "- use_blueprint:\n    path: hippotastic/example.yaml\n"
        automations_path.write_text(automations_source, encoding="utf-8")
        backup_dir = self.root / "blueprints" / ".hippos_toolbox_backups" / "automation" / entry.id

        with patch.object(self.manager, "_async_reload_domains", new_callable=AsyncMock) as reload:
            await self.manager.async_setup()
            reload.assert_awaited_once_with({"automation"})
            reload.reset_mock()
            await self.manager.async_setup()
            reload.assert_not_awaited()

        self.assertEqual(path.read_text(), source)
        self.assertEqual(automations_path.read_text(), automations_source)
        self.assertEqual([file.read_text() for file in backup_dir.glob("*.bak")], [previous_source])
        self.assertEqual(self.manager._store.saved["blueprints"][entry.id]["hash"], entry.sha256)

    async def test_setup_rejects_a_bundle_whose_content_does_not_match_its_catalog(self) -> None:
        entry = self.bundle("blueprint:\n  name: Example\n  domain: automation\n")
        (self.package / entry.path).write_text("unexpected content", encoding="utf-8")

        with self.assertRaisesRegex(HomeAssistantError, "Hash mismatch"):
            await self.manager.async_setup()

        self.assertFalse(self.installed_path().exists())

    async def test_unexpected_local_content_is_a_conflict(self) -> None:
        entry = self.bundle("blueprint:\n  name: Example\n  domain: automation")
        path = self.installed_path()
        path.parent.mkdir(parents=True)
        path.write_text("locally changed", encoding="utf-8")

        data = await self.manager._async_evaluate()

        self.assertEqual(data[0].status, STATUS_MODIFIED)

    async def test_restore_compatibility_reports_missing_required_inputs(
        self,
    ) -> None:
        source = compatibility_blueprint_source()
        entry = self.bundle(source)
        config = {
            "automation": [
                {
                    "id": "affected",
                    "alias": "Affected automation",
                    "use_blueprint": {
                        "path": "hippotastic/example.yaml",
                        "input": {"optional_entity": "sensor.optional"},
                    },
                },
                {
                    "id": "safe",
                    "alias": "Safe automation",
                    "use_blueprint": {
                        "path": "hippo/example.yaml",
                        "input": {"required_entity": "sensor.required"},
                    },
                },
                {
                    "id": "other",
                    "alias": "Other blueprint",
                    "use_blueprint": {
                        "path": "someone_else/example.yaml",
                        "input": {},
                    },
                },
            ]
        }

        with patch(
            "custom_components.hippos_toolbox.manager.async_hass_config_yaml",
            new=AsyncMock(return_value=config),
        ):
            affected = await self.manager.async_check_restore_compatibility(
                entry.id
            )

        self.assertEqual(
            affected,
            (
                AffectedAutomation(
                    name="Affected automation",
                    automation_id="affected",
                    missing_inputs=("required_entity",),
                ),
            ),
        )
        self.assertFalse(self.installed_path().exists())
        self.assertIsNone(self.manager._store.saved)

    async def test_restore_compatibility_rejects_a_malformed_candidate(
        self,
    ) -> None:
        source = "blueprint: ["
        entry = self.bundle(source)

        with self.assertRaises(HomeAssistantError):
            await self.manager.async_check_restore_compatibility(entry.id)

    async def test_restore_compatibility_rejects_malformed_target_inputs(
        self,
    ) -> None:
        source = compatibility_blueprint_source()
        entry = self.bundle(source)
        config = {
            "automation": [
                {
                    "id": "malformed",
                    "use_blueprint": {
                        "path": "hippotastic/example.yaml",
                        "input": [],
                    },
                }
            ]
        }

        with (
            patch(
                "custom_components.hippos_toolbox.manager.async_hass_config_yaml",
                new=AsyncMock(return_value=config),
            ),
            self.assertRaises(HomeAssistantError),
        ):
            await self.manager.async_check_restore_compatibility(entry.id)

    async def test_finds_an_exact_blueprint_in_hippo_for_adoption(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        path = self.adoptable_path()
        path.parent.mkdir(parents=True)
        path.write_text(source, encoding="utf-8")

        data = await self.manager._async_evaluate()

        self.assertEqual(data[0].status, STATUS_CURRENT)
        self.assertEqual(data[0].installed_path, str(path))
        self.assertEqual(self.manager._state["blueprints"], {})

    async def test_does_not_adopt_unrecognized_content_from_hippo(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        path = self.adoptable_path()
        path.parent.mkdir(parents=True)
        path.write_text("locally changed", encoding="utf-8")

        await self.manager.async_setup()
        result = await self.manager._async_evaluate()

        self.assertEqual(result[0].status, STATUS_MODIFIED)
        self.assertEqual(result[0].installed_path, str(path))
        self.assertFalse(self.installed_path().exists())
        self.assertEqual(path.read_text(encoding="utf-8"), "locally changed")

    async def test_rediscovers_a_legacy_conflict_after_an_incomplete_restore(
        self,
    ) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        installed_path = self.installed_path()
        installed_path.parent.mkdir(parents=True)
        installed_path.write_text(source, encoding="utf-8")
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text("locally changed", encoding="utf-8")
        self.manager._state["blueprints"][entry.id] = {
            "hash": entry.sha256,
            "path": entry.path,
        }

        data = await self.manager._async_evaluate()

        self.assertEqual(data[0].status, STATUS_MODIFIED)
        self.assertEqual(data[0].installed_path, str(adopted_path))

    async def test_restore_migrates_a_legacy_conflict_and_its_references(self) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        installed_path = self.installed_path()
        installed_path.parent.mkdir(parents=True)
        installed_path.write_text(source, encoding="utf-8")
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text("locally changed", encoding="utf-8")
        automations_path = self.root / "automations.yaml"
        automations_path.write_text(
            "- id: example\n"
            "  use_blueprint:\n"
            "    path: hippo/example.yaml\n",
            encoding="utf-8",
        )
        self.manager._state["blueprints"][entry.id] = {
            "hash": entry.sha256,
            "path": entry.path,
        }

        restored = await self.manager.async_restore_blueprint(entry.id)

        self.assertTrue(restored)
        self.assertFalse(adopted_path.exists())
        self.assertIn(
            "path: hippotastic/example.yaml",
            automations_path.read_text(encoding="utf-8"),
        )

    async def test_restore_stays_unresolved_when_a_reference_cannot_be_migrated(
        self,
    ) -> None:
        source = "blueprint:\n  name: Example\n  domain: automation\n"
        entry = self.bundle(source)
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text("locally changed", encoding="utf-8")
        automations_path = self.root / "automations.yaml"
        automations_path.write_text(
            "- id: example\n"
            "  use_blueprint: {path: hippo/example.yaml, input: {}}\n",
            encoding="utf-8",
        )

        with self.assertLogs(
            "custom_components.hippos_toolbox.manager", level="WARNING"
        ):
            restored = await self.manager.async_restore_blueprint(entry.id)

        self.assertFalse(restored)
        self.assertTrue(adopted_path.exists())
        self.assertIn(
            "hippo/example.yaml", automations_path.read_text(encoding="utf-8")
        )

    async def test_migrates_adopted_blueprint_files_and_references(self) -> None:
        source = (
            "blueprint:\n"
            "  name: Example\n"
            "  domain: automation\n"
        )
        self.bundle(source)
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text(
            source.replace("  name:", "  # Imported by Home Assistant\n  name:")
            + "  source_url: https://github.com/hippotastic/"
            "hippos-home-assistant-toolbox/blob/main/"
            "blueprints/automation/example.yaml\n",
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

        await self.manager.async_setup()
        result = await self.manager._async_evaluate()

        self.assertEqual(result[0].status, STATUS_CURRENT)
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
        entry = self.bundle(source)
        adopted_path = self.adoptable_path()
        adopted_path.parent.mkdir(parents=True)
        adopted_path.write_text(source, encoding="utf-8")
        automations_path = self.root / "automations.yaml"
        automations_path.write_text(
            "- id: example\n"
            "  use_blueprint: {path: hippo/example.yaml, input: {}}\n",
            encoding="utf-8",
        )

        with self.assertLogs(
            "custom_components.hippos_toolbox.manager", level="WARNING"
        ):
            await self.manager.async_setup()
        result = await self.manager._async_evaluate()

        self.assertEqual(result[0].status, STATUS_CURRENT)
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
        entry = self.bundle("blueprint:\n  name: Example\n  domain: automation")
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
        path.write_text(path.read_text().replace("name: Example", "name: Local edit"))

        await self.manager.async_setup()

        self.assertEqual((await self.manager._async_evaluate())[0].status, STATUS_MODIFIED)
        self.assertIn("name: Local edit", path.read_text())

    async def test_only_three_backups_are_retained(self) -> None:
        entry = self.bundle("blueprint:\n  name: Example\n  domain: automation")
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
