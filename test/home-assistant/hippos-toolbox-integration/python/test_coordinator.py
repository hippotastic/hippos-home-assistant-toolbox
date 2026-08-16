"""Regression tests for channel-specific update intervals."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

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


if __name__ == "__main__":
    unittest.main()
