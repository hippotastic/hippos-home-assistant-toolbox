"""Regression tests for camera feature settings and integration lifecycle."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from custom_components.hippos_toolbox import frontend, _async_reload_entry
from custom_components.hippos_toolbox.const import (
    CAMERA_FRONTEND_OPTIONS,
    CAMERA_FRONTEND_PROTOCOL,
    CONF_CAMERA_STREAM_CLEANUP,
    CONF_SOURCE_ENTITY_ID,
    CONF_UPDATE_CHANNEL,
    MONITORING_SUBENTRY_TYPE,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)


class _Connection:
    def __init__(self):
        self.subscriptions = {}
        self.results = []
        self.events = []
        self.errors = []

    def send_result(self, message_id):
        self.results.append(message_id)

    def send_event(self, message_id, settings):
        self.events.append((message_id, settings))

    def send_error(self, message_id, code, message):
        self.errors.append((message_id, code))


class FrontendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.commands = []
        self.hass = SimpleNamespace(data={})
        with patch.object(frontend.websocket_api, "async_register_command", side_effect=lambda _, command: self.commands.append(command)):
            frontend.async_setup_frontend(self.hass)
            frontend.async_setup_frontend(self.hass)
        self.assertEqual(len(self.commands), 1)
        self.entry = SimpleNamespace(
            entry_id="toolbox",
            options={},
            subentries={},
            runtime_data=SimpleNamespace(update_channel="stable", camera_subentries={}, monitoring_subentries={}),
        )

    def subscribe(self):
        connection = _Connection()
        self.commands[0](self.hass, connection, {"id": 1, "protocol": CAMERA_FRONTEND_PROTOCOL})
        return connection

    async def test_initial_snapshot_defaults_and_only_publishes_protocol_and_feature_booleans(self):
        connection = self.subscribe()
        self.assertEqual(connection.events[-1][1], {"protocol": CAMERA_FRONTEND_PROTOCOL, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, False)})
        self.entry.options = {"secret": "never-publish", "update_channel": "development"}
        frontend.async_update_frontend(self.hass, self.entry)
        self.assertEqual(connection.events[-1][1], {"protocol": CAMERA_FRONTEND_PROTOCOL, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, True)})
        self.assertNotIn("secret", connection.events[-1][1])
        frontend.async_update_frontend(self.hass, self.entry)
        self.assertEqual(len(connection.events), 2)
        reconnected = self.subscribe()
        self.assertEqual(reconnected.events[-1][1], {"protocol": CAMERA_FRONTEND_PROTOCOL, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, True)})

    async def test_rejects_missing_or_incompatible_protocol_without_registering_a_subscription(self):
        for protocol in (None, 0, CAMERA_FRONTEND_PROTOCOL + 1, True):
            with self.subTest(protocol=protocol):
                connection = _Connection()
                message = {"id": 1}
                if protocol is not None:
                    message["protocol"] = protocol
                self.commands[0](self.hass, connection, message)
                self.assertEqual(connection.errors, [(1, "incompatible_version")])
                self.assertEqual(connection.events, [])
                self.assertEqual(connection.results, [])
                self.assertEqual(connection.subscriptions, {})

    async def test_unsubscribe_and_unload_stop_updates_and_disable_existing_clients(self):
        a = self.subscribe()
        b = self.subscribe()
        a.subscriptions[1]()
        frontend.async_update_frontend(self.hass, self.entry)
        self.assertEqual(len(a.events), 1)
        self.assertEqual(len(b.events), 2)
        frontend.async_unload_frontend(self.hass)
        self.assertEqual(b.events[-1][1], {"protocol": CAMERA_FRONTEND_PROTOCOL, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, False)})

    async def test_missing_frontend_bundle_disables_extensions_without_failing_backend_setup(self):
        connection = self.subscribe()
        frontend.async_update_frontend(self.hass, self.entry)
        self.hass.async_add_executor_job = AsyncMock(side_effect=FileNotFoundError("Missing bundle"))
        with self.assertLogs(frontend._LOGGER, level="WARNING") as logs:
            await frontend.async_setup_entry_frontend(self.hass, self.entry)
        self.assertIn("native viewer", logs.output[0])
        self.assertEqual(connection.events[-1][1], {"protocol": CAMERA_FRONTEND_PROTOCOL, **dict.fromkeys(CAMERA_FRONTEND_OPTIONS, False)})

    async def test_registers_one_cache_versioned_bundle_across_reload(self):
        self.hass.async_add_executor_job = AsyncMock(return_value=b"camera bundle")
        self.hass.http = SimpleNamespace(async_register_static_paths=AsyncMock())
        with patch.object(frontend.frontend, "add_extra_js_url") as add, patch.object(frontend.frontend, "remove_extra_js_url") as remove:
            await frontend.async_setup_entry_frontend(self.hass, self.entry)
            first_url = add.call_args.args[1]
            self.assertRegex(first_url, r"/hippos_toolbox/frontend/cameras.js\?v=[a-f0-9]{12}$")
            frontend.async_unload_frontend(self.hass)
            remove.assert_called_once_with(self.hass, first_url)
            await frontend.async_setup_entry_frontend(self.hass, self.entry)
            self.assertEqual(add.call_args.args[1], first_url)
        self.hass.http.async_register_static_paths.assert_awaited_once()

    async def test_frontend_options_apply_without_reloading_cameras(self):
        self.hass.config_entries = SimpleNamespace(async_reload=AsyncMock())
        self.entry.options = {CONF_CAMERA_STREAM_CLEANUP: False}
        with patch("custom_components.hippos_toolbox.async_stop_camera_streams") as stop:
            await _async_reload_entry(self.hass, self.entry)
            stop.assert_called_once_with(self.hass)
        self.hass.config_entries.async_reload.assert_not_awaited()
        self.entry.options[CONF_UPDATE_CHANNEL] = "development"
        await _async_reload_entry(self.hass, self.entry)
        self.hass.config_entries.async_reload.assert_awaited_once_with("toolbox")

    async def test_camera_subentry_changes_still_reload_the_integration(self):
        self.hass.config_entries = SimpleNamespace(async_reload=AsyncMock())
        self.entry.runtime_data.camera_subentries = {"removed": ("camera.front_door", "Front door")}
        await _async_reload_entry(self.hass, self.entry)
        self.hass.config_entries.async_reload.assert_awaited_once_with("toolbox")

    async def test_camera_title_changes_still_reload_the_entity_name(self):
        self.hass.config_entries = SimpleNamespace(async_reload=AsyncMock())
        self.entry.runtime_data.camera_subentries = {"camera": ("camera.front_door", "Old title")}
        self.entry.subentries = {"camera": SimpleNamespace(
            subentry_id="camera", title="New title",
            subentry_type=PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
            data={CONF_SOURCE_ENTITY_ID: "camera.front_door"},
        )}
        await _async_reload_entry(self.hass, self.entry)
        self.hass.config_entries.async_reload.assert_awaited_once_with("toolbox")

    async def test_monitoring_configuration_changes_reload_the_backend(self):
        self.hass.config_entries = SimpleNamespace(async_reload=AsyncMock())
        self.entry.subentries = {"monitor": SimpleNamespace(
            subentry_id="monitor", subentry_type=MONITORING_SUBENTRY_TYPE,
            data={"alarm_unavailable_delay_minutes": 5},
        )}
        await _async_reload_entry(self.hass, self.entry)
        self.hass.config_entries.async_reload.assert_awaited_once_with("toolbox")


if __name__ == "__main__":
    unittest.main()
