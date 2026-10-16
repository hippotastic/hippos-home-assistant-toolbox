"""Hippo's Home Assistant Toolbox integration."""

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .announcements import async_setup_announcements
from .api import ToolboxApi
from .camera_stream import async_stop_camera_streams
from .const import (
    CONF_SOURCE_ENTITY_ID,
    CONF_CAMERA_STREAM_CLEANUP,
    CONF_UPDATE_CHANNEL,
    DEFAULT_UPDATE_CHANNEL,
    DOMAIN,
    PLATFORMS,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
    normalize_update_channel,
)
from .coordinator import ToolboxCoordinator
from .frontend import (
    async_setup_frontend,
    async_setup_entry_frontend,
    async_unload_frontend,
    async_update_frontend,
)
from .manager import BlueprintManager
from .progressive_camera import _ProgressiveCameraManager

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass(slots=True)
class ToolboxRuntimeData:
    """Runtime objects shared by the integration platforms."""

    manager: BlueprintManager
    coordinator: ToolboxCoordinator
    progressive_camera_manager: _ProgressiveCameraManager
    update_channel: str
    camera_subentries: dict[str, tuple[str, str]]


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

    camera_subentries = {
        subentry.subentry_id: (str(subentry.data[CONF_SOURCE_ENTITY_ID]), subentry.title)
        for subentry in entry.subentries.values()
        if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
    }
    progressive_camera_manager = _ProgressiveCameraManager(
        hass, entry,
        {subentry_id: source for subentry_id, (source, _) in camera_subentries.items()},
    )
    await progressive_camera_manager.async_start()
    entry.runtime_data = ToolboxRuntimeData(
        manager=manager,
        coordinator=coordinator,
        progressive_camera_manager=progressive_camera_manager,
        update_channel=update_channel,
        camera_subentries=camera_subentries,
    )
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    try:
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
        await async_setup_entry_frontend(hass, entry)
    except Exception:
        async_unload_frontend(hass)
        async_stop_camera_streams(hass)
        await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
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
        async_unload_frontend(hass)
        async_stop_camera_streams(hass)
        await entry.runtime_data.progressive_camera_manager.async_stop()
    return unloaded


async def _async_reload_entry(
    hass: HomeAssistant, entry: ToolboxConfigEntry
) -> None:
    """Apply frontend switches live; reload only for backend configuration changes."""

    async_update_frontend(hass, entry)
    if not entry.options.get(CONF_CAMERA_STREAM_CLEANUP, True):
        async_stop_camera_streams(hass)
    update_channel = normalize_update_channel(
        entry.options.get(CONF_UPDATE_CHANNEL, DEFAULT_UPDATE_CHANNEL)
    )
    camera_subentries = {
        subentry.subentry_id: (str(subentry.data[CONF_SOURCE_ENTITY_ID]), subentry.title)
        for subentry in entry.subentries.values()
        if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
    }
    if (
        update_channel != entry.runtime_data.update_channel
        or camera_subentries != entry.runtime_data.camera_subentries
    ):
        await hass.config_entries.async_reload(entry.entry_id)
