"""Open problems maintained by the toolbox monitor."""

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import ALARMS_UNIQUE_ID, DOMAIN, MONITORING_SUBENTRY_TYPE, PROBLEMS_UNIQUE_ID
from .monitoring import _ProblemMonitor


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    if entry.runtime_data.monitor is not None:
        async_add_entities(
            [ToolboxProblemsSensor(entry.runtime_data.monitor), ToolboxAlarmsSensor(entry.runtime_data.monitor)],
            config_subentry_id=next(iter(entry.runtime_data.monitoring_subentries)),
        )


class ToolboxProblemsSensor(SensorEntity):
    """Expose confirmed open problems and the pending transition timestamps."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "problems"
    _attr_unique_id = PROBLEMS_UNIQUE_ID
    _attr_icon = "mdi:alert-circle-outline"
    _unrecorded_attributes = frozenset({"problems"})

    def __init__(self, monitor: _ProblemMonitor) -> None:
        self._monitor = monitor
        self._attr_device_info = DeviceInfo(
            # A device belongs to one subentry. Sharing the main toolbox device
            # moves it between owners and HA removes the other owner's entities.
            identifiers={(DOMAIN, MONITORING_SUBENTRY_TYPE)}, entry_type=DeviceEntryType.SERVICE,
            name="Problem monitoring", manufacturer="Hippo",
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._monitor.async_subscribe(self.async_write_ha_state))

    @property
    def native_value(self) -> int:
        return sum(problem["triggered_since"] is not None for problem in self._monitor.problems.values())

    @property
    def extra_state_attributes(self):
        return {"problems": self._monitor.problems}


class ToolboxAlarmsSensor(SensorEntity):
    """Expose immediate alarms without treating disconnection as recovery."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "alarms"
    _attr_unique_id = ALARMS_UNIQUE_ID
    _attr_icon = "mdi:alarm-light-outline"
    _unrecorded_attributes = frozenset({"alarms"})

    def __init__(self, monitor: _ProblemMonitor) -> None:
        self._monitor = monitor
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, MONITORING_SUBENTRY_TYPE)}, entry_type=DeviceEntryType.SERVICE,
            name="Problem monitoring", manufacturer="Hippo",
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._monitor.async_subscribe(self.async_write_ha_state))

    @property
    def native_value(self) -> int:
        return len(self._monitor.alarms)

    @property
    def extra_state_attributes(self):
        return {"alarms": self._monitor.alarms}
