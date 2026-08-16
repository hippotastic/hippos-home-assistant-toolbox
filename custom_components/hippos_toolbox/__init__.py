"""Hippo's Home Assistant Toolbox integration."""

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import ToolboxApi
from .const import (
    CONF_SOURCE_ENTITY_ID,
    CONF_UPDATE_CHANNEL,
    DEFAULT_UPDATE_CHANNEL,
    PLATFORMS,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
    normalize_update_channel,
)
from .coordinator import ToolboxCoordinator
from .manager import BlueprintManager
from .progressive_camera import _ProgressiveCameraManager


@dataclass(slots=True)
class ToolboxRuntimeData:
    """Runtime objects shared by the integration platforms."""

    manager: BlueprintManager
    coordinator: ToolboxCoordinator
    progressive_camera_manager: _ProgressiveCameraManager


type ToolboxConfigEntry = ConfigEntry[ToolboxRuntimeData]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
) -> bool:
    """Set up the toolbox and install missing blueprints."""

    update_channel = normalize_update_channel(
        entry.options.get(CONF_UPDATE_CHANNEL, DEFAULT_UPDATE_CHANNEL)
    )

    api = ToolboxApi(async_get_clientsession(hass), update_channel)
    manager = BlueprintManager(hass, api)
    coordinator = ToolboxCoordinator(hass, entry, manager)
    await coordinator.async_config_entry_first_refresh()
    coordinator.async_set_updated_data(
        await manager.async_install_initial(coordinator.data)
    )

    progressive_camera_manager = _ProgressiveCameraManager(
        hass,
        entry,
        {
            subentry.subentry_id: str(subentry.data[CONF_SOURCE_ENTITY_ID])
            for subentry in entry.subentries.values()
            if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
        },
    )
    await progressive_camera_manager.async_start()
    entry.runtime_data = ToolboxRuntimeData(
        manager=manager,
        coordinator=coordinator,
        progressive_camera_manager=progressive_camera_manager,
    )
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except Exception:
        await progressive_camera_manager.async_stop()
        raise
    return True


async def async_unload_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
) -> bool:
    """Unload the toolbox entities."""

    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.progressive_camera_manager.async_stop()
    return unloaded


async def _async_reload_entry(
    hass: HomeAssistant, entry: ToolboxConfigEntry
) -> None:
    """Reload after options or camera subentries change."""

    await hass.config_entries.async_reload(entry.entry_id)
