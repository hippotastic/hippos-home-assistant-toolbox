"""Install the blueprints shipped with the toolbox."""

from pathlib import Path

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.util.file import write_utf8_file_atomic

from .catalog import load_catalog, read_blueprint
from .const import DOMAIN, MANAGED_DIRECTORY


async def async_sync_blueprints(hass: HomeAssistant) -> None:
    """Install missing or changed bundled blueprints at their usual paths."""
    entries = {
        entry.id: entry for entry in await hass.async_add_executor_job(load_catalog)
    }
    # Verify the entire bundle before changing any installed file.
    sources = {
        entry.id: await hass.async_add_executor_job(read_blueprint, entry)
        for entry in entries.values()
        if entry.status == "active"
    }

    changed_domains: set[str] = set()
    try:
        for entry in entries.values():
            relative_path = Path(entry.path).parts[2:]
            path = Path(
                hass.config.path("blueprints", entry.domain, MANAGED_DIRECTORY, *relative_path)
            )
            if entry.status == "active":
                if await hass.async_add_executor_job(
                    _install_blueprint, path, sources[entry.id]
                ):
                    changed_domains.add(entry.domain)
                continue

            if not await hass.async_add_executor_job(path.is_file):
                continue
            message = entry.deprecated_message or "No replacement is currently available."
            if entry.replacement:
                message += f" Suggested replacement: {entries[entry.replacement].name}."
            ir.async_create_issue(
                hass,
                DOMAIN,
                f"deprecated_{entry.id}",
                is_fixable=False,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key="deprecated",
                translation_placeholders={
                    "blueprint_name": entry.name,
                    "message": message,
                    "path": str(path),
                },
            )
    finally:
        # Apply successful writes even if another file could not be installed.
        for domain in sorted(changed_domains):
            if hass.services.has_service(domain, "reload"):
                await hass.services.async_call(domain, "reload", blocking=True)


def _install_blueprint(path: Path, source: str) -> bool:
    """Replace a missing or different file and report whether it changed."""
    content = source.encode("utf-8")
    try:
        if path.read_bytes() == content:
            return False
    except FileNotFoundError:
        pass

    path.parent.mkdir(parents=True, exist_ok=True)
    write_utf8_file_atomic(str(path), content, private=True, mode="wb")
    return True
