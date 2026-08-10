"""Shared entity properties for Hippo's Home Assistant Toolbox."""

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, NAME
from .coordinator import ToolboxCoordinator


class ToolboxEntity(CoordinatorEntity[ToolboxCoordinator]):
    """Base entity representing the managed blueprint collection."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: ToolboxCoordinator) -> None:
        """Initialize the entity."""

        super().__init__(coordinator)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, DOMAIN)},
            entry_type=DeviceEntryType.SERVICE,
            name=NAME,
            manufacturer="Hippo",
        )
