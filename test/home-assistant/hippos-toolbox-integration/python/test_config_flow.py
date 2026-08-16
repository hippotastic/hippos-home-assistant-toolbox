"""Regression tests for update-channel options."""

import unittest
from types import MappingProxyType
from types import SimpleNamespace
from unittest.mock import Mock, patch

from homeassistant import config_entries
from homeassistant.const import CONF_NAME
from homeassistant.data_entry_flow import FlowResultType

from custom_components.hippos_toolbox.config_flow import (
    ProgressiveCameraSubentryFlow,
    ToolboxOptionsFlow,
)
from custom_components.hippos_toolbox.const import (
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
            {CONF_UPDATE_CHANNEL: UPDATE_CHANNEL_STABLE},
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


if __name__ == "__main__":
    unittest.main()
