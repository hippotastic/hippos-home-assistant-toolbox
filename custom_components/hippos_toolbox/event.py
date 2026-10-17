"""Discoverable monitoring transitions for notification automations."""

from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, NAME, PROBLEM_CHANGES_UNIQUE_ID
from .monitoring import _ProblemMonitor


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    if entry.runtime_data.monitor is not None:
        async_add_entities(
            [ToolboxProblemEvent(entry.runtime_data.monitor)],
            config_subentry_id=next(iter(entry.runtime_data.monitoring_subentries)),
        )


class ToolboxProblemEvent(EventEntity):
    """Emit once for a newly confirmed problem or a confirmed solution."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "problem_changes"
    _attr_unique_id = PROBLEM_CHANGES_UNIQUE_ID
    _attr_event_types = ["triggered", "solved", "alarm_triggered", "alarm_solved"]
    _attr_icon = "mdi:bell-alert-outline"

    def __init__(self, monitor: _ProblemMonitor) -> None:
        self._monitor = monitor
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, DOMAIN)}, entry_type=DeviceEntryType.SERVICE,
            name=NAME, manufacturer="Hippo",
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._monitor.async_subscribe_events(self._async_problem_changed))

    @callback
    def _async_problem_changed(self, event_type: str, problem: dict[str, Any]) -> None:
        self._trigger_event(event_type, {"problem": problem})
        self.async_write_ha_state()
