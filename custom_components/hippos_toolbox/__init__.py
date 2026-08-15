"""Hippo's Home Assistant Toolbox integration."""

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import ToolboxApi
from .const import (
    CONF_UPDATE_CHANNEL,
    DEFAULT_UPDATE_CHANNEL,
    PLATFORMS,
    normalize_update_channel,
)
from .coordinator import ToolboxCoordinator
from .manager import BlueprintManager


@dataclass(slots=True)
class ToolboxRuntimeData:
    """Runtime objects shared by the integration platforms."""

    manager: BlueprintManager
    coordinator: ToolboxCoordinator


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

    entry.runtime_data = ToolboxRuntimeData(manager=manager, coordinator=coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
) -> bool:
    """Unload the toolbox entities."""

    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
