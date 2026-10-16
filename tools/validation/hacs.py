"""Run the official HACS action against working-tree files and live GitHub metadata."""

import asyncio
import json
from pathlib import Path
import sys

import action
from aiogithubapi.models.git_tree import GitHubGitTreeEntryModel
from custom_components.hacs.enums import HacsCategory
from custom_components.hacs.repositories import REPOSITORY_CLASSES
from custom_components.hacs.repositories.integration import HacsIntegrationRepository

ROOT = Path("/github/workspace")
FILES: list[str] = []


class LocalIntegrationRepository(HacsIntegrationRepository):
    """Replace remote file reads; leave registration and every validator unchanged."""

    async def get_tree(self, ref):
        directories = {
            str(parent)
            for filename in FILES
            for parent in Path(filename).parents
            if str(parent) != "."
        }
        return [
            GitHubGitTreeEntryModel({"path": path, "type": "tree"})
            for path in sorted(directories)
        ] + [
            GitHubGitTreeEntryModel({"path": path, "type": "blob"})
            for path in FILES
        ]

    def _read_json(self, path):
        if path not in FILES:
            return None
        return json.loads((ROOT / path).read_text(encoding="utf-8"))

    async def async_get_hacs_json(self, ref=None):
        return self._read_json("hacs.json")

    async def get_hacs_json_raw(self, *, version, **kwargs):
        return self._read_json("hacs.json")

    async def async_get_integration_manifest(self, ref=None):
        path = (
            "manifest.json"
            if self.repository_manifest.content_in_root
            else f"{self.content.path.remote}/manifest.json"
        )
        return self._read_json(path)

    async def get_integration_manifest(self, *, version, **kwargs):
        path = (
            "manifest.json"
            if self.repository_manifest.content_in_root
            else f"{self.content.path.remote}/manifest.json"
        )
        return self._read_json(path)

    async def get_documentation(self, *, filename=None, version=None, **kwargs):
        if filename not in FILES:
            return None
        return (ROOT / filename).read_text(encoding="utf-8")


if __name__ == "__main__":
    FILES = json.load(sys.stdin)
    # Use the action's complete registration path, including its dynamic validator discovery
    REPOSITORY_CLASSES[HacsCategory.INTEGRATION] = LocalIntegrationRepository
    asyncio.run(action.preflight())
