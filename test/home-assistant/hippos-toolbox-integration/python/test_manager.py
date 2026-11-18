"""Regression tests for synchronizing bundled blueprint files."""

from dataclasses import asdict, replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.exceptions import HomeAssistantError

from custom_components.hippos_toolbox import catalog
from custom_components.hippos_toolbox.hashing import blueprint_hash
from custom_components.hippos_toolbox.manager import async_sync_blueprints

from repository import find_repository_root

_SOURCE = "blueprint:\n  name: Example\n  domain: automation\ntriggers: []\nactions: []\n"


class BlueprintSyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.root = Path(self.enterContext(TemporaryDirectory()))
        self.package = self.root / "package"
        self.config = self.root / "config"
        self.installed_dir = self.config / "blueprints" / "automation" / "hippotastic"
        self.installed_dir.mkdir(parents=True)
        self.installed_file = self.installed_dir / "example.yaml"
        self.hass = SimpleNamespace(
            config=SimpleNamespace(
                path=lambda *parts: str(self.config.joinpath(*parts)),
            ),
            async_add_executor_job=AsyncMock(side_effect=lambda job, *args: job(*args)),
            services=SimpleNamespace(
                has_service=Mock(return_value=True),
                async_call=AsyncMock(),
            ),
        )
        self.enterContext(patch.object(catalog, "_PACKAGE_ROOT", self.package))
        self.entry = self.add_bundled_blueprint("example", _SOURCE)
        self.write_catalog(self.entry)

    def add_bundled_blueprint(self, name: str, source: str) -> catalog.CatalogEntry:
        path = f"blueprints/automation/{name}.yaml"
        target = self.package / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source, encoding="utf-8")
        return catalog.CatalogEntry(
            id=name,
            name=name,
            domain="automation",
            path=path,
            sha256=blueprint_hash(source),
            status="active",
        )

    def write_catalog(self, *entries: catalog.CatalogEntry) -> None:
        (self.package / "blueprints" / "catalog.json").write_text(
            json.dumps({"schema_version": 1, "blueprints": [asdict(entry) for entry in entries]}),
            encoding="utf-8",
        )

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

    async def test_installs_a_missing_blueprint_and_reloads_its_domain(self) -> None:
        await async_sync_blueprints(self.hass)

        self.assertEqual(self.installed_file.read_text(), _SOURCE)
        self.hass.services.async_call.assert_awaited_once_with(
            "automation", "reload", blocking=True
        )

    async def test_replaces_local_edits_only_at_listed_paths(self) -> None:
        self.installed_file.write_bytes(b"local edit\n")
        unrelated = self.installed_dir / "custom.yaml"
        unrelated.write_bytes(b"unrelated blueprint\n")
        manual = self.installed_dir.parent / "manual" / "example.yaml"
        manual.parent.mkdir()
        manual.write_bytes(b"manual import\n")
        automations = self.config / "automations.yaml"
        config = b"- use_blueprint:\n    path: hippotastic/example.yaml\n"
        automations.write_bytes(config)

        await async_sync_blueprints(self.hass)

        self.assertEqual(self.installed_file.read_text(), _SOURCE)
        self.assertEqual(unrelated.read_bytes(), b"unrelated blueprint\n")
        self.assertEqual(manual.read_bytes(), b"manual import\n")
        self.assertEqual(automations.read_bytes(), config)
        self.assertFalse((self.config / "blueprints" / ".hippos_toolbox_backups").exists())
        self.hass.services.async_call.assert_awaited_once_with(
            "automation", "reload", blocking=True
        )

    async def test_skips_writing_and_reloading_an_identical_blueprint(self) -> None:
        self.installed_file.write_text(_SOURCE, encoding="utf-8")

        with patch("custom_components.hippos_toolbox.manager.write_utf8_file_atomic") as write:
            await async_sync_blueprints(self.hass)

        write.assert_not_called()
        self.hass.services.async_call.assert_not_awaited()

    async def test_validates_the_entire_bundle_before_writing(self) -> None:
        corrupt = self.add_bundled_blueprint("second", _SOURCE)
        self.write_catalog(self.entry, corrupt)
        (self.package / corrupt.path).write_text("unexpected content", encoding="utf-8")
        self.installed_file.write_text("previous version", encoding="utf-8")

        with self.assertRaisesRegex(HomeAssistantError, "Hash mismatch"):
            await async_sync_blueprints(self.hass)

        self.assertEqual(self.installed_file.read_text(), "previous version")
        self.hass.services.async_call.assert_not_awaited()

    async def test_reloads_a_successful_write_when_a_later_file_cannot_be_written(self) -> None:
        second = self.add_bundled_blueprint("second", _SOURCE)
        self.write_catalog(self.entry, second)
        (self.installed_dir / "second.yaml").mkdir()

        with self.assertRaises(IsADirectoryError):
            await async_sync_blueprints(self.hass)

        self.assertEqual(self.installed_file.read_text(), _SOURCE)
        self.hass.services.async_call.assert_awaited_once_with(
            "automation", "reload", blocking=True
        )

    async def test_deprecated_blueprints_remain_on_disk_and_show_a_warning(self) -> None:
        second = self.add_bundled_blueprint("second", _SOURCE)
        self.write_catalog(
            replace(self.entry, status="deprecated", replacement=second.id),
            second,
        )
        (self.package / self.entry.path).unlink()
        self.installed_file.write_text("previous version", encoding="utf-8")

        with patch("custom_components.hippos_toolbox.manager.ir.async_create_issue") as issue:
            await async_sync_blueprints(self.hass)

        self.assertEqual(self.installed_file.read_text(), "previous version")
        issue.assert_called_once()
        self.assertEqual(issue.call_args.args[1:], ("hippos_toolbox", "deprecated_example"))
        self.assertFalse(issue.call_args.kwargs["is_fixable"])
        self.assertIn("second", issue.call_args.kwargs["translation_placeholders"]["message"])
