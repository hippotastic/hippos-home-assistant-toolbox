"""Deterministic cover entities for blueprint runtime tests."""

from typing import Any

import voluptuous as vol

from homeassistant.components.cover import (
    ATTR_POSITION,
    ATTR_TILT_POSITION,
    PLATFORM_SCHEMA,
    CoverEntity,
    CoverEntityFeature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback


PLATFORM_SCHEMA = PLATFORM_SCHEMA.extend(
    {
        vol.Required("entities"): [
            {
                vol.Required("id"): str,
                vol.Required("position"): vol.All(int, vol.Range(min=0, max=100)),
                vol.Required("supports_position"): bool,
                vol.Required("supports_tilt"): bool,
                vol.Required("tilt"): vol.All(int, vol.Range(min=0, max=100)),
            }
        ]
    }
)


async def async_setup_platform(
    hass: HomeAssistant,
    config: dict[str, Any],
    async_add_entities: AddEntitiesCallback,
    discovery_info: dict[str, Any] | None = None,
) -> None:
    """Set up configured fake covers."""

    async_add_entities(
        BlueprintTestCover(
            item["id"],
            item["position"],
            item["tilt"],
            item["supports_position"],
            item["supports_tilt"],
        )
        for item in config["entities"]
    )


class BlueprintTestCover(CoverEntity):
    """A cover that immediately applies requested position and tilt."""

    _attr_should_poll = False

    def __init__(
        self,
        object_id: str,
        position: int,
        tilt: int,
        supports_position: bool,
        supports_tilt: bool,
    ) -> None:
        self.entity_id = f"cover.{object_id}"
        self._attr_name = object_id.replace("_", " ").title()
        self._attr_unique_id = object_id
        self._attr_supported_features = 0
        if supports_position:
            self._attr_current_cover_position = position
            self._attr_supported_features |= CoverEntityFeature.SET_POSITION
        if supports_tilt:
            self._attr_current_cover_tilt_position = tilt
            self._attr_supported_features |= CoverEntityFeature.SET_TILT_POSITION

    @property
    def is_closed(self) -> bool:
        """Return whether the cover is closed."""

        return self.current_cover_position == 0

    async def async_set_cover_position(self, **kwargs: Any) -> None:
        """Apply a requested cover position."""

        self._attr_current_cover_position = int(kwargs[ATTR_POSITION])
        self.async_write_ha_state()

    async def async_set_cover_tilt_position(self, **kwargs: Any) -> None:
        """Apply a requested tilt position."""

        self._attr_current_cover_tilt_position = int(kwargs[ATTR_TILT_POSITION])
        self.async_write_ha_state()
