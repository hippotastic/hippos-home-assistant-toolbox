"""Manual catalog refresh button."""

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import CHECK_UPDATES_UNIQUE_ID
from .entity import ToolboxEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the manual refresh button."""

    async_add_entities([ToolboxCheckUpdatesButton(entry.runtime_data.coordinator)])


class ToolboxCheckUpdatesButton(ToolboxEntity, ButtonEntity):
    """Request an immediate catalog refresh."""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:refresh"
    _attr_translation_key = "check_for_updates"
    _attr_unique_id = CHECK_UPDATES_UNIQUE_ID

    @property
    def available(self) -> bool:
        """Remain available so a failed catalog request can be retried."""

        return True

    async def async_press(self) -> None:
        """Refresh the shared coordinator."""

        await self.coordinator.async_request_refresh()
