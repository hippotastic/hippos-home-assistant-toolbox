"""Problem lifecycles, warning rules and alarm availability regressions."""

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, UTC
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.core import CoreState, Event, HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant import loader
from homeassistant.config_entries import ConfigEntry, ConfigEntries
from homeassistant.helpers import device_registry as dr

from custom_components.hippos_toolbox import monitoring
from custom_components.hippos_toolbox.const import (
    CONF_ALARM_LABELS, CONF_ALARM_UNAVAILABLE_DELAY, CONF_BATTERY_CRITICAL_DELAY,
    CONF_BELOW_10_LABELS, CONF_BELOW_20_LABELS, CONF_BELOW_30_LABELS,
    CONF_IGNORED_LABELS, CONF_SOLVED_DELAY, CONF_TRIGGER_DELAY, CONF_WARNING_LABELS,
    CONF_MONITOR_PROBLEM_SENSORS, CONF_MONITOR_CRITICAL_BATTERIES,
)
from custom_components.hippos_toolbox.monitoring import _ProblemMonitor


class _Entry:
    def async_create_background_task(self, _hass, coroutine, name, eager_start=True):
        return asyncio.create_task(coroutine, name=name)


class ProblemMonitorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)
        self.registrations = {}
        self.registry = SimpleNamespace(entities=self.registrations, async_get=self.registrations.get)
        self.registry_patch = patch.object(monitoring.er, "async_get", return_value=self.registry)
        self.registry_patch.start()
        self.clock = datetime(2026, 10, 17, 12, tzinfo=UTC)
        self.clock_patch = patch.object(monitoring.dt_util, "utcnow", side_effect=lambda: self.clock)
        self.clock_patch.start()
        self.timer_patch = patch.object(monitoring, "async_track_point_in_utc_time", return_value=Mock())
        self.timer = self.timer_patch.start()
        self.options = {
            CONF_TRIGGER_DELAY: 1, CONF_SOLVED_DELAY: 10,
            CONF_ALARM_UNAVAILABLE_DELAY: 5, CONF_BATTERY_CRITICAL_DELAY: 30,
            CONF_ALARM_LABELS: ["alarms"], CONF_WARNING_LABELS: ["warnings"],
            CONF_IGNORED_LABELS: ["ignored"], CONF_BELOW_30_LABELS: ["below30"],
            CONF_BELOW_20_LABELS: ["below20"], CONF_BELOW_10_LABELS: ["below10"],
        }
        self.subentry = SimpleNamespace(data=self.options, subentry_id="monitor")
        self.monitor = _ProblemMonitor(self.hass, _Entry(), self.subentry)
        self.monitor._store = SimpleNamespace(async_save=AsyncMock(), async_load=AsyncMock(return_value=None))
        self.events = []
        self.monitor.async_subscribe_events(lambda kind, problem: self.events.append((kind, deepcopy(problem))))

    async def asyncTearDown(self) -> None:
        await self.monitor.async_stop()
        self.registry_patch.stop()
        self.clock_patch.stop()
        self.timer_patch.stop()
        self.directory.cleanup()

    def source(self, entity_id="binary_sensor.problem", value="on", *, labels=(), attributes=None):
        attrs = {"device_class": "problem", "friendly_name": "Test problem"} if attributes is None else attributes
        self.registrations[entity_id] = SimpleNamespace(
            entity_id=entity_id, labels=set(labels), disabled_by=None, platform="test",
            device_class=None, original_device_class=attrs.get("device_class"),
        )
        self.hass.states.async_set(entity_id, value, attrs)
        return self.hass.states.get(entity_id)

    async def observe(self, seconds, value="on", *, entity_id="binary_sensor.problem", labels=(), attributes=None):
        self.clock = datetime(2026, 10, 17, 12, tzinfo=UTC) + timedelta(seconds=seconds)
        state = self.source(entity_id, value, labels=labels, attributes=attributes)
        await self.monitor._async_observe(entity_id, self.monitor._classify(entity_id, state), self.clock)

    async def test_minute_delay_then_single_trigger_with_exclusive_timestamps(self):
        await self.observe(0)
        pending = self.monitor.problems["binary_sensor.problem"]
        self.assertEqual(pending["trigger_delay_since"], self.clock.isoformat())
        self.assertIsNone(pending["triggered_since"])
        await self.observe(59)
        self.assertEqual(self.events, [])
        await self.observe(60)
        await self.observe(180)
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])
        triggered = self.monitor.problems["binary_sensor.problem"]
        self.assertIsNone(triggered["trigger_delay_since"])
        self.assertIsNotNone(triggered["triggered_since"])
        self.assertIsNone(triggered["solved_delay_since"])

    async def test_short_problem_is_removed_without_warning_or_all_clear(self):
        await self.observe(0)
        await self.observe(30, "off")
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual(self.events, [])

    async def test_automatic_problem_and_battery_rules_are_independently_configurable(self):
        for problems, batteries in ((False, True), (True, False), (False, False), (True, True)):
            with self.subTest(problems=problems, batteries=batteries):
                self.options[CONF_MONITOR_PROBLEM_SENSORS] = problems
                self.options[CONF_MONITOR_CRITICAL_BATTERIES] = batteries
                problem = self.source()
                battery = self.source("sensor.fixture_battery", "5", attributes={"battery_state": "critical"})
                for state, enabled, reason in ((problem, problems, "problem"), (battery, batteries, "battery_critical")):
                    observation = self.monitor._classify(state.entity_id, state)
                    if enabled:
                        self.assertTrue(observation.active)
                        self.assertEqual(observation.reason, reason)
                    else:
                        self.assertIsNone(observation)

    async def test_label_rules_remain_active_with_both_automatic_rules_disabled(self):
        self.options[CONF_MONITOR_PROBLEM_SENSORS] = False
        self.options[CONF_MONITOR_CRITICAL_BATTERIES] = False

        await self.observe(0, labels=("warnings",))
        await self.observe(60, labels=("warnings",))
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

        await self.observe(60, "5", entity_id="sensor.fixture_battery", labels=("below20",), attributes={"battery_state": "critical"})
        await self.observe(120, "5", entity_id="sensor.fixture_battery", labels=("below20",), attributes={"battery_state": "critical"})
        self.assertEqual(self.events[-1][1]["reason"], "below_threshold")
        self.assertEqual(len(self.events), 2)

        await self.observe(120, entity_id="binary_sensor.fixture_alarm", labels=("alarms",))
        self.assertEqual(self.events[-1][0], "alarm_triggered")
        self.assertEqual(len(self.events), 3)

    async def test_disabling_an_automatic_rule_removes_its_problem_without_all_clear(self):
        for option, entity_id, active, attributes in (
            (CONF_MONITOR_PROBLEM_SENSORS, "binary_sensor.fixture_problem", "on", {"device_class": "problem"}),
            (CONF_MONITOR_CRITICAL_BATTERIES, "sensor.fixture_battery", "5", {"battery_state": "critical"}),
        ):
            for confirmed in (False, True):
                for value in (active, "unknown", "unavailable", None):
                    with self.subTest(option=option, confirmed=confirmed, value=value):
                        self.monitor._problems.clear()
                        self.events.clear()
                        self.options[option] = True
                        await self.observe(0, active, entity_id=entity_id, attributes=attributes)
                        if confirmed:
                            await self.observe(1800, active, entity_id=entity_id, attributes=attributes)
                        self.assertIn(entity_id, self.monitor.problems)

                        self.options[option] = False
                        state = None if value is None else self.source(entity_id, value, attributes=attributes)
                        await self.monitor._async_observe(entity_id, self.monitor._classify(entity_id, state), self.clock)
                        self.assertNotIn(entity_id, self.monitor.problems)
                        self.assertEqual([kind for kind, _ in self.events], ["triggered"] if confirmed else [])

    async def test_returning_unreported_problem_gets_a_new_full_minute(self):
        await self.observe(0)
        await self.observe(30, "off")
        await self.observe(40)
        await self.observe(99)
        self.assertEqual(self.events, [])
        await self.observe(100)
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_two_one_two_does_not_retrigger_or_send_early_all_clear(self):
        await self.observe(0)
        await self.observe(60)
        triggered = self.monitor.problems["binary_sensor.problem"]["triggered_since"]
        await self.observe(90, "off")
        await self.observe(120)
        self.assertEqual(len(self.events), 1)
        problem = self.monitor.problems["binary_sensor.problem"]
        self.assertEqual(problem["triggered_since"], triggered)
        self.assertIsNone(problem["trigger_delay_since"])
        self.assertIsNone(problem["solved_delay_since"])

    async def test_solution_requires_ten_minutes_and_emits_once(self):
        await self.observe(0)
        await self.observe(60)
        await self.observe(90, "off")
        await self.observe(689, "off")
        self.assertEqual(len(self.events), 1)
        await self.observe(690, "off")
        await self.observe(720, "off")
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual([kind for kind, _ in self.events], ["triggered", "solved"])
        await self.observe(750)
        await self.observe(810)
        self.assertEqual([kind for kind, _ in self.events], ["triggered", "solved", "triggered"])

    async def test_solution_display_deadline_follows_the_configured_delay(self):
        self.options[CONF_SOLVED_DELAY] = 2.5
        await self.observe(0)
        self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["solved_delay_until"])
        await self.observe(60)
        await self.observe(90, "off")
        self.assertEqual(
            self.monitor.problems["binary_sensor.problem"]["solved_delay_until"],
            (self.clock + timedelta(minutes=2.5)).isoformat(),
        )

        await self.observe(100)
        self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["solved_delay_until"])
        await self.observe(110, "off")
        await self.observe(120, "unavailable")
        self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["solved_delay_until"])
        await self.observe(130, "off")
        await self.observe(279, "off")
        self.assertIn("binary_sensor.problem", self.monitor.problems)
        await self.observe(280, "off")
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual([kind for kind, _ in self.events], ["triggered", "solved"])

    async def test_individual_solution_while_another_problem_remains(self):
        for entity_id in ("binary_sensor.a", "binary_sensor.b"):
            await self.observe(0, entity_id=entity_id)
            await self.observe(60, entity_id=entity_id)
        await self.observe(90, "off", entity_id="binary_sensor.a")
        await self.observe(690, "off", entity_id="binary_sensor.a")
        self.assertEqual(set(self.monitor.problems), {"binary_sensor.b"})
        self.assertEqual(self.events[-1][0], "solved")
        self.assertEqual(self.events[-1][1]["entity_id"], "binary_sensor.a")

    async def test_unknown_and_unavailable_are_not_generic_solutions(self):
        for unknown in ("unknown", "unavailable"):
            with self.subTest(unknown=unknown):
                self.monitor._problems.clear()
                self.events.clear()
                await self.observe(0)
                await self.observe(60)
                await self.observe(90, "off")
                await self.observe(689, unknown)
                self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["solved_delay_since"])
                await self.observe(700, "off")
                await self.observe(1299, "off")
                self.assertEqual(len(self.events), 1)
                await self.observe(1300, "off")
                self.assertEqual(self.events[-1][0], "solved")

    async def test_unavailable_source_retains_problem_until_evaluation_resumes(self):
        source = "binary_sensor.fixture_problem"
        await self.observe(0, entity_id=source)
        await self.observe(60, entity_id=source)
        await self.observe(100, "unavailable", entity_id=source)
        await self.observe(10000, "unavailable", entity_id=source)
        await self.observe(10001, entity_id=source)
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_alarm_unavailable_uses_five_minutes_total(self):
        for second, state in ((0, "unavailable"), (299, "unavailable")):
            await self.observe(second, state, labels=("alarms",), attributes={"device_class": "smoke"})
        self.assertEqual(self.events, [])
        await self.observe(300, "unavailable", labels=("alarms",), attributes={"device_class": "smoke"})
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0][1]["reason"], "unavailable")
        await self.observe(360, "unavailable", labels=("alarms",), attributes={"device_class": "smoke"})
        self.assertEqual(len(self.events), 1)

    async def test_short_alarm_disconnect_is_silent_and_return_restarts_delay(self):
        await self.observe(0, "unavailable", labels=("alarms",))
        await self.observe(299, "off", labels=("alarms",))
        self.assertEqual(self.monitor.problems, {})
        await self.observe(300, "unavailable", labels=("alarms",))
        await self.observe(599, "unavailable", labels=("alarms",))
        self.assertEqual(self.events, [])
        await self.observe(600, "unavailable", labels=("alarms",))
        self.assertEqual(len(self.events), 1)

    async def test_alarm_on_is_not_an_ordinary_warning_and_reconnection_clears_late(self):
        await self.observe(0, "on", labels=("alarms",))
        await self.observe(300, "on", labels=("alarms",))
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered"])
        self.assertEqual(self.monitor.problems, {})
        await self.observe(400, "unavailable", labels=("alarms",))
        await self.observe(700, "unavailable", labels=("alarms",))
        await self.observe(800, "on", labels=("alarms",))
        await self.observe(1399, "on", labels=("alarms",))
        self.assertEqual(len(self.events), 2)
        await self.observe(1400, "on", labels=("alarms",))
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered", "triggered", "solved"])

    async def test_actual_alarms_trigger_and_clear_individually_without_warning_delays(self):
        for entity_id in ("binary_sensor.smoke_a", "binary_sensor.smoke_b"):
            await self.observe(0, entity_id=entity_id, labels=("alarms", "ignored"))
        self.assertEqual(len(self.monitor.alarms), 2)
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered", "alarm_triggered"])
        await self.observe(1, "off", entity_id="binary_sensor.smoke_a", labels=("alarms",))
        self.assertEqual(set(self.monitor.alarms), {"binary_sensor.smoke_b"})
        self.assertEqual(self.events[-1][0], "alarm_solved")
        self.assertEqual(self.events[-1][1]["entity_id"], "binary_sensor.smoke_a")
        await self.observe(2, entity_id="binary_sensor.smoke_a", labels=("alarms",))
        self.assertEqual(self.events[-1][0], "alarm_triggered")

    async def test_alarm_unknown_unavailable_and_missing_do_not_clear_or_retrigger(self):
        await self.observe(0, labels=("alarms",))
        for second, state in ((1, "unknown"), (2, "unavailable"), (3, "on")):
            await self.observe(second, state, labels=("alarms",))
        missing = self.monitor._classify("binary_sensor.problem", None)
        await self.monitor._async_observe("binary_sensor.problem", missing, self.clock)
        self.assertEqual(len(self.monitor.alarms), 1)
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered"])
        await self.observe(4, "off", labels=("alarms",))
        self.assertEqual(self.monitor.alarms, {})
        self.assertEqual(self.events[-1][0], "alarm_solved")

    async def test_alarm_label_removal_is_silent_and_other_domains_are_supported(self):
        entity_id = "switch.alarm"
        await self.observe(0, entity_id=entity_id, labels=("alarms",), attributes={})
        self.assertIn(entity_id, self.monitor.alarms)
        self.assertIn(entity_id, self.monitor._track_states().entities)
        await self.observe(1, entity_id=entity_id, attributes={})
        self.assertEqual(self.monitor.alarms, {})
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered"])

    async def test_rapid_alarm_on_off_is_not_coalesced(self):
        for value in ("on", "off"):
            state = self.source(value=value, labels=("alarms",))
            self.monitor._async_source_changed(Event("state_changed", {"entity_id": state.entity_id, "new_state": state}))
        await asyncio.gather(*tuple(self.monitor._tasks))
        self.assertEqual(self.monitor.alarms, {})
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered", "alarm_solved"])

    async def test_failed_alarm_save_rolls_back_trigger_and_solution(self):
        self.monitor._store.async_save.side_effect = OSError("disk full")
        with self.assertRaises(OSError):
            await self.observe(0, labels=("alarms",))
        self.assertEqual(self.monitor.alarms, {})
        self.assertEqual(self.events, [])
        self.monitor._store.async_save.side_effect = None
        await self.observe(1, labels=("alarms",))
        self.monitor._store.async_save.side_effect = OSError("disk full")
        with self.assertRaises(OSError):
            await self.observe(2, "off", labels=("alarms",))
        self.assertEqual(len(self.monitor.alarms), 1)
        self.assertEqual([kind for kind, _ in self.events], ["alarm_triggered"])
        self.monitor._store.async_save.side_effect = None
        await self.observe(3, "off", labels=("alarms",))
        self.assertEqual(self.events[-1][0], "alarm_solved")

    async def test_alarm_unknown_does_not_create_or_solve_a_disconnect_warning(self):
        await self.observe(0, "unknown", labels=("alarms",))
        self.assertEqual(self.monitor.problems, {})
        await self.observe(100, "unavailable", labels=("alarms",))
        await self.observe(400, "unavailable", labels=("alarms",))
        await self.observe(500, "unknown", labels=("alarms",))
        self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["solved_delay_since"])
        self.assertEqual(len(self.events), 1)

    async def test_battery_critical_retains_thirty_minute_protection(self):
        attrs = {"battery_state": "critical"}
        await self.observe(0, "1", entity_id="sensor.battery", attributes=attrs)
        await self.observe(1799, "2", entity_id="sensor.battery", attributes=attrs)
        self.assertEqual(self.events, [])
        await self.observe(1800, "2", entity_id="sensor.battery", attributes=attrs)
        self.assertEqual(self.events[0][1]["reason"], "battery_critical")

    async def test_numeric_labels_use_thresholds_and_reject_unknown_values(self):
        for label, threshold in (("below30", 30), ("below20", 20), ("below10", 10)):
            for raw, expected in ((str(threshold - 1), True), (str(threshold), False), ("unavailable", None), ("nan", None), ("text", None)):
                with self.subTest(label=label, value=raw):
                    state = self.source("sensor.level", raw, labels=(label,), attributes={})
                    self.assertIs(self.monitor._classify("sensor.level", state).active, expected)

    async def test_ignored_sources_and_disabled_entities_are_not_warnings(self):
        state = self.source(labels=("ignored",))
        self.assertIsNone(self.monitor._classify(state.entity_id, state))
        state = self.source()
        self.registrations[state.entity_id].disabled_by = "user"
        self.assertIsNone(self.monitor._classify(state.entity_id, state))

    async def test_warning_on_label_supports_other_entity_domains(self):
        state = self.source("switch.warning", "on", labels=("warnings",), attributes={})
        self.assertTrue(self.monitor._classify(state.entity_id, state).active)
        self.assertIn("switch.warning", self.monitor._track_states().entities)

    async def test_labelled_toolbox_cameras_can_still_warn_about_unavailability(self):
        state = self.source("camera.snapshot", "unavailable", labels=("alarms",), attributes={})
        registration = self.registrations[state.entity_id]
        registration.platform = "hippos_toolbox"
        registration.unique_id = "progressive-snapshot"
        self.assertTrue(self.monitor._classify(state.entity_id, state).active)

    async def test_reload_keeps_triggered_incidents_but_restarts_both_pending_delays(self):
        await self.observe(0)
        await self.observe(60)
        await self.observe(90, "off")
        await self.observe(100, entity_id="binary_sensor.pending")
        stored = {"problems": self.monitor.problems}
        reloaded = _ProblemMonitor(self.hass, _Entry(), self.subentry)
        reloaded._store = SimpleNamespace(async_load=AsyncMock(return_value=stored), async_save=AsyncMock())
        restored_events = []
        reloaded.async_subscribe_events(lambda *args: restored_events.append(args))
        await reloaded.async_load()
        self.assertEqual(set(reloaded.problems), {"binary_sensor.problem"})
        restored = reloaded.problems["binary_sensor.problem"]
        self.assertEqual(restored["triggered_since"], stored["problems"]["binary_sensor.problem"]["triggered_since"])
        self.assertIsNone(restored["trigger_delay_since"])
        self.assertIsNone(restored["solved_delay_since"])
        self.assertIsNone(restored["solved_delay_until"])
        self.assertEqual(restored_events, [])
        await reloaded.async_stop()

    async def test_deadline_is_scheduled_without_a_repeating_poll(self):
        await self.observe(0)
        self.assertEqual(self.timer.call_args.args[2], self.clock + timedelta(seconds=60))
        await self.observe(60)
        await self.observe(90, "off")
        self.assertEqual(self.timer.call_args.args[2], self.clock + timedelta(minutes=10))

    async def test_persistence_finishes_before_emitting_transition(self):
        snapshots = []
        async def save(data):
            snapshots.append(deepcopy(data))
        self.monitor._store.async_save.side_effect = save
        self.monitor.async_subscribe_events(lambda kind, problem: self.assertEqual(snapshots[-1]["problems"], self.monitor.problems))
        await self.observe(0)
        await self.observe(60)

    async def test_rapid_off_on_events_are_not_coalesced(self):
        for second, value in ((0, "on"), (30, "off"), (40, "on")):
            self.clock = datetime(2026, 10, 17, 12, tzinfo=UTC) + timedelta(seconds=second)
            state = self.source(value=value)
            self.monitor._async_source_changed(Event("state_changed", {"entity_id": state.entity_id, "new_state": state}))
        await asyncio.gather(*tuple(self.monitor._tasks))
        self.assertEqual(self.events, [])
        self.assertEqual(self.monitor.problems["binary_sensor.problem"]["trigger_delay_since"], self.clock.isoformat())

    async def test_deadline_callback_triggers_without_another_source_change(self):
        await self.observe(0)
        deadline = self.timer.call_args.args[1]
        self.clock += timedelta(minutes=1)
        deadline(self.clock)
        await asyncio.gather(*tuple(self.monitor._tasks))
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_alarm_delay_is_configurable_and_not_extended_by_general_delay(self):
        self.options[CONF_ALARM_UNAVAILABLE_DELAY] = 2
        self.options[CONF_TRIGGER_DELAY] = 10
        await self.observe(0, "unavailable", labels=("alarms",))
        await self.observe(120, "unavailable", labels=("alarms",))
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_removed_source_is_unknown_not_a_solution(self):
        await self.observe(0)
        await self.observe(60)
        self.registrations.clear()
        observation = self.monitor._classify("binary_sensor.problem", None)
        self.assertIsNone(observation.active)
        await self.monitor._async_observe("binary_sensor.problem", observation, self.clock)
        self.assertIsNotNone(self.monitor.problems["binary_sensor.problem"]["triggered_since"])
        self.assertEqual(len(self.events), 1)

    async def test_failed_save_rolls_back_trigger_and_can_be_retried(self):
        await self.observe(0)
        self.monitor._store.async_save.side_effect = OSError("disk full")
        with self.assertRaises(OSError):
            await self.observe(60)
        self.assertIsNone(self.monitor.problems["binary_sensor.problem"]["triggered_since"])
        self.assertEqual(self.events, [])
        self.monitor._store.async_save.side_effect = None
        await self.observe(90)
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_sensor_and_event_entity_expose_the_same_incident(self):
        from custom_components.hippos_toolbox.sensor import ToolboxProblemsSensor
        from custom_components.hippos_toolbox.event import ToolboxProblemEvent
        sensor = ToolboxProblemsSensor(self.monitor)
        event = ToolboxProblemEvent(self.monitor)
        event.hass = self.hass
        event.entity_id = "event.test_problem_changes"
        with patch.object(event, "async_write_ha_state"):
            await event.async_added_to_hass()
            await self.observe(0)
            self.assertEqual(sensor.native_value, 0)
            await self.observe(60)
            self.assertEqual(sensor.native_value, 1)
            self.assertEqual(event.state_attributes["event_type"], "triggered")
            self.assertEqual(event.state_attributes["problem"]["entity_id"], "binary_sensor.problem")
            await self.observe(90, "off")
            self.assertEqual(sensor.native_value, 1)
            await self.observe(690, "off")
            self.assertEqual(sensor.native_value, 0)
            self.assertEqual(event.state_attributes["event_type"], "solved")

    async def test_monitoring_counters_preserve_statistics_metadata(self):
        from custom_components.hippos_toolbox.sensor import ToolboxProblemsSensor, ToolboxAlarmsSensor

        # Changing metadata interrupts existing statistics series and creates
        # a repair issue
        for sensor, entity_id in (
            (ToolboxProblemsSensor(self.monitor), "sensor.fixture_problems"),
            (ToolboxAlarmsSensor(self.monitor), "sensor.fixture_alarms"),
        ):
            with self.subTest(entity_id=entity_id):
                self.assertEqual(sensor.native_value, 0)
                self.assertEqual(sensor.capability_attributes["state_class"], "total")
                self.assertIsNone(sensor.native_unit_of_measurement)
                self.assertIsNone(sensor.last_reset)

    async def test_platforms_attach_entities_to_monitor_subentry_and_are_optional(self):
        from custom_components.hippos_toolbox import sensor, event
        entry = SimpleNamespace(runtime_data=SimpleNamespace(monitor=self.monitor, monitoring_subentries={"monitor": {}}))
        for platform, count in ((sensor, 2), (event, 1)):
            add = Mock()
            await platform.async_setup_entry(self.hass, entry, add)
            self.assertEqual(add.call_args.kwargs, {"config_subentry_id": "monitor"})
            self.assertEqual(len(add.call_args.args[0]), count)
        entry.runtime_data.monitor = None
        for platform in (sensor, event):
            add = Mock()
            await platform.async_setup_entry(self.hass, entry, add)
            add.assert_not_called()

    async def test_monitor_registration_preserves_main_device_and_existing_entities(self):
        from custom_components.hippos_toolbox.button import ToolboxCheckUpdatesButton
        from custom_components.hippos_toolbox.update import ToolboxBlueprintUpdate
        from custom_components.hippos_toolbox.sensor import ToolboxProblemsSensor, ToolboxAlarmsSensor
        from custom_components.hippos_toolbox.event import ToolboxProblemEvent

        self.registry_patch.stop()
        loader.async_setup(self.hass)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        entry = ConfigEntry(
            domain="hippos_toolbox", entry_id="toolbox", data={}, options={},
            source="user", title="Toolbox", unique_id=None, version=1,
            minor_version=1, discovery_keys={}, subentries_data=[{
                "subentry_id": "monitor", "subentry_type": "monitoring",
                "title": "Monitoring", "data": self.options, "unique_id": None,
            }],
        )
        # Register the fixture without running the integration's GitHub setup.
        self.hass.config_entries._entries[entry.entry_id] = entry
        devices = self.hass.data[dr.DATA_REGISTRY] = dr.DeviceRegistry(self.hass)
        if hasattr(devices, "async_setup"):
            devices.async_setup()
        await devices.async_load(load_empty=True)
        entities = monitoring.er.async_get(self.hass)
        await entities.async_load(load_empty=True)
        coordinator = Mock()
        root_entities = []
        root_device = None
        for domain, entity in (("button", ToolboxCheckUpdatesButton(coordinator)), ("update", ToolboxBlueprintUpdate(coordinator))):
            root_device = devices.async_get_or_create(
                config_entry_id=entry.entry_id, config_subentry_id=None, **entity.device_info,
            )
            root_entities.append(entities.async_get_or_create(
                domain, "hippos_toolbox", entity.unique_id, config_entry=entry,
                device_id=root_device.id,
            ).entity_id)
        monitor_devices = set()
        for domain, entity in (("sensor", ToolboxProblemsSensor(self.monitor)), ("sensor", ToolboxAlarmsSensor(self.monitor)), ("event", ToolboxProblemEvent(self.monitor))):
            device = devices.async_get_or_create(
                config_entry_id=entry.entry_id, config_subentry_id="monitor", **entity.device_info,
            )
            monitor_devices.add(device.id)
            entities.async_get_or_create(
                domain, "hippos_toolbox", entity.unique_id, config_entry=entry,
                config_subentry_id="monitor", device_id=device.id,
            )
        await self.hass.async_block_till_done()
        self.assertEqual(len(monitor_devices), 1)
        self.assertNotIn(root_device.id, monitor_devices)
        for entity_id in root_entities:
            self.assertIsNotNone(entities.async_get(entity_id))
        registered = [item for item in entities.entities.values() if item.platform == "hippos_toolbox"]
        self.assertEqual(len(registered), 5)
        self.assertEqual(sum(item.config_subentry_id == "monitor" for item in registered), 3)
        await self.hass.async_stop()

    async def test_real_source_listener_starts_after_ha_and_is_removed_on_unload(self):
        self.source(value="off")
        self.hass.state = CoreState.running
        self.monitor.async_start()
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.source(value="on")
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.assertIn("binary_sensor.problem", self.monitor.problems)
        self.source(value="off")
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.assertEqual(self.monitor.problems, {})
        await self.monitor.async_stop()
        self.source(value="on")
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.assertEqual(self.monitor.problems, {})

    async def test_real_store_survives_new_monitor_instance_without_replaying_event(self):
        self.monitor._store = Store(self.hass, 1, "test.monitor", atomic_writes=True)
        await self.observe(0)
        await self.observe(60)
        await self.observe(61, entity_id="binary_sensor.smoke", labels=("alarms",))
        original = self.monitor.problems["binary_sensor.problem"]["triggered_since"]
        original_alarm = self.monitor.alarms["binary_sensor.smoke"]["triggered_since"]
        await self.monitor.async_stop()
        restored = _ProblemMonitor(self.hass, _Entry(), self.subentry)
        restored._store = Store(self.hass, 1, "test.monitor", atomic_writes=True)
        restored_events = []
        restored.async_subscribe_events(lambda *args: restored_events.append(args))
        await restored.async_load()
        self.assertEqual(restored.problems["binary_sensor.problem"]["triggered_since"], original)
        self.assertEqual(restored.alarms["binary_sensor.smoke"]["triggered_since"], original_alarm)
        await restored._async_observe("binary_sensor.smoke", restored._classify("binary_sensor.smoke", self.hass.states.get("binary_sensor.smoke")), self.clock)
        self.assertEqual(restored_events, [])
        await restored.async_stop()

    async def test_alarm_sensor_and_event_entity_share_the_persisted_alarm(self):
        from custom_components.hippos_toolbox.sensor import ToolboxAlarmsSensor
        from custom_components.hippos_toolbox.event import ToolboxProblemEvent
        sensor = ToolboxAlarmsSensor(self.monitor)
        event = ToolboxProblemEvent(self.monitor)
        event.hass = self.hass
        event.entity_id = "event.test_alarm_changes"
        with patch.object(event, "async_write_ha_state"):
            await event.async_added_to_hass()
            await self.observe(0, labels=("alarms",))
            self.assertEqual(sensor.native_value, 1)
            record = sensor.extra_state_attributes["alarms"]["binary_sensor.problem"]
            self.assertEqual(event.state_attributes["event_type"], "alarm_triggered")
            self.assertEqual(event.state_attributes["problem"], record)
            self.assertEqual(self.monitor._store.async_save.call_args.args[0]["alarms"], self.monitor.alarms)
            await self.observe(1, "off", labels=("alarms",))
            self.assertEqual(sensor.native_value, 0)
            self.assertEqual(event.state_attributes["event_type"], "alarm_solved")

    async def test_explicit_registry_deletion_retires_source_without_all_clear(self):
        await self.observe(0)
        await self.observe(60)
        self.registrations.clear()
        self.hass.states.async_remove("binary_sensor.problem")
        self.monitor._tracker = Mock()
        self.monitor._async_registry_changed(Event("entity_registry_updated", {"action": "remove", "entity_id": "binary_sensor.problem"}))
        await asyncio.gather(*tuple(self.monitor._tasks))
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual([kind for kind, _ in self.events], ["triggered"])

    async def test_unregistered_source_removed_before_pending_task_is_processed(self):
        first = self.source()
        self.registrations.clear()
        self.monitor._async_source_changed(Event("state_changed", {"entity_id": first.entity_id, "new_state": first}))
        self.monitor._async_source_changed(Event("state_changed", {"entity_id": first.entity_id, "new_state": None, "old_state": first}))
        await asyncio.gather(*tuple(self.monitor._tasks))
        self.assertEqual(self.monitor.problems, {})
        self.assertEqual(self.events, [])


if __name__ == "__main__":
    unittest.main()
