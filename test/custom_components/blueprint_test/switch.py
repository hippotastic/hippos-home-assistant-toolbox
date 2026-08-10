"""Deterministic switch entities for blueprint runtime tests."""

from typing import Any

import voluptuous as vol

from homeassistant.components.switch import PLATFORM_SCHEMA, SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback


PLATFORM_SCHEMA = PLATFORM_SCHEMA.extend({vol.Required("entities"): [str]})


async def async_setup_platform(
    hass: HomeAssistant,
    config: dict[str, Any],
    async_add_entities: AddEntitiesCallback,
    discovery_info: dict[str, Any] | None = None,
) -> None:
    """Set up configured fake switches."""

    async_add_entities(BlueprintTestSwitch(object_id) for object_id in config["entities"])


class BlueprintTestSwitch(SwitchEntity):
    """A switch with immediate state changes."""

    _attr_is_on = False
    _attr_should_poll = False

    def __init__(self, object_id: str) -> None:
        self.entity_id = f"switch.{object_id}"
        self._attr_name = object_id.replace("_", " ").title()
        self._attr_unique_id = object_id

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the switch on."""

        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn the switch off."""

        self._attr_is_on = False
        self.async_write_ha_state()
