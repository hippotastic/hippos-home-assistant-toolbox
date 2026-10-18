"""Recipient routing, templates, isolated delivery and monitoring lifecycle."""

import asyncio
from copy import deepcopy
from datetime import timedelta
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.components.mobile_app import device_action as mobile_app_action
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.group import GenericGroup, get_group_entities
from homeassistant.util import dt as dt_util

from custom_components.hippos_toolbox import monitoring_notifications
import custom_components.hippos_toolbox as toolbox
from custom_components.hippos_toolbox.const import (
    CONF_ALARM_NOTIFICATIONS, CONF_WARNING_NOTIFICATIONS,
    MONITORING_NOTIFICATION_DEFAULTS,
)
from custom_components.hippos_toolbox.monitoring import _Observation, _ProblemMonitor
from custom_components.hippos_toolbox.monitoring_notifications import _MonitoringNotifications


class MonitoringNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)
        self.options = deepcopy(MONITORING_NOTIFICATION_DEFAULTS)
        self.entry = SimpleNamespace(
            async_create_background_task=lambda hass, coroutine, name, **kwargs: asyncio.create_task(coroutine, name=name),
        )
        self.subentry = SimpleNamespace(data=self.options, subentry_id="fixture_monitor")
        self.monitor = SimpleNamespace(async_subscribe_events=Mock(return_value=Mock()))
        self.notifications = _MonitoringNotifications(self.hass, self.entry, self.subentry, self.monitor)
        self.emit = self.monitor.async_subscribe_events.call_args.args[0]
        self.problem = {
            "entity_id": "binary_sensor.fixture_problem", "name": "Fixture sensor",
            "reason": "problem", "triggered_since": "2026-01-01T12:00:00+00:00",
            "trigger_delay_since": None, "solved_delay_since": None,
        }
        self.attempts = []
        self.delivered = []
        self.failures = set()
        self.gates = {}
        self.started = {}
        self.hass.services.async_register("notify", "send_message", self._receive)
        for entity_id in ("notify.fixture_a", "notify.fixture_b", "notify.fixture_c"):
            self.hass.states.async_set(entity_id, "unknown", {"supported_features": 1})

    async def asyncTearDown(self):
        await self.notifications.async_stop()
        for gate in self.gates.values():
            gate.set()
        await self.hass.async_block_till_done()
        self.directory.cleanup()

    async def _receive(self, call):
        entity_id = call.data["entity_id"]
        self.attempts.append(dict(call.data))
        self.started.setdefault(entity_id, asyncio.Event()).set()
        if entity_id in self.gates:
            await self.gates[entity_id].wait()
        if entity_id in self.failures:
            raise HomeAssistantError("fixture delivery failed")
        self.delivered.append(dict(call.data))

    async def _drain(self):
        if self.notifications._tasks:
            await asyncio.gather(*tuple(self.notifications._tasks))

    async def test_existing_monitors_without_recipients_do_not_start_delivery(self):
        self.options.clear()
        for event_type in ("triggered", "solved", "alarm_triggered", "alarm_solved"):
            self.emit(event_type, self.problem)
        self.assertEqual(self.notifications._tasks, set())
        self.assertEqual(self.attempts, [])

    async def test_warning_alarm_and_all_clear_routing_uses_separate_recipients(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a"]
        self.options[CONF_ALARM_NOTIFICATIONS]["recipients"] = ["notify.fixture_b"]
        for event_type in ("triggered", "solved", "alarm_triggered", "alarm_solved"):
            self.emit(event_type, self.problem)
        await self._drain()
        self.assertEqual([(call["entity_id"], call["title"]) for call in self.delivered], [
            ("notify.fixture_a", "Warning"), ("notify.fixture_a", "Problem resolved"),
            ("notify.fixture_b", "Alarm"), ("notify.fixture_b", "Alarm ended"),
        ])
        self.assertEqual([call["message"] for call in self.delivered], [
            "Fixture sensor: problem detected.", "Fixture sensor: problem resolved.",
            "Fixture sensor: alarm detected.", "Fixture sensor: alarm ended.",
        ])

    async def test_warning_defaults_describe_each_reason(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a"]
        for reason in ("unavailable", "battery_critical", "below_threshold"):
            self.emit("triggered", {**self.problem, "reason": reason})
        await self._drain()
        self.assertEqual([call["message"] for call in self.delivered], [
            "Fixture sensor: unavailable.", "Fixture sensor: critical battery.",
            "Fixture sensor: below the configured threshold.",
        ])

    async def test_nested_native_groups_are_expanded_and_overlapping_recipients_deduplicated(self):
        groups = get_group_entities(self.hass)
        for entity_id, members in (
            ("notify.fixture_group_a", ["notify.fixture_a", "notify.fixture_b"]),
            ("notify.fixture_group_b", ["notify.fixture_group_a", "notify.fixture_c"]),
        ):
            entity = SimpleNamespace(entity_id=entity_id)
            entity.group = GenericGroup(entity, members)
            groups[entity_id] = entity
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = [
            "notify.fixture_a", "notify.fixture_group_a", "notify.fixture_group_b",
        ]
        self.emit("triggered", self.problem)
        await self._drain()
        self.assertEqual([call["entity_id"] for call in self.delivered], ["notify.fixture_a", "notify.fixture_b", "notify.fixture_c"])

        # Group edits are resolved at the next event without reconfiguring the monitor
        groups["notify.fixture_group_a"].group = GenericGroup(groups["notify.fixture_group_a"], ["notify.fixture_c"])
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_group_a"]
        self.emit("solved", self.problem)
        await self._drain()
        self.assertEqual(self.delivered[-1]["entity_id"], "notify.fixture_c")
        self.assertEqual(len(self.delivered), 4)

    async def test_cyclic_group_does_not_prevent_other_recipients(self):
        groups = get_group_entities(self.hass)
        for entity_id, member in (("notify.fixture_cycle_a", "notify.fixture_cycle_b"), ("notify.fixture_cycle_b", "notify.fixture_cycle_a")):
            entity = SimpleNamespace(entity_id=entity_id)
            entity.group = GenericGroup(entity, [member])
            groups[entity_id] = entity
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_cycle_a", "notify.fixture_b"]
        with self.assertLogs(monitoring_notifications._LOGGER, level="WARNING"):
            self.emit("triggered", self.problem)
        await self._drain()
        self.assertEqual([call["entity_id"] for call in self.delivered], ["notify.fixture_b"])

    async def test_delivery_failure_missing_and_unavailable_targets_do_not_block_others(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = [
            "notify.fixture_a", "notify.fixture_b", "notify.fixture_c", "notify.fixture_missing",
        ]
        self.failures.add("notify.fixture_a")
        self.hass.states.async_set("notify.fixture_c", "unavailable")
        with self.assertLogs(monitoring_notifications._LOGGER, level="WARNING") as logs:
            self.emit("triggered", self.problem)
            await self._drain()
        self.assertEqual([call["entity_id"] for call in self.delivered], ["notify.fixture_b"])
        self.assertEqual(len(logs.output), 3)

    async def test_timeout_is_per_recipient_and_does_not_delay_other_recipients(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a", "notify.fixture_b"]
        self.gates["notify.fixture_a"] = asyncio.Event()
        self.started["notify.fixture_b"] = asyncio.Event()
        with patch.object(monitoring_notifications, "_SEND_TIMEOUT", 0.05), self.assertLogs(monitoring_notifications._LOGGER, level="ERROR"):
            self.emit("triggered", self.problem)
            await asyncio.wait_for(self.started["notify.fixture_b"].wait(), 1)
            self.assertEqual([call["entity_id"] for call in self.delivered], ["notify.fixture_b"])
            await self._drain()

    async def test_recipient_ordering_does_not_hold_up_another_recipients_all_clear(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a", "notify.fixture_b"]
        self.gates["notify.fixture_a"] = asyncio.Event()
        self.started["notify.fixture_b"] = asyncio.Event()
        self.emit("triggered", self.problem)
        await asyncio.wait_for(self.started["notify.fixture_b"].wait(), 1)
        self.emit("solved", self.problem)
        # Wait for B's queued notification while A's first delivery remains blocked
        await asyncio.gather(*[task for task in self.notifications._tasks if task.get_name() == "monitor notification notify.fixture_b"])
        self.assertEqual([call["title"] for call in self.delivered], ["Warning", "Problem resolved"])
        self.gates["notify.fixture_a"].set()
        await self._drain()
        self.assertEqual([call["title"] for call in self.delivered if call["entity_id"] == "notify.fixture_a"], ["Warning", "Problem resolved"])

    async def test_custom_templates_use_event_snapshot_and_remain_local(self):
        settings = self.options[CONF_WARNING_NOTIFICATIONS]
        settings.update({
            "recipients": ["notify.fixture_a"],
            "title": "{{ 'Resolved' if resolved else 'Check' }}: {{ problem.name | replace('Fixture', 'Example') }}",
            "message": "{{ event_type }} / {{ problem.entity_id }} / {{ problem.reason }} / {{ states('sensor.fixture_value') }}",
        })
        saved = deepcopy(settings)
        self.hass.states.async_set("sensor.fixture_value", "12")
        self.emit("solved", self.problem)
        self.problem["name"] = "Changed after event"
        await self._drain()
        self.assertEqual(self.delivered[0]["title"], "Resolved: Example sensor")
        self.assertEqual(self.delivered[0]["message"], "solved / binary_sensor.fixture_problem / problem / 12")
        self.assertEqual(settings, saved)

    async def test_runtime_template_errors_and_empty_messages_use_default_text(self):
        settings = self.options[CONF_WARNING_NOTIFICATIONS]
        settings.update({"recipients": ["notify.fixture_a"], "title": "{{ missing.attribute }}", "message": "{{ 1 / 0 }}"})
        with self.assertLogs(monitoring_notifications._LOGGER, level="WARNING"):
            self.emit("triggered", self.problem)
        await self._drain()
        self.assertEqual(self.delivered[0]["title"], "Warning")
        self.assertEqual(self.delivered[0]["message"], "Fixture sensor: problem detected.")
        settings.update({"title": "", "message": "{{ '' }}"})
        with self.assertLogs(monitoring_notifications._LOGGER, level="WARNING"):
            self.emit("solved", self.problem)
        await self._drain()
        self.assertNotIn("title", self.delivered[1])
        self.assertEqual(self.delivered[1]["message"], "Fixture sensor: problem resolved.")

    async def test_targets_without_title_support_receive_the_message(self):
        self.options[CONF_ALARM_NOTIFICATIONS]["recipients"] = ["notify.fixture_a"]
        self.hass.states.async_set("notify.fixture_a", "unknown", {"supported_features": 0})
        self.emit("alarm_triggered", self.problem)
        await self._drain()
        self.assertNotIn("title", self.delivered[0])
        self.assertEqual(self.delivered[0]["message"], "Fixture sensor: alarm detected.")

    async def test_companion_data_uses_native_action_and_preserves_critical_and_recovery_payloads(self):
        settings = self.options[CONF_ALARM_NOTIFICATIONS]
        settings.update({
            "recipients": ["notify.fixture_a"],
            "title": "{{ 'Ended' if resolved else 'Alarm {{ literal }}' }}",
            "message": "{{ problem.name }} / {{ event_type }}",
            "data": (
                "{{ {'url': '/lovelace/alerts', 'entity_id': problem.entity_id} if resolved else "
                "{'url': '/lovelace/alerts', 'push': {'sound': {'name': 'default', 'critical': 1, 'volume': 1}}} }}"
            ),
        })
        registry = SimpleNamespace(async_get=Mock(return_value=SimpleNamespace(platform="mobile_app", device_id="fixture_device")))
        calls = []
        async def receive(call):
            calls.append(dict(call.data))
        self.hass.services.async_register("notify", "fixture_mobile", receive)
        with (
            patch.object(monitoring_notifications.er, "async_get", return_value=registry),
            patch.object(monitoring_notifications, "async_get_device_automation_platform", new_callable=AsyncMock, return_value=mobile_app_action),
            patch.object(mobile_app_action, "webhook_id_from_device_id", return_value="fixture_webhook") as resolve,
            patch.object(mobile_app_action, "get_notify_service", return_value="fixture_mobile"),
        ):
            self.emit("alarm_triggered", self.problem)
            self.emit("alarm_solved", self.problem)
            await self._drain()
        self.assertEqual([call.args[1] for call in resolve.call_args_list], ["fixture_device", "fixture_device"])
        self.assertEqual(calls, [
            {"target": "fixture_webhook", "title": "Alarm {{ literal }}", "message": "Fixture sensor / alarm_triggered",
             "data": {"url": "/lovelace/alerts", "push": {"sound": {"name": "default", "critical": 1, "volume": 1}}}},
            {"target": "fixture_webhook", "title": "Ended", "message": "Fixture sensor / alarm_solved",
             "data": {"url": "/lovelace/alerts", "entity_id": "binary_sensor.fixture_problem"}},
        ])
        self.assertEqual(self.attempts, [])

    async def test_invalid_data_does_not_silently_fall_back_to_ordinary_delivery(self):
        settings = self.options[CONF_ALARM_NOTIFICATIONS]
        settings["recipients"] = ["notify.fixture_a"]
        for template in ("{{ missing.attribute }}", "{{ 1 / 0 }}", "{{ [] }}", "{{ none }}", "{{ 12 }}", "plain text"):
            with self.subTest(template=template), self.assertLogs(monitoring_notifications._LOGGER, level="ERROR"):
                settings["data"] = template
                self.emit("alarm_triggered", self.problem)
                await self._drain()
            self.assertEqual(self.attempts, [])
        for template in ("", "  ", "{{ {} }}"):
            settings["data"] = template
            self.emit("alarm_solved", self.problem)
            await self._drain()
        self.assertEqual(len(self.delivered), 3)

    async def test_companion_failures_and_unsupported_targets_do_not_block_other_phones(self):
        self.options[CONF_ALARM_NOTIFICATIONS].update({
            "recipients": ["notify.fixture_a", "notify.fixture_b", "notify.fixture_c", "notify.fixture_unregistered", "notify.fixture_no_device"],
            "data": "{{ {'url': '/lovelace/alerts'} }}",
        })
        for entity_id in ("notify.fixture_unregistered", "notify.fixture_no_device"):
            self.hass.states.async_set(entity_id, "unknown")
        registrations = {
            "notify.fixture_a": SimpleNamespace(platform="mobile_app", device_id="fixture_device_a"),
            "notify.fixture_b": SimpleNamespace(platform="mobile_app", device_id="fixture_device_b"),
            "notify.fixture_c": SimpleNamespace(platform="other", device_id="fixture_device_c"),
            "notify.fixture_no_device": SimpleNamespace(platform="mobile_app", device_id=None),
        }
        delivered = []
        async def send(hass, config, variables, context):
            if config["device_id"] == "fixture_device_a":
                config["data"]["url"] = "/fixture-mutated"
                raise HomeAssistantError("fixture phone failed")
            delivered.append(config)
        platform = SimpleNamespace(async_call_action_from_config=AsyncMock(side_effect=send))
        with (
            patch.object(monitoring_notifications.er, "async_get", return_value=SimpleNamespace(async_get=registrations.get)),
            patch.object(monitoring_notifications, "async_get_device_automation_platform", new_callable=AsyncMock, return_value=platform),
            self.assertLogs(monitoring_notifications._LOGGER, level="ERROR") as logs,
        ):
            self.emit("alarm_triggered", self.problem)
            await self._drain()
        self.assertEqual(len(logs.output), 4)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0]["device_id"], "fixture_device_b")
        self.assertEqual(delivered[0]["data"], {"url": "/lovelace/alerts"})
        self.assertEqual(self.attempts, [])

    async def test_companion_timeout_keeps_other_phone_independent_and_all_clears_ordered(self):
        self.options[CONF_ALARM_NOTIFICATIONS].update({
            "recipients": ["notify.fixture_a", "notify.fixture_b"],
            "data": "{{ {'url': '/lovelace/alerts', 'resolved': resolved} }}",
        })
        registrations = {f"notify.fixture_{name}": SimpleNamespace(platform="mobile_app", device_id=f"fixture_device_{name}") for name in ("a", "b")}
        gate = asyncio.Event()
        finished_b = asyncio.Event()
        delivered = []
        async def send(hass, config, variables, context):
            if config["device_id"] == "fixture_device_a":
                await gate.wait()
            delivered.append(config)
            if config["title"] == "Alarm ended":
                finished_b.set()
        platform = SimpleNamespace(async_call_action_from_config=AsyncMock(side_effect=send))
        with (
            patch.object(monitoring_notifications.er, "async_get", return_value=SimpleNamespace(async_get=registrations.get)),
            patch.object(monitoring_notifications, "async_get_device_automation_platform", new_callable=AsyncMock, return_value=platform),
            patch.object(monitoring_notifications, "_SEND_TIMEOUT", 0.05),
            self.assertLogs(monitoring_notifications._LOGGER, level="ERROR"),
        ):
            self.emit("alarm_triggered", self.problem)
            self.emit("alarm_solved", self.problem)
            await asyncio.wait_for(finished_b.wait(), 1)
            self.assertEqual([config["title"] for config in delivered], ["Alarm", "Alarm ended"])
            await self._drain()
        self.assertEqual([config["data"]["resolved"] for config in delivered], [False, True])
        self.assertEqual(self.attempts, [])

    async def test_native_groups_expand_before_companion_delivery_and_device_resolution_is_fresh(self):
        groups = get_group_entities(self.hass)
        group = SimpleNamespace(entity_id="notify.fixture_group")
        group.group = GenericGroup(group, ["notify.fixture_a", "notify.fixture_b"])
        groups[group.entity_id] = group
        self.options[CONF_WARNING_NOTIFICATIONS].update({
            "recipients": ["notify.fixture_group", "notify.fixture_a"],
            "data": "{{ {'url': '/lovelace/alerts'} }}",
        })
        registrations = {f"notify.fixture_{name}": SimpleNamespace(platform="mobile_app", device_id=f"fixture_device_{name}") for name in ("a", "b")}
        platform = SimpleNamespace(async_call_action_from_config=AsyncMock())
        with (
            patch.object(monitoring_notifications.er, "async_get", return_value=SimpleNamespace(async_get=registrations.get)),
            patch.object(monitoring_notifications, "async_get_device_automation_platform", new_callable=AsyncMock, return_value=platform),
        ):
            self.emit("triggered", self.problem)
            await self._drain()
            registrations["notify.fixture_a"].device_id = "fixture_replacement_device"
            self.emit("solved", self.problem)
            await self._drain()
        self.assertEqual([call.args[1]["device_id"] for call in platform.async_call_action_from_config.call_args_list], [
            "fixture_device_a", "fixture_device_b", "fixture_replacement_device", "fixture_device_b",
        ])

    async def test_stop_unsubscribes_and_cancels_queued_delivery(self):
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a"]
        self.gates["notify.fixture_a"] = asyncio.Event()
        self.started["notify.fixture_a"] = asyncio.Event()
        self.emit("triggered", self.problem)
        await asyncio.wait_for(self.started["notify.fixture_a"].wait(), 1)
        self.emit("solved", self.problem)
        await self.notifications.async_stop()
        self.monitor.async_subscribe_events.return_value.assert_called_once_with()
        self.emit("triggered", self.problem)
        self.gates["notify.fixture_a"].set()
        await self.hass.async_block_till_done()
        self.assertEqual(len(self.attempts), 1)
        self.assertEqual(self.notifications._tasks, set())

    async def test_only_persisted_monitor_transitions_start_delivery(self):
        await self.notifications.async_stop()
        self.options[CONF_WARNING_NOTIFICATIONS]["recipients"] = ["notify.fixture_a"]
        with patch("custom_components.hippos_toolbox.monitoring.er.async_get", return_value=SimpleNamespace()):
            monitor = _ProblemMonitor(self.hass, self.entry, self.subentry)
        monitor._store = SimpleNamespace(async_save=AsyncMock(side_effect=OSError("fixture write failed")))
        self.notifications = _MonitoringNotifications(self.hass, self.entry, self.subentry, monitor)
        observation = _Observation(True, "Fixture sensor", "problem", timedelta(0))
        with self.assertRaises(OSError):
            await monitor._async_observe(self.problem["entity_id"], observation, dt_util.utcnow())
        self.assertEqual(self.notifications._tasks, set())
        monitor._store.async_save.side_effect = None
        with patch.object(monitor, "_async_schedule_deadline"):
            await monitor._async_observe(self.problem["entity_id"], observation, dt_util.utcnow())
        await self._drain()
        self.assertEqual(len(self.delivered), 1)
        await monitor.async_stop()


class MonitoringNotificationLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_integration_subscribes_before_monitor_start_and_stops_notifications_on_unload_or_failure(self):
        for mode in ("enabled", "disabled", "start_failure"):
            with self.subTest(mode=mode):
                monitor = SimpleNamespace(async_load=AsyncMock(), async_start=Mock(), async_stop=AsyncMock())
                notifier = SimpleNamespace(async_stop=AsyncMock())
                cameras = SimpleNamespace(async_start=AsyncMock(), async_stop=AsyncMock())
                manager = SimpleNamespace(async_install_initial=AsyncMock(return_value={}))
                coordinator = SimpleNamespace(
                    async_config_entry_first_refresh=AsyncMock(), async_set_updated_data=Mock(), data={},
                )
                subentry = SimpleNamespace(subentry_type="monitoring", subentry_id="fixture_monitor", data={})
                entry = SimpleNamespace(
                    options={}, subentries={} if mode == "disabled" else {"fixture_monitor": subentry},
                    add_update_listener=Mock(), async_on_unload=Mock(),
                )
                hass = SimpleNamespace(config_entries=SimpleNamespace(
                    async_forward_entry_setups=AsyncMock(), async_unload_platforms=AsyncMock(return_value=True),
                ))
                def start():
                    self.assertIs(entry.runtime_data.monitor_notifications, notifier)
                    if mode == "start_failure":
                        raise HomeAssistantError("fixture start failed")
                monitor.async_start.side_effect = start
                with (
                    patch.object(toolbox, "async_get_clientsession"),
                    patch.object(toolbox, "ToolboxApi"),
                    patch.object(toolbox, "BlueprintManager", return_value=manager),
                    patch.object(toolbox, "ToolboxCoordinator", return_value=coordinator),
                    patch.object(toolbox, "_ProgressiveCameraManager", return_value=cameras),
                    patch.object(toolbox, "_ProblemMonitor", return_value=monitor),
                    patch.object(toolbox, "_MonitoringNotifications", return_value=notifier) as constructor,
                    patch.object(toolbox, "async_setup_entry_frontend", new_callable=AsyncMock),
                    patch.object(toolbox, "async_unload_frontend"),
                    patch.object(toolbox, "async_stop_camera_streams"),
                ):
                    if mode == "start_failure":
                        with self.assertRaises(HomeAssistantError):
                            await toolbox.async_setup_entry(hass, entry)
                    else:
                        self.assertTrue(await toolbox.async_setup_entry(hass, entry))
                        self.assertTrue(await toolbox.async_unload_entry(hass, entry))
                    if mode == "disabled":
                        constructor.assert_not_called()
                        monitor.async_stop.assert_not_awaited()
                        notifier.async_stop.assert_not_awaited()
                    else:
                        constructor.assert_called_once_with(hass, entry, subentry, monitor)
                        monitor.async_start.assert_called_once_with()
                        monitor.async_stop.assert_awaited_once_with()
                        notifier.async_stop.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
