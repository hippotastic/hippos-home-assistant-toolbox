"""Manage blueprint files and installation state."""

from __future__ import annotations

from datetime import datetime
import logging
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.storage import Store
from homeassistant.util import yaml as yaml_util

from .api import ToolboxApi
from .const import (
    BACKUP_COUNT,
    DOMAIN,
    GITHUB_RAW_ROOT,
    GITHUB_WEB_ROOT,
    MANAGED_DIRECTORY,
    RELEASE_CHANNEL_BRANCHES,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .hashing import blueprint_hash
from .models import BlueprintState, CatalogEntry, CoordinatorData, RemoteSnapshot

_LOGGER = logging.getLogger(__name__)

STATUS_CURRENT = "current"
STATUS_MISSING = "missing"
STATUS_MODIFIED = "modified"
STATUS_UPDATE_AVAILABLE = "update_available"


class BlueprintManager:
    """Compare, install, back up, and restore managed blueprints."""

    def __init__(self, hass: HomeAssistant, api: ToolboxApi) -> None:
        """Initialize the manager."""

        self.hass = hass
        self.api = api
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._state: dict[str, Any] = {"blueprints": {}, "installed_revision": None}
        self.snapshot: RemoteSnapshot | None = None

    async def async_load(self) -> None:
        """Load persistent ownership state."""

        stored = await self._store.async_load()
        if isinstance(stored, dict) and isinstance(stored.get("blueprints"), dict):
            self._state = stored

    async def async_fetch_and_evaluate(self) -> CoordinatorData:
        """Fetch the latest catalog and evaluate local files."""

        self.snapshot = await self.api.async_fetch_snapshot()
        data = await self.async_evaluate(self.snapshot)
        self._sync_issues(data)
        return data

    async def async_evaluate(self, snapshot: RemoteSnapshot) -> CoordinatorData:
        """Evaluate local files against a fetched snapshot."""

        managed = self._managed_state
        states: list[BlueprintState] = []
        update_ids: list[str] = []
        conflict_ids: list[str] = []
        changed_state = False

        for entry in snapshot.entries:
            if entry.status != "active":
                continue

            path = self._installed_path(entry)
            actual_hash = await self.hass.async_add_executor_job(self._hash_file, path)
            record = managed.get(entry.id)
            recorded_hash = record.get("hash") if isinstance(record, dict) else None
            recorded_path = record.get("path") if isinstance(record, dict) else None

            if actual_hash is None:
                status = STATUS_MISSING
                update_ids.append(entry.id)
            elif actual_hash == entry.sha256:
                status = STATUS_CURRENT
                if record is None:
                    await self.hass.async_add_executor_job(
                        self._backup_file, path, entry
                    )
                if recorded_hash != entry.sha256 or recorded_path != entry.path:
                    managed[entry.id] = {"hash": entry.sha256, "path": entry.path}
                    changed_state = True
            elif recorded_hash is not None and actual_hash == recorded_hash:
                status = STATUS_UPDATE_AVAILABLE
                update_ids.append(entry.id)
            else:
                status = STATUS_MODIFIED
                conflict_ids.append(entry.id)

            states.append(
                BlueprintState(
                    entry=entry,
                    installed_path=str(path),
                    status=status,
                )
            )

        if changed_state:
            await self._store.async_save(self._state)

        return CoordinatorData(
            snapshot=snapshot,
            blueprints=tuple(states),
            update_ids=tuple(update_ids),
            conflict_ids=tuple(conflict_ids),
        )

    async def async_install_initial(self, data: CoordinatorData) -> CoordinatorData:
        """Install missing blueprints during first setup and adopt exact matches."""

        managed = self._managed_state
        missing_ids = [
            state.entry.id
            for state in data.blueprints
            if state.status == STATUS_MISSING and state.entry.id not in managed
        ]
        legacy_import_ids: list[str] = []

        for state in data.blueprints:
            if state.entry.id in managed or state.status != STATUS_MODIFIED:
                continue
            is_managed_import = await self.hass.async_add_executor_job(
                self._is_matching_legacy_import,
                Path(state.installed_path),
                state.entry,
            )
            if is_managed_import:
                legacy_import_ids.append(state.entry.id)

        if missing_ids:
            await self._async_install_ids(data.snapshot, missing_ids)
        if legacy_import_ids:
            await self._async_install_ids(
                data.snapshot, legacy_import_ids, allow_modified=True
            )
        if not missing_ids and not legacy_import_ids:
            await self._store.async_save(self._state)

        evaluated = await self.async_evaluate(data.snapshot)
        self._sync_issues(evaluated)
        return evaluated

    async def async_install_updates(self, data: CoordinatorData) -> None:
        """Install every currently safe update from one catalog snapshot."""

        if not data.update_ids:
            return

        await self._async_install_ids(data.snapshot, list(data.update_ids))

    async def async_restore_blueprint(self, blueprint_id: str) -> None:
        """Explicitly replace a modified local file with the published version."""

        snapshot = self.snapshot or await self.api.async_fetch_snapshot()
        entry = next(
            (
                candidate
                for candidate in snapshot.entries
                if candidate.id == blueprint_id and candidate.status == "active"
            ),
            None,
        )
        if entry is None:
            raise HomeAssistantError(f"Blueprint {blueprint_id} is no longer active")

        await self._async_install_ids(snapshot, [blueprint_id], allow_modified=True)

    async def _async_install_ids(
        self,
        snapshot: RemoteSnapshot,
        blueprint_ids: list[str],
        *,
        allow_modified: bool = False,
    ) -> None:
        """Download, verify, and atomically install selected blueprints."""

        entries = {
            entry.id: entry for entry in snapshot.entries if entry.status == "active"
        }
        sources: dict[str, str] = {}

        for blueprint_id in blueprint_ids:
            entry = entries.get(blueprint_id)
            if entry is None:
                raise HomeAssistantError(f"Unknown active blueprint {blueprint_id}")
            sources[blueprint_id] = await self.api.async_fetch_blueprint(snapshot, entry)

        changed_domains: set[str] = set()
        for blueprint_id in blueprint_ids:
            entry = entries[blueprint_id]
            path = self._installed_path(entry)
            actual_hash = await self.hass.async_add_executor_job(self._hash_file, path)
            record = self._managed_state.get(blueprint_id)
            recorded_hash = record.get("hash") if isinstance(record, dict) else None

            if (
                not allow_modified
                and actual_hash is not None
                and actual_hash != entry.sha256
                and actual_hash != recorded_hash
            ):
                continue

            await self.hass.async_add_executor_job(
                self._write_blueprint,
                path,
                entry,
                sources[blueprint_id],
            )
            self._managed_state[blueprint_id] = {
                "hash": entry.sha256,
                "path": entry.path,
            }
            changed_domains.add(entry.domain)

        self._state["installed_revision"] = snapshot.revision
        await self._store.async_save(self._state)
        await self._async_reload_domains(changed_domains)

    @property
    def installed_revision(self) -> str | None:
        """Return the most recently installed remote revision."""

        value = self._state.get("installed_revision")
        return value if isinstance(value, str) else None

    @property
    def _managed_state(self) -> dict[str, dict[str, str]]:
        blueprints = self._state.setdefault("blueprints", {})
        return blueprints

    def _installed_path(self, entry: CatalogEntry) -> Path:
        relative_source = entry.path.removeprefix(f"blueprints/{entry.domain}/")
        relative_path = Path(relative_source)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise HomeAssistantError(f"Unsafe blueprint path: {entry.path}")

        return Path(
            self.hass.config.path(
                "blueprints", entry.domain, MANAGED_DIRECTORY, *relative_path.parts
            )
        )

    @staticmethod
    def _hash_file(path: Path) -> str | None:
        if not path.exists():
            return None
        return blueprint_hash(path.read_text(encoding="utf-8"))

    @staticmethod
    def _is_matching_legacy_import(path: Path, entry: CatalogEntry) -> bool:
        """Identify an unmanaged file imported from this repository by HA."""

        try:
            value = yaml_util.load_yaml_dict(path)
        except HomeAssistantError:
            return False

        blueprint = value.get("blueprint")
        if not isinstance(blueprint, dict):
            return False

        source_url = blueprint.get("source_url")
        expected_urls = {
            url
            for branch in RELEASE_CHANNEL_BRANCHES.values()
            for url in (
                f"{GITHUB_WEB_ROOT}/blob/{branch}/{entry.path}",
                f"{GITHUB_RAW_ROOT}/{branch}/{entry.path}",
            )
        }
        return source_url in expected_urls

    def _backup_file(self, path: Path, entry: CatalogEntry) -> None:
        if not path.exists():
            return

        backup_directory = Path(
            self.hass.config.path(
                "blueprints", ".hippos_toolbox_backups", entry.domain, entry.id
            )
        )
        backup_directory.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().astimezone().strftime("%Y%m%dT%H%M%S.%f%z")
        backup_path = backup_directory / f"{path.name}.{timestamp}.bak"
        shutil.copy2(path, backup_path)

        backups = sorted(
            backup_directory.glob(f"{path.name}.*.bak"),
            key=lambda candidate: candidate.name,
            reverse=True,
        )
        for expired in backups[BACKUP_COUNT:]:
            expired.unlink()

    def _write_blueprint(self, path: Path, entry: CatalogEntry, source: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._backup_file(path, entry)

        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as file:
                file.write(source)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary_name, path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    async def _async_reload_domains(self, domains: set[str]) -> None:
        for domain in sorted(domains):
            blueprint_manager = self.hass.data.get("blueprint", {}).get(domain)
            if blueprint_manager is not None:
                await blueprint_manager.async_reset_cache()

            if self.hass.services.has_service(domain, "reload"):
                await self.hass.services.async_call(domain, "reload", blocking=True)

    def _sync_issues(self, data: CoordinatorData) -> None:
        conflicts = set(data.conflict_ids)
        entries_by_id = {entry.id: entry for entry in data.snapshot.entries}

        for state in data.blueprints:
            issue_id = f"local_modified_{state.entry.id}"
            if state.entry.id not in conflicts:
                ir.async_delete_issue(self.hass, DOMAIN, issue_id)
                continue

            ir.async_create_issue(
                self.hass,
                DOMAIN,
                issue_id,
                is_fixable=True,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key="local_modified",
                translation_placeholders={
                    "blueprint_name": state.entry.name,
                    "path": state.installed_path,
                },
            )

        for blueprint_id, record in self._managed_state.items():
            entry = entries_by_id.get(blueprint_id)
            if entry is None or entry.status != "deprecated":
                continue

            message = entry.deprecated_message or "No replacement is currently available."
            if entry.replacement:
                replacement = entries_by_id[entry.replacement].name
                message = f"{message} Suggested replacement: {replacement}."

            ir.async_create_issue(
                self.hass,
                DOMAIN,
                f"deprecated_{blueprint_id}",
                is_fixable=False,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key="deprecated",
                translation_placeholders={
                    "blueprint_name": entry.name,
                    "message": message,
                    "path": str(self._installed_path(entry)),
                },
            )

        _LOGGER.debug(
            "Evaluated %d active blueprints: %d updates, %d conflicts",
            len(data.blueprints),
            len(data.update_ids),
            len(data.conflict_ids),
        )
