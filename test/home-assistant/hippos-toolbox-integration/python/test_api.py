"""Regression tests for release-channel catalog fetching."""

import json
import unittest

from custom_components.hippos_toolbox.api import ToolboxApi
from custom_components.hippos_toolbox.const import (
    CATALOG_PATH,
    GITHUB_API_ROOT,
    GITHUB_RAW_ROOT,
    RELEASE_CHANNEL_BETA,
    RELEASE_CHANNEL_STABLE,
)


class FakeToolboxApi(ToolboxApi):
    """Return deterministic GitHub responses and record requested URLs."""

    def __init__(self, release_channel: str) -> None:
        super().__init__(None, release_channel)
        self.requested_urls: list[str] = []

    async def _async_get_json(self, url: str):
        self.requested_urls.append(url)
        return [
            {
                "sha": "a" * 40,
                "commit": {"committer": {"date": "2026-08-10T12:00:00Z"}},
                "html_url": "https://github.com/example/commit/aaaaaaa",
            }
        ]

    async def _async_get_text(self, url: str) -> str:
        self.requested_urls.append(url)
        return json.dumps({"schema_version": 1, "blueprints": []})


class ToolboxApiTests(unittest.IsolatedAsyncioTestCase):
    """Verify branch selection and user-visible revision labels."""

    async def test_stable_fetches_main_without_revision_prefix(self) -> None:
        api = FakeToolboxApi(RELEASE_CHANNEL_STABLE)

        snapshot = await api.async_fetch_snapshot()

        self.assertEqual(snapshot.revision, "2026.08.10.aaaaaaa")
        self.assertEqual(
            api.requested_urls,
            [
                f"{GITHUB_API_ROOT}/commits?path={CATALOG_PATH}&sha=main&per_page=1",
                f"{GITHUB_RAW_ROOT}/{'a' * 40}/{CATALOG_PATH}",
            ],
        )

    async def test_beta_fetches_beta_with_revision_prefix(self) -> None:
        api = FakeToolboxApi(RELEASE_CHANNEL_BETA)

        snapshot = await api.async_fetch_snapshot()

        self.assertEqual(snapshot.revision, "beta-2026.08.10.aaaaaaa")
        self.assertEqual(
            api.requested_urls[0],
            f"{GITHUB_API_ROOT}/commits?path={CATALOG_PATH}&sha=beta&per_page=1",
        )


if __name__ == "__main__":
    unittest.main()
