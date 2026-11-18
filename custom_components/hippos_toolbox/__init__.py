"""Hippo's Home Assistant Toolbox integration."""

from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .announcements import async_setup_announcements
from .camera_stream import async_stop_camera_streams
from .const import (
    CONF_SOURCE_ENTITY_ID,
    CONF_CAMERA_STREAM_CLEANUP,
    DOMAIN,
    MONITORING_SUBENTRY_TYPE,
    PLATFORMS,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)
from .frontend import (
    async_setup_frontend,
    async_setup_entry_frontend,
    async_unload_frontend,
    async_update_frontend,
)
from .manager import BlueprintManager
from .monitoring import _ProblemMonitor
from .monitoring_notifications import _MonitoringNotifications
from .progressive_camera import _ProgressiveCameraManager

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass(slots=True)
class ToolboxRuntimeData:
    """Runtime objects shared by the integration platforms."""

    manager: BlueprintManager
    progressive_camera_manager: _ProgressiveCameraManager
    camera_subentries: dict[str, tuple[str, dict[str, Any]]]
    monitor: _ProblemMonitor | None
    monitor_notifications: _MonitoringNotifications | None
    monitoring_subentries: dict[str, dict]


type ToolboxConfigEntry = ConfigEntry[ToolboxRuntimeData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register actions independently of config-entry reloads."""

    await async_setup_announcements(hass)
    async_setup_frontend(hass)
    return True


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
) -> bool:
    """Set up the toolbox with its bundled blueprints."""

    manager = BlueprintManager(hass)
    await manager.async_setup()

    camera_subentries = {
        subentry.subentry_id: (subentry.title, dict(subentry.data))
        for subentry in entry.subentries.values()
        if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
    }
    progressive_camera_manager = _ProgressiveCameraManager(
        hass, entry,
        {
            subentry_id: str(data[CONF_SOURCE_ENTITY_ID])
            for subentry_id, (_, data) in camera_subentries.items()
        },
    )
    monitoring_subentries = {
        item.subentry_id: dict(item.data) for item in entry.subentries.values()
        if item.subentry_type == MONITORING_SUBENTRY_TYPE
    }
    monitoring_subentry = next((
        item for item in entry.subentries.values()
        if item.subentry_type == MONITORING_SUBENTRY_TYPE
    ), None)
    monitor = _ProblemMonitor(hass, entry, monitoring_subentry) if monitoring_subentry else None
    if monitor is not None:
        await monitor.async_load()
    await progressive_camera_manager.async_start()
    entry.runtime_data = ToolboxRuntimeData(
        manager=manager,
        progressive_camera_manager=progressive_camera_manager,
        camera_subentries=camera_subentries,
        monitor=monitor,
        monitor_notifications=None,
        monitoring_subentries=monitoring_subentries,
    )
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        await async_setup_entry_frontend(hass, entry)
        if monitor is not None:
            entry.runtime_data.monitor_notifications = _MonitoringNotifications(hass, entry, monitoring_subentry, monitor)
            monitor.async_start()
    except Exception:
        async_unload_frontend(hass)
        async_stop_camera_streams(hass)
        await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
        await progressive_camera_manager.async_stop()
        if monitor is not None:
            await monitor.async_stop()
        if entry.runtime_data.monitor_notifications is not None:
            await entry.runtime_data.monitor_notifications.async_stop()
        raise
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: ToolboxConfigEntry) -> bool:
    """Remove the retired blueprint updater from existing config entries."""

    if entry.version != 1:
        return False
    if entry.minor_version >= 2:
        return True

    registry = er.async_get(hass)
    for platform, unique_id in (
        (Platform.BUTTON, f"{DOMAIN}_check_for_updates"),
        (Platform.UPDATE, f"{DOMAIN}_blueprints"),
    ):
        entity_id = registry.async_get_entity_id(platform, DOMAIN, unique_id)
        if entity_id is not None:
            registered = registry.async_get(entity_id)
            if registered is not None and registered.config_entry_id == entry.entry_id:
                registry.async_remove(entity_id)

    options = dict(entry.options)
    options.pop("update_channel", None)
    hass.config_entries.async_update_entry(entry, options=options, minor_version=2)
    return True


async def async_unload_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
) -> bool:
    """Unload the toolbox entities."""

    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        async_unload_frontend(hass)
        async_stop_camera_streams(hass)
        await entry.runtime_data.progressive_camera_manager.async_stop()
        if entry.runtime_data.monitor is not None:
            await entry.runtime_data.monitor.async_stop()
        if entry.runtime_data.monitor_notifications is not None:
            await entry.runtime_data.monitor_notifications.async_stop()
    return unloaded


async def _async_reload_entry(
    hass: HomeAssistant, entry: ToolboxConfigEntry
) -> None:
    """Apply frontend switches live; reload only for backend configuration changes."""

    async_update_frontend(hass, entry)
    if not entry.options.get(CONF_CAMERA_STREAM_CLEANUP, True):
        async_stop_camera_streams(hass)
    camera_subentries = {
        subentry.subentry_id: (subentry.title, dict(subentry.data))
        for subentry in entry.subentries.values()
        if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
    }
    monitoring_subentries = {
        item.subentry_id: dict(item.data) for item in entry.subentries.values()
        if item.subentry_type == MONITORING_SUBENTRY_TYPE
    }
    if (
        camera_subentries != entry.runtime_data.camera_subentries
        or monitoring_subentries != entry.runtime_data.monitoring_subentries
    ):
        await hass.config_entries.async_reload(entry.entry_id)
