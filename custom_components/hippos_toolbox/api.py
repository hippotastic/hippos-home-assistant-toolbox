"""GitHub client for the published blueprint catalog."""

import asyncio
from datetime import datetime
import json
import re
from typing import Any
from urllib.parse import quote

from aiohttp import ClientResponseError, ClientSession

from homeassistant.exceptions import HomeAssistantError

from .const import (
    CATALOG_PATH,
    CATALOG_SCHEMA_VERSION,
    DEVELOPMENT_BRANCH,
    GITHUB_API_ROOT,
    GITHUB_RAW_ROOT,
    SUPPORTED_BLUEPRINT_DOMAINS,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_CHANNEL_STABLE,
)
from .hashing import blueprint_hash
from .models import CatalogEntry, RemoteSnapshot


class ToolboxApiError(HomeAssistantError):
    """Raised when published toolbox data cannot be loaded safely."""


class ToolboxApi:
    """Load catalog revisions and blueprint source from GitHub."""

    def __init__(self, session: ClientSession, update_channel: str) -> None:
        """Initialize the client."""

        self._session = session
        self._update_channel = update_channel

    async def _async_get_json(self, url: str) -> Any:
        try:
            async with asyncio.timeout(20), self._session.get(
                url,
                headers={
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            ) as response:
                response.raise_for_status()
                return await response.json()
        except (TimeoutError, ClientResponseError, json.JSONDecodeError) as err:
            raise ToolboxApiError(f"Unable to load {url}: {err}") from err

    async def _async_get_text(self, url: str) -> str:
        try:
            async with asyncio.timeout(20), self._session.get(url) as response:
                response.raise_for_status()
                return await response.text(encoding="utf-8")
        except (TimeoutError, ClientResponseError, UnicodeDecodeError) as err:
            raise ToolboxApiError(f"Unable to load {url}: {err}") from err

    async def async_fetch_snapshot(self) -> RemoteSnapshot:
        """Fetch the selected channel and catalog from an immutable revision."""

        if self._update_channel == UPDATE_CHANNEL_STABLE:
            revision, commit_sha, release_url = (
                await self._async_fetch_stable_revision()
            )
        elif self._update_channel == UPDATE_CHANNEL_DEVELOPMENT:
            revision, commit_sha, release_url = (
                await self._async_fetch_development_revision()
            )
        else:
            raise ToolboxApiError(f"Unsupported update channel: {self._update_channel}")

        source = await self._async_get_text(
            f"{GITHUB_RAW_ROOT}/{commit_sha}/{CATALOG_PATH}"
        )
        entries = _parse_catalog(source)

        return RemoteSnapshot(
            entries=entries,
            revision=revision,
            commit_sha=commit_sha,
            release_url=release_url,
        )

    async def _async_fetch_stable_revision(self) -> tuple[str, str, str]:
        """Resolve the latest stable GitHub release to its exact commit."""

        release = await self._async_get_json(f"{GITHUB_API_ROOT}/releases/latest")
        if not isinstance(release, dict):
            raise ToolboxApiError("GitHub returned invalid release metadata")

        tag_name = release.get("tag_name")
        release_url = release.get("html_url")
        if (
            not isinstance(tag_name, str)
            or not tag_name
            or not isinstance(release_url, str)
            or release.get("draft") is True
            or release.get("prerelease") is True
        ):
            raise ToolboxApiError("GitHub returned invalid stable release metadata")

        commit = await self._async_get_json(
            f"{GITHUB_API_ROOT}/commits/{quote(tag_name, safe='')}"
        )
        if not isinstance(commit, dict):
            raise ToolboxApiError("GitHub returned invalid release commit metadata")

        commit_sha = commit.get("sha")
        if not isinstance(commit_sha, str) or not re.fullmatch(
            r"[a-f0-9]{40}", commit_sha
        ):
            raise ToolboxApiError("GitHub returned an invalid release commit SHA")

        return tag_name, commit_sha, release_url

    async def _async_fetch_development_revision(self) -> tuple[str, str, str]:
        """Resolve the newest catalog commit on the main development branch."""

        commits = await self._async_get_json(
            f"{GITHUB_API_ROOT}/commits?"
            f"path={CATALOG_PATH}&sha={DEVELOPMENT_BRANCH}&per_page=1"
        )
        if not isinstance(commits, list) or not commits:
            raise ToolboxApiError("GitHub returned no commit for the blueprint catalog")

        latest = commits[0]
        try:
            commit_sha = latest["sha"]
            committed_at = latest["commit"]["committer"]["date"]
            release_url = latest["html_url"]
        except (KeyError, TypeError) as err:
            raise ToolboxApiError("GitHub returned invalid commit metadata") from err

        if not isinstance(commit_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", commit_sha):
            raise ToolboxApiError("GitHub returned an invalid commit SHA")
        if not isinstance(committed_at, str) or not isinstance(release_url, str):
            raise ToolboxApiError("GitHub returned invalid commit details")

        try:
            date = datetime.fromisoformat(committed_at.replace("Z", "+00:00")).date()
        except ValueError as err:
            raise ToolboxApiError("GitHub returned an invalid commit date") from err

        revision = f"development-{date:%Y.%m.%d}.{commit_sha[:7]}"
        return revision, commit_sha, release_url

    async def async_fetch_blueprint(
        self, snapshot: RemoteSnapshot, entry: CatalogEntry
    ) -> str:
        """Fetch and verify a blueprint from a catalog revision."""

        source = await self._async_get_text(
            f"{GITHUB_RAW_ROOT}/{snapshot.commit_sha}/{entry.path}"
        )
        actual_hash = blueprint_hash(source)
        if actual_hash != entry.sha256:
            raise ToolboxApiError(
                f"Hash mismatch for {entry.path}: expected {entry.sha256}, got {actual_hash}"
            )

        return source


def _required_string(value: dict[str, Any], key: str, entry_id: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ToolboxApiError(f"Catalog entry {entry_id} has an invalid {key}")
    return result


def _parse_catalog(source: str) -> tuple[CatalogEntry, ...]:
    try:
        value = json.loads(source)
    except json.JSONDecodeError as err:
        raise ToolboxApiError("Blueprint catalog contains invalid JSON") from err

    if (
        not isinstance(value, dict)
        or value.get("schema_version") != CATALOG_SCHEMA_VERSION
        or not isinstance(value.get("blueprints"), list)
    ):
        raise ToolboxApiError("Blueprint catalog uses an unsupported schema")

    entries: list[CatalogEntry] = []
    ids: set[str] = set()
    paths: set[str] = set()

    for raw_entry in value["blueprints"]:
        if not isinstance(raw_entry, dict):
            raise ToolboxApiError("Blueprint catalog entry must be an object")

        entry_id = _required_string(raw_entry, "id", "unknown")
        domain = _required_string(raw_entry, "domain", entry_id)
        path = _required_string(raw_entry, "path", entry_id)
        status = _required_string(raw_entry, "status", entry_id)
        digest = _required_string(raw_entry, "sha256", entry_id)

        if not re.fullmatch(r"[a-z0-9_]+", entry_id) or entry_id in ids:
            raise ToolboxApiError(f"Catalog entry has an invalid or duplicate id: {entry_id}")
        if domain not in SUPPORTED_BLUEPRINT_DOMAINS:
            raise ToolboxApiError(f"Catalog entry {entry_id} has unsupported domain {domain}")
        if status not in ("active", "deprecated"):
            raise ToolboxApiError(f"Catalog entry {entry_id} has invalid status {status}")
        if (
            not path.startswith(f"blueprints/{domain}/")
            or not path.endswith((".yaml", ".yml"))
            or ".." in path.split("/")
            or path in paths
        ):
            raise ToolboxApiError(f"Catalog entry {entry_id} has an unsafe or duplicate path")
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ToolboxApiError(f"Catalog entry {entry_id} has an invalid SHA-256 hash")

        deprecated_message = raw_entry.get("deprecated_message")
        replacement = raw_entry.get("replacement")
        if deprecated_message is not None and not isinstance(deprecated_message, str):
            raise ToolboxApiError(f"Catalog entry {entry_id} has an invalid deprecation message")
        if replacement is not None and not isinstance(replacement, str):
            raise ToolboxApiError(f"Catalog entry {entry_id} has an invalid replacement")

        entries.append(
            CatalogEntry(
                id=entry_id,
                name=_required_string(raw_entry, "name", entry_id),
                domain=domain,
                path=path,
                sha256=digest,
                status=status,
                deprecated_message=deprecated_message,
                replacement=replacement,
            )
        )
        ids.add(entry_id)
        paths.add(path)

    for entry in entries:
        if entry.replacement is None:
            continue
        replacement = next(
            (candidate for candidate in entries if candidate.id == entry.replacement),
            None,
        )
        if replacement is None or replacement.status != "active":
            raise ToolboxApiError(
                f"Deprecated blueprint {entry.id} references non-active replacement "
                f"{entry.replacement}"
            )

    return tuple(entries)
