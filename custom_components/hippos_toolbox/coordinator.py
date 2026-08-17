"""Update coordinator for Hippo's Home Assistant Toolbox."""

import logging

from homeassistant.components.button import DOMAIN as BUTTON_DOMAIN
from homeassistant.components.logbook import async_log_entry
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import ToolboxApiError
from .const import (
    CONF_UPDATE_CHANNEL,
    CHECK_UPDATES_UNIQUE_ID,
    DEFAULT_UPDATE_CHANNEL,
    DEVELOPMENT_UPDATE_INTERVAL,
    DOMAIN,
    NAME,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_INTERVAL,
    normalize_update_channel,
)
from .manager import BlueprintManager
from .models import CoordinatorData

_LOGGER = logging.getLogger(__name__)


class ToolboxCoordinator(DataUpdateCoordinator[CoordinatorData]):
    """Coordinate catalog checks for all toolbox entities."""

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry: ConfigEntry,
        manager: BlueprintManager,
    ) -> None:
        """Initialize the coordinator."""

        update_channel = normalize_update_channel(
            config_entry.options.get(CONF_UPDATE_CHANNEL, DEFAULT_UPDATE_CHANNEL)
        )
        update_interval = (
            DEVELOPMENT_UPDATE_INTERVAL
            if update_channel == UPDATE_CHANNEL_DEVELOPMENT
            else UPDATE_INTERVAL
        )

        super().__init__(
            hass,
            _LOGGER,
            config_entry=config_entry,
            name=NAME,
            update_interval=update_interval,
            always_update=False,
        )
        self.manager = manager

    async def _async_setup(self) -> None:
        """Load persistent manager state before the first request."""

        await self.manager.async_load()

    async def _async_update_data(self) -> CoordinatorData:
        """Fetch and evaluate the published catalog."""

        try:
            return await self.manager.async_fetch_and_evaluate()
        except ToolboxApiError as err:
            # Associate the entry with the retry button so it is included in
            # both the device Activity panel and entity-filtered Logbook views.
            entity_id = er.async_get(self.hass).async_get_entity_id(
                BUTTON_DOMAIN,
                DOMAIN,
                CHECK_UPDATES_UNIQUE_ID,
            )
            async_log_entry(
                self.hass,
                name="Check for updates",
                message="failed. See the system log for details.",
                entity_id=entity_id,
            )
            raise UpdateFailed(str(err)) from err
