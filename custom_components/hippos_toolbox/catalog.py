"""Read and verify the blueprint files shipped with the integration."""

import json
from pathlib import Path
import re
from typing import Any

from homeassistant.exceptions import HomeAssistantError

from .const import CATALOG_PATH, CATALOG_SCHEMA_VERSION, SUPPORTED_BLUEPRINT_DOMAINS
from .hashing import blueprint_hash
from .models import CatalogEntry

_PACKAGE_ROOT = Path(__file__).parent


def load_catalog() -> tuple[CatalogEntry, ...]:
    """Read the blueprint catalog from the installed integration."""
    return _parse_catalog((_PACKAGE_ROOT / CATALOG_PATH).read_text(encoding="utf-8"))


def read_blueprint(entry: CatalogEntry) -> str:
    """Read a bundled blueprint and verify it against the catalog."""
    source = (_PACKAGE_ROOT / entry.path).read_text(encoding="utf-8")
    actual_hash = blueprint_hash(source)
    if actual_hash != entry.sha256:
        raise HomeAssistantError(
            f"Hash mismatch for {entry.path}: expected {entry.sha256}, got {actual_hash}"
        )
    return source


def _required_string(value: dict[str, Any], key: str, entry_id: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise HomeAssistantError(f"Catalog entry {entry_id} has an invalid {key}")
    return result


def _parse_catalog(source: str) -> tuple[CatalogEntry, ...]:
    try:
        value = json.loads(source)
    except json.JSONDecodeError as err:
        raise HomeAssistantError("Blueprint catalog contains invalid JSON") from err

    if (
        not isinstance(value, dict)
        or value.get("schema_version") != CATALOG_SCHEMA_VERSION
        or not isinstance(value.get("blueprints"), list)
    ):
        raise HomeAssistantError("Blueprint catalog uses an unsupported schema")

    entries: list[CatalogEntry] = []
    ids: set[str] = set()
    paths: set[str] = set()

    for raw_entry in value["blueprints"]:
        if not isinstance(raw_entry, dict):
            raise HomeAssistantError("Blueprint catalog entry must be an object")

        entry_id = _required_string(raw_entry, "id", "unknown")
        domain = _required_string(raw_entry, "domain", entry_id)
        path = _required_string(raw_entry, "path", entry_id)
        status = _required_string(raw_entry, "status", entry_id)
        digest = _required_string(raw_entry, "sha256", entry_id)

        if not re.fullmatch(r"[a-z0-9_]+", entry_id) or entry_id in ids:
            raise HomeAssistantError(f"Catalog entry has an invalid or duplicate id: {entry_id}")
        if domain not in SUPPORTED_BLUEPRINT_DOMAINS:
            raise HomeAssistantError(f"Catalog entry {entry_id} has unsupported domain {domain}")
        if status not in ("active", "deprecated"):
            raise HomeAssistantError(f"Catalog entry {entry_id} has invalid status {status}")
        if (
            not path.startswith(f"blueprints/{domain}/")
            or not path.endswith((".yaml", ".yml"))
            or ".." in path.split("/")
            or path in paths
        ):
            raise HomeAssistantError(f"Catalog entry {entry_id} has an unsafe or duplicate path")
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise HomeAssistantError(f"Catalog entry {entry_id} has an invalid SHA-256 hash")

        deprecated_message = raw_entry.get("deprecated_message")
        replacement = raw_entry.get("replacement")
        if deprecated_message is not None and not isinstance(deprecated_message, str):
            raise HomeAssistantError(f"Catalog entry {entry_id} has an invalid deprecation message")
        if replacement is not None and not isinstance(replacement, str):
            raise HomeAssistantError(f"Catalog entry {entry_id} has an invalid replacement")

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
            raise HomeAssistantError(
                f"Deprecated blueprint {entry.id} references non-active replacement "
                f"{entry.replacement}"
            )

    return tuple(entries)
