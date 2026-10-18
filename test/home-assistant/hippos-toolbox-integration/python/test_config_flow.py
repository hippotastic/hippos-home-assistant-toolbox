"""Regression tests for update-channel options."""

import unittest
from tempfile import TemporaryDirectory
from types import MappingProxyType
from types import SimpleNamespace
from unittest.mock import Mock, patch

from homeassistant import config_entries
from homeassistant.const import CONF_NAME
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import selector

from custom_components.hippos_toolbox.config_flow import (
    ProgressiveCameraSubentryFlow,
    MonitoringSubentryFlow,
    ToolboxOptionsFlow,
)
from custom_components.hippos_toolbox.const import (
    CAMERA_FRONTEND_OPTIONS,
    CONF_ALARM_LABELS,
    CONF_BELOW_10_LABELS,
    CONF_BELOW_20_LABELS,
    CONF_BELOW_30_LABELS,
    CONF_IGNORED_LABELS,
    CONF_MONITOR_PROBLEM_SENSORS,
    CONF_MONITOR_CRITICAL_BATTERIES,
    CONF_WARNING_LABELS,
    MONITORING_DELAY_DEFAULTS,
    MONITORING_NOTIFICATION_DEFAULTS,
    CONF_WARNING_NOTIFICATIONS,
    CONF_ALARM_NOTIFICATIONS,
    MONITORING_SUBENTRY_TYPE,
    CONF_SOURCE_ENTITY_ID,
    CONF_UPDATE_CHANNEL,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_CHANNEL_STABLE,
)


class ToolboxOptionsFlowTests(unittest.IsolatedAsyncioTestCase):
    """Verify the opt-in channel selection."""

    async def test_defaults_to_stable(self) -> None:
        flow = ToolboxOptionsFlow()
        flow.handler = "test-entry"
        flow.hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_get_known_entry=lambda _: SimpleNamespace(options={})
            )
        )

        result = await flow.async_step_init()

        self.assertEqual(result["type"], FlowResultType.FORM)
        self.assertEqual(
            result["data_schema"]({}),
            {CONF_UPDATE_CHANNEL: UPDATE_CHANNEL_STABLE, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, True)},
        )

    async def test_accepts_development_selection(self) -> None:
        flow = ToolboxOptionsFlow()

        result = await flow.async_step_init(
            {CONF_UPDATE_CHANNEL: UPDATE_CHANNEL_DEVELOPMENT}
        )

        self.assertEqual(result["type"], FlowResultType.CREATE_ENTRY)
        self.assertEqual(
            result["data"],
            {CONF_UPDATE_CHANNEL: UPDATE_CHANNEL_DEVELOPMENT},
        )


class ProgressiveCameraSubentryFlowTests(unittest.IsolatedAsyncioTestCase):
    """Verify UI validation for progressive camera helpers."""

    def _flow_and_entry(
        self, subentries: tuple[config_entries.ConfigSubentry, ...] = ()
    ) -> tuple[ProgressiveCameraSubentryFlow, SimpleNamespace]:
        entry = SimpleNamespace(
            subentries={item.subentry_id: item for item in subentries}
        )
        flow = ProgressiveCameraSubentryFlow()
        flow.handler = ("test-entry", PROGRESSIVE_CAMERA_SUBENTRY_TYPE)
        flow.context = {"source": config_entries.SOURCE_USER}
        flow.hass = SimpleNamespace()
        return flow, entry

    async def test_creates_subentry_with_name_as_title(self) -> None:
        flow, entry = self._flow_and_entry()

        with (
            patch.object(flow, "_get_entry", return_value=entry),
            patch.object(flow, "_source_validation_error", return_value=None),
        ):
            result = await flow.async_step_user(
                {
                    CONF_NAME: "  Front door  ",
                    CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot",
                }
            )

        self.assertEqual(result["type"], FlowResultType.CREATE_ENTRY)
        self.assertEqual(result["title"], "Front door")
        self.assertEqual(
            result["data"],
            {CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot"},
        )

    async def test_rejects_duplicate_and_toolbox_sources(self) -> None:
        existing = config_entries.ConfigSubentry(
            data=MappingProxyType(
                {CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot"}
            ),
            subentry_id="existing",
            subentry_type=PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
            title="Existing",
            unique_id=None,
        )
        flow, entry = self._flow_and_entry((existing,))

        with (
            patch.object(flow, "_get_entry", return_value=entry),
            patch.object(flow, "_source_validation_error", return_value=None),
        ):
            duplicate = await flow.async_step_user(
                {
                    CONF_NAME: "Duplicate",
                    CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot",
                }
            )
        self.assertEqual(
            duplicate["errors"], {CONF_SOURCE_ENTITY_ID: "duplicate_source"}
        )

        with (
            patch.object(flow, "_get_entry", return_value=entry),
            patch.object(
                flow,
                "_source_validation_error",
                return_value="source_is_progressive_camera",
            ),
        ):
            recursive = await flow.async_step_user(
                {
                    CONF_NAME: "Recursive",
                    CONF_SOURCE_ENTITY_ID: "camera.progressive_front_door",
                }
            )
        self.assertEqual(
            recursive["errors"],
            {CONF_SOURCE_ENTITY_ID: "source_is_progressive_camera"},
        )

    async def test_reconfigure_allows_current_source_and_updates_title(self) -> None:
        existing = config_entries.ConfigSubentry(
            data=MappingProxyType(
                {CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot"}
            ),
            subentry_id="existing",
            subentry_type=PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
            title="Old name",
            unique_id=None,
        )
        flow, entry = self._flow_and_entry((existing,))
        flow.context = {
            "source": config_entries.SOURCE_RECONFIGURE,
            "subentry_id": existing.subentry_id,
        }
        update_subentry = Mock(return_value=True)
        flow.hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_update_subentry=update_subentry
            )
        )

        with (
            patch.object(flow, "_get_entry", return_value=entry),
            patch.object(
                flow, "_get_reconfigure_subentry", return_value=existing
            ),
            patch.object(flow, "_source_validation_error", return_value=None),
        ):
            result = await flow.async_step_reconfigure(
                {
                    CONF_NAME: "New name",
                    CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot",
                }
            )

        self.assertEqual(result["type"], FlowResultType.ABORT)
        self.assertEqual(result["reason"], "reconfigure_successful")
        update_subentry.assert_called_once()
        self.assertEqual(update_subentry.call_args.kwargs["entry"], entry)
        self.assertEqual(update_subentry.call_args.kwargs["subentry"], existing)
        self.assertEqual(update_subentry.call_args.kwargs["title"], "New name")
        self.assertEqual(
            update_subentry.call_args.kwargs["data"],
            {CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot"},
        )


class MonitoringSubentryFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_new_monitor_has_empty_label_selections_and_default_delays(self):
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.hass = self.hass
        with patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={})):
            result = await flow.async_step_user()
        self.assertEqual(result["data_schema"]({}), {
            CONF_MONITOR_PROBLEM_SENSORS: True, CONF_MONITOR_CRITICAL_BATTERIES: True,
            **MONITORING_DELAY_DEFAULTS,
            **MONITORING_NOTIFICATION_DEFAULTS,
            CONF_WARNING_LABELS: [], CONF_ALARM_LABELS: [], CONF_IGNORED_LABELS: [],
            CONF_BELOW_30_LABELS: [], CONF_BELOW_20_LABELS: [], CONF_BELOW_10_LABELS: [],
        })

    async def test_reconfigure_form_retains_saved_labels_empty_selections_and_delays(self):
        saved = {
            CONF_MONITOR_PROBLEM_SENSORS: False, CONF_MONITOR_CRITICAL_BATTERIES: False,
            "trigger_delay_minutes": 2, "solved_delay_minutes": 11,
            "alarm_unavailable_delay_minutes": 7, "battery_critical_delay_minutes": 31,
            CONF_WARNING_LABELS: ["fixture_warning_a", "fixture_warning_b"],
            CONF_ALARM_LABELS: ["fixture_alarm"], CONF_IGNORED_LABELS: [],
            CONF_BELOW_30_LABELS: [], CONF_BELOW_20_LABELS: ["fixture_threshold"],
            CONF_BELOW_10_LABELS: ["fixture_low_threshold"],
        }
        current = config_entries.ConfigSubentry(
            data=MappingProxyType(saved), subentry_id="monitor",
            subentry_type=MONITORING_SUBENTRY_TYPE, title="Problem monitoring", unique_id=None,
        )
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.hass = self.hass
        with (
            patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={"monitor": current})),
            patch.object(flow, "_get_reconfigure_subentry", return_value=current),
        ):
            result = await flow.async_step_reconfigure()
        self.assertEqual(result["data_schema"]({}), {**MONITORING_NOTIFICATION_DEFAULTS, **saved})
        self.assertEqual(dict(current.data), saved)

    async def test_reconfigure_form_leaves_unspecified_label_selections_empty(self):
        current = config_entries.ConfigSubentry(
            data=MappingProxyType({CONF_WARNING_LABELS: ["fixture_warning"]}),
            subentry_id="monitor", subentry_type=MONITORING_SUBENTRY_TYPE,
            title="Problem monitoring", unique_id=None,
        )
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.hass = self.hass
        with (
            patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={"monitor": current})),
            patch.object(flow, "_get_reconfigure_subentry", return_value=current),
        ):
            result = await flow.async_step_reconfigure()
        self.assertEqual(result["data_schema"]({}), {
            CONF_MONITOR_PROBLEM_SENSORS: True, CONF_MONITOR_CRITICAL_BATTERIES: True,
            **MONITORING_DELAY_DEFAULTS,
            **MONITORING_NOTIFICATION_DEFAULTS,
            CONF_WARNING_LABELS: ["fixture_warning"], CONF_ALARM_LABELS: [], CONF_IGNORED_LABELS: [],
            CONF_BELOW_30_LABELS: [], CONF_BELOW_20_LABELS: [], CONF_BELOW_10_LABELS: [],
        })

    async def test_creates_monitor_and_rejects_second_monitor(self):
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.context = {"source": config_entries.SOURCE_USER}
        flow.hass = self.hass
        submitted = {
            **MONITORING_DELAY_DEFAULTS,
            CONF_MONITOR_PROBLEM_SENSORS: False, CONF_MONITOR_CRITICAL_BATTERIES: True,
        }
        with patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={})):
            result = await flow.async_step_user(submitted)
        self.assertEqual(result["type"], FlowResultType.CREATE_ENTRY)
        self.assertEqual(result["data"], submitted)
        existing = SimpleNamespace(subentry_type=MONITORING_SUBENTRY_TYPE)
        with patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={"existing": existing})):
            duplicate = await flow.async_step_user()
        self.assertEqual(duplicate["type"], FlowResultType.ABORT)
        self.assertEqual(duplicate["reason"], "already_configured")

    async def test_notification_sections_offer_notify_targets_and_editable_templates(self):
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.hass = self.hass
        with patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={})):
            result = await flow.async_step_user()
        sections = {key.schema: value for key, value in result["data_schema"].schema.items()}
        for channel in (CONF_WARNING_NOTIFICATIONS, CONF_ALARM_NOTIFICATIONS):
            fields = {key.schema: value for key, value in sections[channel].schema.schema.items()}
            self.assertIsInstance(fields["recipients"], selector.EntitySelector)
            self.assertTrue(fields["recipients"].config["multiple"])
            self.assertEqual(fields["recipients"].config["filter"], [{"domain": ["notify"]}])
            self.assertIsInstance(fields["title"], selector.TemplateSelector)
            self.assertIsInstance(fields["message"], selector.TemplateSelector)
            self.assertIsInstance(fields["data"], selector.TemplateSelector)

    async def test_rejects_invalid_templates_and_empty_messages_without_losing_edits(self):
        for channel in (CONF_WARNING_NOTIFICATIONS, CONF_ALARM_NOTIFICATIONS):
            for field, text, error in (("title", "{%", "invalid_template"), ("message", "{{", "invalid_template"), ("data", "{{", "invalid_template"), ("message", "  ", "empty_message")):
                with self.subTest(channel=channel, field=field, error=error):
                    flow = MonitoringSubentryFlow()
                    flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
                    flow.hass = self.hass
                    submitted = {channel: {"recipients": ["notify.fixture_target"], field: text}}
                    with patch.object(flow, "_get_entry", return_value=SimpleNamespace(subentries={})):
                        result = await flow.async_step_user(submitted)
                    self.assertEqual(result["type"], FlowResultType.FORM)
                    self.assertEqual(result["errors"], {"base": error})
                    sections = {key.schema: value for key, value in result["data_schema"].schema.items()}
                    defaults = {key.schema: key.default() for key in sections[channel].schema.schema}
                    self.assertEqual(defaults[field], text)
                    self.assertEqual(defaults["recipients"], ["notify.fixture_target"])

    async def test_reconfigure_keeps_local_notification_templates_and_recipients(self):
        saved = {
            **MONITORING_DELAY_DEFAULTS,
            CONF_WARNING_NOTIFICATIONS: {
                "recipients": ["notify.fixture_a", "notify.fixture_group"],
                "title": "Custom warning", "message": "{{ problem.name | upper }} / {{ event_type }}",
                "data": "{{ {'url': '/lovelace/alerts'} }}",
            },
            CONF_ALARM_NOTIFICATIONS: {"recipients": [], "title": "", "message": "Custom alarm"},
        }
        current = config_entries.ConfigSubentry(
            data=MappingProxyType(saved), subentry_id="monitor", subentry_type=MONITORING_SUBENTRY_TYPE,
            title="Problem monitoring", unique_id=None,
        )
        entry = SimpleNamespace(subentries={"monitor": current})
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.context = {"source": config_entries.SOURCE_RECONFIGURE, "subentry_id": "monitor"}
        flow.hass = self.hass
        update = Mock(return_value=True)
        self.hass.config_entries = SimpleNamespace(async_update_subentry=update)
        with patch.object(flow, "_get_entry", return_value=entry), patch.object(flow, "_get_reconfigure_subentry", return_value=current):
            result = await flow.async_step_reconfigure()
            defaults = result["data_schema"]({})
            for channel in (CONF_WARNING_NOTIFICATIONS, CONF_ALARM_NOTIFICATIONS):
                self.assertEqual(defaults[channel], {"data": "{{ {} }}", **saved[channel]})
            result = await flow.async_step_reconfigure(defaults)
        self.assertEqual(result["type"], FlowResultType.ABORT)
        self.assertEqual(update.call_args.kwargs["data"], defaults)
        self.assertEqual(dict(current.data), saved)

    async def test_reconfigure_preserves_subentry_and_storage_identity(self):
        saved = {
            CONF_MONITOR_PROBLEM_SENSORS: False, CONF_MONITOR_CRITICAL_BATTERIES: True,
            **MONITORING_DELAY_DEFAULTS,
            CONF_WARNING_LABELS: ["fixture_warning_a", "fixture_warning_b"],
            CONF_ALARM_LABELS: ["fixture_alarm"], CONF_IGNORED_LABELS: [],
            CONF_BELOW_30_LABELS: [], CONF_BELOW_20_LABELS: ["fixture_threshold"],
            CONF_BELOW_10_LABELS: ["fixture_low_threshold"],
        }
        current = config_entries.ConfigSubentry(
            data=MappingProxyType(saved),
            subentry_id="monitor", subentry_type=MONITORING_SUBENTRY_TYPE,
            title="Problem monitoring", unique_id=None,
        )
        entry = SimpleNamespace(subentries={"monitor": current})
        flow = MonitoringSubentryFlow()
        flow.handler = ("test-entry", MONITORING_SUBENTRY_TYPE)
        flow.context = {"source": config_entries.SOURCE_RECONFIGURE, "subentry_id": "monitor"}
        update = Mock(return_value=True)
        flow.hass = self.hass
        self.hass.config_entries = SimpleNamespace(async_update_subentry=update)
        submitted = {**saved, "alarm_unavailable_delay_minutes": 7}
        with patch.object(flow, "_get_entry", return_value=entry), patch.object(flow, "_get_reconfigure_subentry", return_value=current):
            result = await flow.async_step_reconfigure(submitted)
        self.assertEqual(result["type"], FlowResultType.ABORT)
        self.assertEqual(update.call_args.kwargs["subentry"].subentry_id, "monitor")
        self.assertEqual(update.call_args.kwargs["data"], submitted)
        self.assertEqual(dict(current.data), saved)


if __name__ == "__main__":
    unittest.main()
