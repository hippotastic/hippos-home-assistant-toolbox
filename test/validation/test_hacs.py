"""Regression tests executed inside the official HACS action image."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from custom_components.hacs.base import HacsBase
from custom_components.hacs.repositories.base import HacsManifest
from custom_components.hacs.utils.workarounds import LegacyTreeFile
from custom_components.hacs.validate.base import ValidationException
from custom_components.hacs.validate.hacsjson import Validator as HacsJsonValidator
from custom_components.hacs.validate.information import Validator as InformationValidator
from custom_components.hacs.validate.integration_manifest import Validator as ManifestValidator

from tools.validation import hacs as local


class LocalHacsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.files = ["hacs.json", "README.md", "custom_components/example/manifest.json"]
        self.manifest_path = self.root / self.files[2]
        self.manifest_path.parent.mkdir(parents=True)
        self.manifest = {
            "codeowners": ["@example"],
            "documentation": "https://example.com/docs",
            "domain": "example",
            "issue_tracker": "https://example.com/issues",
            "name": "Example",
            "version": "1.0.0",
        }
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.root / "hacs.json").write_text('{"name":"Example"}', encoding="utf-8")
        (self.root / "README.md").write_text("Local documentation", encoding="utf-8")
        self.addCleanup(patch.stopall)
        patch.object(local, "ROOT", self.root).start()
        patch.object(local, "FILES", self.files).start()
        self.repo = local.LocalIntegrationRepository(HacsBase(), "example/repository")
        self.repo.ref = "local-working-tree"
        self.repo.content.path.remote = "custom_components/example"

    async def test_modified_manifest_is_validated_without_a_remote_fetch(self):
        self.repo.tree = [
            LegacyTreeFile(entry, repository="example/repository", ref=self.repo.ref)
            for entry in await self.repo.get_tree(self.repo.ref)
        ]
        await ManifestValidator(self.repo).async_validate()

        # An uncommitted edit must invalidate a previously valid manifest
        del self.manifest["version"]
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")
        # HACS caches loaded manifests; discard the previous read before revalidating.
        self.repo.integration_manifest = {}
        with self.assertLogs(self.repo.logger, level="WARNING"), self.assertRaises(ValidationException):
            await ManifestValidator(self.repo).async_validate()

    async def test_missing_and_invalid_hacs_json_fail(self):
        self.repo.tree = [
            LegacyTreeFile(entry, repository="example/repository", ref=self.repo.ref)
            for entry in await self.repo.get_tree(self.repo.ref)
        ]
        await HacsJsonValidator(self.repo).async_validate()

        (self.root / "hacs.json").write_text('{"name":"Example","unknown":true}', encoding="utf-8")
        with self.assertLogs(self.repo.logger, level="WARNING"), self.assertRaises(ValidationException):
            await HacsJsonValidator(self.repo).async_validate()

        self.files.remove("hacs.json")
        self.repo.tree = [
            LegacyTreeFile(entry, repository="example/repository", ref=self.repo.ref)
            for entry in await self.repo.get_tree(self.repo.ref)
        ]
        with self.assertRaises(ValidationException):
            await HacsJsonValidator(self.repo).async_validate()

    async def test_deleted_readme_is_missing_from_the_tree(self):
        self.files.remove("README.md")
        self.repo.tree = [
            LegacyTreeFile(entry, repository="example/repository", ref=self.repo.ref)
            for entry in await self.repo.get_tree(self.repo.ref)
        ]
        with self.assertRaises(ValidationException):
            await InformationValidator(self.repo).async_validate()

    async def test_root_content_and_documentation_use_local_files(self):
        self.repo.repository_manifest = HacsManifest.from_dict({"content_in_root": True})
        self.files.append("manifest.json")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        self.assertEqual(await self.repo.async_get_integration_manifest(), self.manifest)
        self.assertEqual(await self.repo.get_integration_manifest(version="unpublished"), self.manifest)
        self.assertEqual(await self.repo.get_documentation(filename="README.md"), "Local documentation")
