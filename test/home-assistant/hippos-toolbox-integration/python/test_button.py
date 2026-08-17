"""Regression tests for the manual update-check button."""

from types import SimpleNamespace
import unittest

from custom_components.hippos_toolbox.button import ToolboxCheckUpdatesButton


class ToolboxCheckUpdatesButtonTests(unittest.TestCase):
    """Verify that a failed shared refresh does not disable its retry control."""

    def test_remains_available_after_coordinator_failure(self) -> None:
        entity = object.__new__(ToolboxCheckUpdatesButton)
        entity.coordinator = SimpleNamespace(last_update_success=False)

        self.assertTrue(entity.available)


if __name__ == "__main__":
    unittest.main()
