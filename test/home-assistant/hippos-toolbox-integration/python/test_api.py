"""Regression tests for update-channel catalog fetching."""

import json
import unittest

from custom_components.hippos_toolbox.api import ToolboxApi
from custom_components.hippos_toolbox.const import (
    CATALOG_PATH,
    GITHUB_API_ROOT,
    GITHUB_RAW_ROOT,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_CHANNEL_STABLE,
)


class FakeToolboxApi(ToolboxApi):
    """Return deterministic GitHub responses and record requested URLs."""

    def __init__(self, update_channel: str) -> None:
        super().__init__(None, update_channel)
        self.requested_urls: list[str] = []

    async def _async_get_json(self, url: str):
        self.requested_urls.append(url)
        if url.endswith("/releases/latest"):
            return {
                "tag_name": "v0.2.0",
                "html_url": "https://github.com/example/releases/tag/v0.2.0",
                "draft": False,
                "prerelease": False,
            }
        if url.endswith("/commits/v0.2.0"):
            return {"sha": "b" * 40}
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
    """Verify source selection and user-visible revision labels."""

    async def test_stable_fetches_the_latest_published_release(self) -> None:
        api = FakeToolboxApi(UPDATE_CHANNEL_STABLE)

        snapshot = await api.async_fetch_snapshot()

        self.assertEqual(snapshot.revision, "v0.2.0")
        self.assertEqual(snapshot.commit_sha, "b" * 40)
        self.assertEqual(
            snapshot.release_url,
            "https://github.com/example/releases/tag/v0.2.0",
        )
        self.assertEqual(
            api.requested_urls,
            [
                f"{GITHUB_API_ROOT}/releases/latest",
                f"{GITHUB_API_ROOT}/commits/v0.2.0",
                f"{GITHUB_RAW_ROOT}/{'b' * 40}/{CATALOG_PATH}",
            ],
        )

    async def test_development_fetches_main_with_a_distinct_revision(self) -> None:
        api = FakeToolboxApi(UPDATE_CHANNEL_DEVELOPMENT)

        snapshot = await api.async_fetch_snapshot()

        self.assertEqual(snapshot.revision, "development-2026.08.10.aaaaaaa")
        self.assertEqual(
            api.requested_urls[0],
            f"{GITHUB_API_ROOT}/commits?path={CATALOG_PATH}&sha=main&per_page=1",
        )


if __name__ == "__main__":
    unittest.main()
