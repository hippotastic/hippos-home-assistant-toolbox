"""Manage blueprint files and installation state."""

from __future__ import annotations

from datetime import datetime
import logging
import os
from pathlib import Path
import re
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
    ADOPTABLE_BLUEPRINT_DIRECTORIES,
    BACKUP_COUNT,
    DOMAIN,
    DEVELOPMENT_BRANCH,
    GITHUB_RAW_ROOT,
    GITHUB_WEB_ROOT,
    MANAGED_DIRECTORY,
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

_USE_BLUEPRINT_PATTERN = re.compile(
    r"^(?P<indent> *)(?:-\s+)?use_blueprint\s*:\s*(?:#.*)?$"
)
_BLUEPRINT_PATH_PATTERN = re.compile(
    r"^(?P<prefix>\s*path\s*:\s*)"
    r"(?:(?P<single>'[^']*')|(?P<double>\"[^\"]*\")|(?P<plain>[^#\s]+))"
    r"(?P<suffix>\s*(?:#.*)?)$"
)


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

            canonical_path = self._installed_path(entry)
            path = canonical_path
            actual_hash = await self.hass.async_add_executor_job(self._hash_file, path)
            record = managed.get(entry.id)
            recorded_hash = record.get("hash") if isinstance(record, dict) else None
            recorded_path = record.get("path") if isinstance(record, dict) else None
            legacy_conflict = False

            if actual_hash is None and record is None:
                adoptable_path = await self.hass.async_add_executor_job(
                    self._find_adoptable_path, entry
                )
                if adoptable_path is not None:
                    path = adoptable_path
                    actual_hash = await self.hass.async_add_executor_job(
                        self._hash_file, path
                    )
            elif actual_hash is not None and record is not None:
                adoptable_path = await self.hass.async_add_executor_job(
                    self._find_adoptable_path, entry
                )
                if adoptable_path is not None:
                    adoptable_hash = await self.hass.async_add_executor_job(
                        self._hash_file, adoptable_path
                    )
                    if adoptable_hash != actual_hash:
                        path = adoptable_path
                        actual_hash = adoptable_hash
                        legacy_conflict = True

            if legacy_conflict:
                status = STATUS_MODIFIED
                conflict_ids.append(entry.id)
            elif actual_hash is None:
                status = STATUS_MISSING
                update_ids.append(entry.id)
            elif actual_hash == entry.sha256:
                status = STATUS_CURRENT
                if record is None and path == canonical_path:
                    await self.hass.async_add_executor_job(
                        self._backup_file, path, entry
                    )
                if path == canonical_path and (
                    recorded_hash != entry.sha256 or recorded_path != entry.path
                ):
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
        adopted_paths: dict[str, Path] = {}
        legacy_import_ids: list[str] = []

        for state in data.blueprints:
            if state.entry.id in managed:
                continue

            state_path = Path(state.installed_path)
            if state_path in self._adoptable_paths(state.entry):
                if state.status == STATUS_CURRENT:
                    adopted_paths[state.entry.id] = state_path
                    continue

                if state.status == STATUS_MODIFIED:
                    is_managed_import = await self.hass.async_add_executor_job(
                        self._is_matching_legacy_import,
                        state_path,
                        state.entry,
                    )
                    if is_managed_import:
                        adopted_paths[state.entry.id] = state_path
                continue

            if state.status != STATUS_MODIFIED:
                continue

            is_managed_import = await self.hass.async_add_executor_job(
                self._is_matching_legacy_import,
                state_path,
                state.entry,
            )
            if is_managed_import:
                legacy_import_ids.append(state.entry.id)

        initial_install_ids = [*missing_ids, *adopted_paths]
        if initial_install_ids:
            await self._async_install_ids(
                data.snapshot,
                initial_install_ids,
                adopted_paths=adopted_paths,
            )
        if legacy_import_ids:
            await self._async_install_ids(
                data.snapshot, legacy_import_ids, allow_modified=True
            )
        if not initial_install_ids and not legacy_import_ids:
            await self._store.async_save(self._state)

        evaluated = await self.async_evaluate(data.snapshot)
        self._sync_issues(evaluated)
        return evaluated

    async def async_install_updates(self, data: CoordinatorData) -> None:
        """Install every currently safe update from one catalog snapshot."""

        if not data.update_ids:
            return

        await self._async_install_ids(data.snapshot, list(data.update_ids))

    async def async_restore_blueprint(self, blueprint_id: str) -> bool:
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

        adoptable_path = await self.hass.async_add_executor_job(
            self._find_adoptable_path, entry
        )
        adopted_paths = (
            {blueprint_id: adoptable_path} if adoptable_path is not None else None
        )
        await self._async_install_ids(
            snapshot,
            [blueprint_id],
            allow_modified=True,
            adopted_paths=adopted_paths,
        )

        evaluated = await self.async_evaluate(snapshot)
        restored_state = next(
            state for state in evaluated.blueprints if state.entry.id == blueprint_id
        )
        return restored_state.status == STATUS_CURRENT

    async def _async_install_ids(
        self,
        snapshot: RemoteSnapshot,
        blueprint_ids: list[str],
        *,
        allow_modified: bool = False,
        adopted_paths: dict[str, Path] | None = None,
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
            if adopted_path := (adopted_paths or {}).get(blueprint_id):
                migration_complete = await self.hass.async_add_executor_job(
                    self._migrate_adopted_blueprint,
                    adopted_path,
                    path,
                    entry,
                )
                if migration_complete:
                    await self._async_remove_blueprint_consumers(
                        entry.domain,
                        self._blueprint_reference(adopted_path, entry),
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
        relative_path = self._relative_source_path(entry)

        return Path(
            self.hass.config.path(
                "blueprints", entry.domain, MANAGED_DIRECTORY, *relative_path.parts
            )
        )

    def _adoptable_paths(self, entry: CatalogEntry) -> tuple[Path, ...]:
        relative_path = self._relative_source_path(entry)
        return tuple(
            Path(
                self.hass.config.path(
                    "blueprints", entry.domain, directory, *relative_path.parts
                )
            )
            for directory in ADOPTABLE_BLUEPRINT_DIRECTORIES
        )

    def _find_adoptable_path(self, entry: CatalogEntry) -> Path | None:
        return next(
            (path for path in self._adoptable_paths(entry) if path.exists()), None
        )

    @staticmethod
    def _relative_source_path(entry: CatalogEntry) -> Path:
        prefix = f"blueprints/{entry.domain}/"
        if not entry.path.startswith(prefix):
            raise HomeAssistantError(f"Unsafe blueprint path: {entry.path}")

        relative_path = Path(entry.path.removeprefix(prefix))
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise HomeAssistantError(f"Unsafe blueprint path: {entry.path}")
        return relative_path

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
            f"{GITHUB_WEB_ROOT}/blob/{DEVELOPMENT_BRANCH}/{entry.path}",
            f"{GITHUB_RAW_ROOT}/{DEVELOPMENT_BRANCH}/{entry.path}",
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

    def _migrate_adopted_blueprint(
        self,
        adopted_path: Path,
        installed_path: Path,
        entry: CatalogEntry,
    ) -> bool:
        """Move references to the managed path without breaking unknown consumers."""

        old_reference = self._blueprint_reference(adopted_path, entry)
        new_reference = self._blueprint_reference(installed_path, entry)

        all_references_migrated = self._migrate_blueprint_references(
            old_reference, new_reference
        )
        self._backup_file(adopted_path, entry)
        if all_references_migrated:
            adopted_path.unlink()
        else:
            _LOGGER.warning(
                "Kept adopted blueprint %s because at least one reference to %s "
                "could not be migrated safely",
                adopted_path,
                old_reference,
            )
        return all_references_migrated

    def _blueprint_reference(self, path: Path, entry: CatalogEntry) -> str:
        domain_root = Path(self.hass.config.path("blueprints", entry.domain))
        return path.relative_to(domain_root).as_posix()

    def _migrate_blueprint_references(
        self, old_reference: str, new_reference: str
    ) -> bool:
        """Rewrite block-style blueprint references in YAML configuration files."""

        config_root = Path(self.hass.config.path())
        all_references_migrated = True

        for path in self._configuration_yaml_files(config_root):
            try:
                source = path.read_text(encoding="utf-8")
            except OSError:
                all_references_migrated = False
                _LOGGER.warning("Could not inspect %s during blueprint adoption", path)
                continue

            migrated = self._replace_blueprint_reference(
                source, old_reference, new_reference
            )
            if migrated != source:
                try:
                    self._backup_configuration_file(path, config_root)
                    self._write_text_atomic(path, migrated)
                except OSError:
                    all_references_migrated = False
                    _LOGGER.exception(
                        "Could not migrate blueprint references in %s", path
                    )
                    continue

            if old_reference in migrated:
                all_references_migrated = False

        return all_references_migrated

    @staticmethod
    def _configuration_yaml_files(config_root: Path) -> list[Path]:
        paths: list[Path] = []
        for root, directories, files in os.walk(config_root):
            root_path = Path(root)
            if root_path == config_root:
                directories[:] = [
                    directory
                    for directory in directories
                    if directory not in {".storage", "blueprints"}
                ]

            paths.extend(
                root_path / filename
                for filename in files
                if Path(filename).suffix.lower() in {".yaml", ".yml"}
                and not (root_path / filename).is_symlink()
            )
        return sorted(paths)

    @staticmethod
    def _replace_blueprint_reference(
        source: str, old_reference: str, new_reference: str
    ) -> str:
        lines = source.splitlines(keepends=True)
        use_blueprint_indent: int | None = None

        for index, line in enumerate(lines):
            content = line.rstrip("\r\n")
            stripped = content.lstrip()
            indentation = len(content) - len(stripped)

            if use_blueprint_indent is not None:
                if (
                    stripped
                    and not stripped.startswith("#")
                    and indentation <= use_blueprint_indent
                ):
                    use_blueprint_indent = None
                elif indentation > use_blueprint_indent:
                    path_match = _BLUEPRINT_PATH_PATTERN.fullmatch(content)
                    if path_match is not None:
                        value_group = next(
                            group
                            for group in ("single", "double", "plain")
                            if path_match.group(group) is not None
                        )
                        value = path_match.group(value_group)
                        unquoted_value = (
                            value[1:-1]
                            if value_group in {"single", "double"}
                            else value
                        )
                        if unquoted_value == old_reference:
                            replacement = (
                                f"{value[0]}{new_reference}{value[-1]}"
                                if value_group in {"single", "double"}
                                else new_reference
                            )
                            newline = line[len(content) :]
                            lines[index] = (
                                f"{path_match.group('prefix')}{replacement}"
                                f"{path_match.group('suffix')}{newline}"
                            )

            use_blueprint_match = _USE_BLUEPRINT_PATTERN.fullmatch(content)
            if use_blueprint_match is not None:
                use_blueprint_indent = len(use_blueprint_match.group("indent"))

        return "".join(lines)

    def _backup_configuration_file(self, path: Path, config_root: Path) -> None:
        relative_path = path.relative_to(config_root)
        backup_directory = Path(
            self.hass.config.path(
                "blueprints",
                ".hippos_toolbox_backups",
                "configuration",
                *relative_path.parent.parts,
            )
        )
        backup_directory.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().astimezone().strftime("%Y%m%dT%H%M%S.%f%z")
        shutil.copy2(path, backup_directory / f"{path.name}.{timestamp}.bak")

        backups = sorted(
            backup_directory.glob(f"{path.name}.*.bak"),
            key=lambda candidate: candidate.name,
            reverse=True,
        )
        for expired in backups[BACKUP_COUNT:]:
            expired.unlink()

    @staticmethod
    def _write_text_atomic(path: Path, source: str) -> None:
        mode = path.stat().st_mode
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as file:
                file.write(source)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary_name, mode)
            os.replace(temporary_name, path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise

    async def _async_reload_domains(self, domains: set[str]) -> None:
        for domain in sorted(domains):
            if self.hass.services.has_service(domain, "reload"):
                await self.hass.services.async_call(domain, "reload", blocking=True)

    async def _async_remove_blueprint_consumers(
        self, domain: str, blueprint_reference: str
    ) -> None:
        """Force HA to recreate consumers whose path changed but content did not."""

        component = self.hass.data.get(domain)
        if component is None or not hasattr(component, "async_remove_entity"):
            return

        entity_ids = [
            entity.entity_id
            for entity in component.entities
            if getattr(entity, "referenced_blueprint", None) == blueprint_reference
        ]
        for entity_id in entity_ids:
            await component.async_remove_entity(entity_id)

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
