"""Regression tests for update-channel options."""

import unittest
from types import SimpleNamespace

from homeassistant.data_entry_flow import FlowResultType

from custom_components.hippos_toolbox.config_flow import ToolboxOptionsFlow
from custom_components.hippos_toolbox.const import (
    CONF_UPDATE_CHANNEL,
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


if __name__ == "__main__":
    unittest.main()
