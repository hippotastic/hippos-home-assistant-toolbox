"""Local monitoring notification templates and isolated delivery to notify entities."""

import asyncio
from copy import deepcopy
import logging
from typing import Any

from homeassistant.components.device_automation import DeviceAutomationType, async_get_device_automation_platform
from homeassistant.components.notify import NotifyEntityFeature
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, TemplateError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.group import expand_entity_ids
from homeassistant.helpers.template import Template

from .const import (
    CONF_ALARM_NOTIFICATIONS,
    CONF_WARNING_NOTIFICATIONS,
    MONITORING_NOTIFICATION_DEFAULTS,
)
from .monitoring import _ProblemMonitor

_LOGGER = logging.getLogger(__name__)
_SEND_TIMEOUT = 15.0


class _MonitoringNotifications:
    """Subscribe to persisted transitions without blocking monitoring on delivery."""

    def __init__(self, hass: HomeAssistant, entry, subentry, monitor: _ProblemMonitor) -> None:
        self._hass = hass
        self._entry = entry
        self._options = subentry.data
        self._tasks: set[asyncio.Task] = set()
        self._target_locks: dict[str, asyncio.Lock] = {}
        self._stopped = False
        self._unsubscribe = monitor.async_subscribe_events(self._async_problem_changed)

    @callback
    def _async_problem_changed(self, event_type: str, problem: dict[str, Any]) -> None:
        if self._stopped:
            return
        channel = CONF_ALARM_NOTIFICATIONS if event_type.startswith("alarm_") else CONF_WARNING_NOTIFICATIONS
        settings = self._options.get(channel, {})
        if not settings.get("recipients"):
            return
        variables = {
            "problem": deepcopy(problem),
            "event_type": event_type,
            "resolved": event_type in {"solved", "alarm_solved"},
        }
        rendered = {}
        for field in ("title", "message"):
            default = MONITORING_NOTIFICATION_DEFAULTS[channel][field]
            try:
                rendered[field] = Template(settings.get(field, default), self._hass).async_render(
                    variables, parse_result=False, strict=True,
                ).strip()
                if field == "message" and not rendered[field]:
                    raise ValueError("empty notification message")
            except (TemplateError, ValueError):
                _LOGGER.warning("Invalid monitoring %s %s template; using the default", channel, field)
                rendered[field] = Template(default, self._hass).async_render(variables, parse_result=False).strip()

        try:
            data_template = settings.get("data", MONITORING_NOTIFICATION_DEFAULTS[channel]["data"])
            notification_data = Template(data_template, self._hass).async_render(variables, strict=True) if data_template.strip() else {}
            if not isinstance(notification_data, dict):
                raise ValueError("notification data must be a mapping")
        except (TemplateError, ValueError):
            # Empty fallback data could silently downgrade a critical alarm to an ordinary push.
            _LOGGER.error("Invalid monitoring %s data template; notification not sent", channel)
            return

        # Use HA's native group expansion and deduplicate across overlapping groups.
        recipients: set[str] = set()
        for selected in settings["recipients"]:
            try:
                recipients.update(entity_id for entity_id in expand_entity_ids(self._hass, [selected]) if entity_id.startswith("notify."))
            except RecursionError:
                _LOGGER.warning("Cannot expand cyclic monitoring notification group %s", selected)
        for entity_id in sorted(recipients):
            task = self._entry.async_create_background_task(
                self._hass,
                self._async_send(entity_id, rendered["title"], rendered["message"], notification_data),
                f"monitor notification {entity_id}", eager_start=False,
            )
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _async_send(self, entity_id: str, title: str, message: str, notification_data: dict[str, Any]) -> None:
        # Preserve onset/all-clear order per recipient; another recipient never waits.
        async with self._target_locks.setdefault(entity_id, asyncio.Lock()):
            if self._stopped:
                return
            try:
                state = self._hass.states.get(entity_id)
                if state is None or state.state == "unavailable":
                    _LOGGER.warning("Monitoring notification target %s is unavailable", entity_id)
                    return
                async with asyncio.timeout(_SEND_TIMEOUT):
                    if notification_data:
                        registration = er.async_get(self._hass).async_get(entity_id)
                        if registration is None or registration.platform != "mobile_app" or registration.device_id is None:
                            raise HomeAssistantError("Additional notification data requires a Companion app notification target")
                        platform = await async_get_device_automation_platform(self._hass, "mobile_app", DeviceAutomationType.ACTION)
                        action = {
                            "domain": "mobile_app", "device_id": registration.device_id,
                            "type": "notify", "message": message, "data": deepcopy(notification_data),
                        }
                        if title:
                            action["title"] = title
                        # HA resolves the current phone service; already rendered strings remain literal.
                        await platform.async_call_action_from_config(self._hass, action, {}, None)
                    else:
                        data = {"entity_id": entity_id, "message": message}
                        if title and state.attributes.get("supported_features", 0) & NotifyEntityFeature.TITLE:
                            data["title"] = title
                        await self._hass.services.async_call("notify", "send_message", data, blocking=True)
            except Exception:
                # Provider failures and timeouts are isolated to this one recipient.
                _LOGGER.exception("Could not send monitoring notification to %s", entity_id)

    async def async_stop(self) -> None:
        self._stopped = True
        self._unsubscribe()
        # Reloads must not leave queued deliveries using the previous configuration.
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._target_locks.clear()
