"""Regression tests for channel-specific update intervals."""

from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from custom_components.hippos_toolbox.api import ToolboxApiError
from custom_components.hippos_toolbox.const import (
    CONF_UPDATE_CHANNEL,
    DEVELOPMENT_UPDATE_INTERVAL,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_INTERVAL,
)
from custom_components.hippos_toolbox.coordinator import ToolboxCoordinator


class ToolboxCoordinatorTests(unittest.TestCase):
    """Verify that each update channel uses its intended polling interval."""

    def assert_update_interval(self, options: dict[str, str], expected) -> None:
        """Build a coordinator and inspect the interval passed to Home Assistant."""

        config_entry = SimpleNamespace(options=options)
        with patch.object(DataUpdateCoordinator, "__init__", return_value=None) as init:
            ToolboxCoordinator(SimpleNamespace(), config_entry, SimpleNamespace())

        self.assertEqual(init.call_args.kwargs["update_interval"], expected)

    def test_defaults_to_daily_stable_updates(self) -> None:
        self.assert_update_interval({}, UPDATE_INTERVAL)

    def test_checks_development_every_two_hours(self) -> None:
        self.assert_update_interval(
            {CONF_UPDATE_CHANNEL: UPDATE_CHANNEL_DEVELOPMENT},
            DEVELOPMENT_UPDATE_INTERVAL,
        )


class ToolboxCoordinatorRefreshTests(unittest.IsolatedAsyncioTestCase):
    """Verify failed published-catalog checks are visible to the user."""

    async def test_logs_failed_check_to_retry_button_activity(self) -> None:
        hass = SimpleNamespace()
        manager = SimpleNamespace(
            async_fetch_and_evaluate=AsyncMock(
                side_effect=ToolboxApiError("504 Gateway Timeout")
            )
        )
        coordinator = object.__new__(ToolboxCoordinator)
        coordinator.hass = hass
        coordinator.manager = manager
        registry = Mock()
        registry.async_get_entity_id.return_value = "button.check_for_updates"

        with (
            patch(
                "custom_components.hippos_toolbox.coordinator.er.async_get",
                return_value=registry,
            ),
            patch(
                "custom_components.hippos_toolbox.coordinator.async_log_entry"
            ) as async_log_entry,
        ):
            with self.assertRaises(UpdateFailed):
                await coordinator._async_update_data()

        async_log_entry.assert_called_once_with(
            hass,
            name="Check for updates",
            message="failed. See the system log for details.",
            entity_id="button.check_for_updates",
        )


if __name__ == "__main__":
    unittest.main()
