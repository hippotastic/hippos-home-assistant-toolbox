"""Regression tests for the user-facing blueprint Repair flow."""

from types import SimpleNamespace
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.data_entry_flow import FlowResultType

from custom_components.hippos_toolbox.models import AffectedAutomation
from custom_components.hippos_toolbox.repairs import RestoreBlueprintRepairFlow

from repository import find_repository_root


class RepairFlowTests(unittest.IsolatedAsyncioTestCase):
    """Verify that local files are only replaced after an explicit choice."""

    def setUp(self) -> None:
        self.manager = SimpleNamespace(
            async_check_restore_compatibility=AsyncMock(return_value=()),
            async_restore_blueprint=AsyncMock(return_value=True),
        )
        self.coordinator = SimpleNamespace(async_request_refresh=AsyncMock())
        runtime_data = SimpleNamespace(
            manager=self.manager,
            coordinator=self.coordinator,
        )
        config_entries = SimpleNamespace(
            async_entries=Mock(return_value=[SimpleNamespace(runtime_data=runtime_data)])
        )
        self.hass = SimpleNamespace(config_entries=config_entries)
        self.issue_registry = SimpleNamespace(
            async_get_issue=Mock(
                return_value=SimpleNamespace(
                    translation_placeholders={
                        "blueprint_name": "Hippo's Cover Automation",
                        "path": "/config/blueprints/automation/hippo/cover.yaml",
                    }
                )
            )
        )
        self.flow = RestoreBlueprintRepairFlow(
            self.hass,
            "local_modified_cover_automation",
            "cover_automation",
        )

    def test_issue_title_contains_the_readable_blueprint_name(self) -> None:
        repository_root = find_repository_root(Path(__file__))
        translations = json.loads(
            (
                repository_root
                / "custom_components"
                / "hippos_toolbox"
                / "translations"
                / "en.json"
            ).read_text(encoding="utf-8")
        )

        self.assertEqual(
            translations["issues"]["local_modified"]["title"],
            "Local changes in {blueprint_name}",
        )

    async def test_opening_the_repair_only_shows_the_available_choices(self) -> None:
        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            result = await self.flow.async_step_init()

        self.assertEqual(result["type"], FlowResultType.MENU)
        self.assertEqual(result["menu_options"], ["restore", "ignore"])
        self.manager.async_restore_blueprint.assert_not_awaited()

    async def test_restore_requires_a_separate_confirmation_step(self) -> None:
        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            confirmation = await self.flow.async_step_restore()

        self.assertEqual(confirmation["type"], FlowResultType.FORM)
        self.assertEqual(confirmation["step_id"], "restore")
        self.manager.async_check_restore_compatibility.assert_awaited_once_with(
            "cover_automation"
        )
        self.manager.async_restore_blueprint.assert_not_awaited()

        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            result = await self.flow.async_step_restore({})

        self.assertEqual(result["type"], FlowResultType.CREATE_ENTRY)
        self.manager.async_restore_blueprint.assert_awaited_once_with(
            "cover_automation"
        )
        self.coordinator.async_request_refresh.assert_awaited_once()

    async def test_direct_restore_submission_cannot_bypass_the_check(self) -> None:
        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            result = await self.flow.async_step_restore({})

        self.assertEqual(result["type"], FlowResultType.FORM)
        self.manager.async_check_restore_compatibility.assert_awaited_once_with(
            "cover_automation"
        )
        self.manager.async_restore_blueprint.assert_not_awaited()

    async def test_affected_automations_require_explicit_acknowledgement(
        self,
    ) -> None:
        self.manager.async_check_restore_compatibility.return_value = (
            AffectedAutomation(
                name="Garden watering",
                automation_id="garden_watering",
                missing_inputs=("rain_sensor", "temperature_sensor"),
            ),
        )

        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            warning = await self.flow.async_step_restore()

        self.assertEqual(warning["type"], FlowResultType.FORM)
        self.assertEqual(
            warning["step_id"], "restore_with_compatibility_warning"
        )
        self.assertIn(
            "Garden watering",
            warning["description_placeholders"]["affected_automations"],
        )
        self.manager.async_restore_blueprint.assert_not_awaited()

        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            rejected = (
                await self.flow.async_step_restore_with_compatibility_warning(
                    {"confirm_compatibility": False}
                )
            )

        self.assertEqual(rejected["type"], FlowResultType.FORM)
        self.assertEqual(
            rejected["errors"],
            {"confirm_compatibility": "confirmation_required"},
        )
        self.manager.async_restore_blueprint.assert_not_awaited()

        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            accepted = (
                await self.flow.async_step_restore_with_compatibility_warning(
                    {"confirm_compatibility": True}
                )
            )

        self.assertEqual(accepted["type"], FlowResultType.CREATE_ENTRY)
        self.manager.async_restore_blueprint.assert_awaited_once_with(
            "cover_automation"
        )

    async def test_check_failure_aborts_without_offering_replacement(self) -> None:
        self.manager.async_check_restore_compatibility.side_effect = (
            RuntimeError("invalid YAML at automations.yaml, line 12")
        )

        with patch(
            "custom_components.hippos_toolbox.repairs.ir.async_get",
            return_value=self.issue_registry,
        ):
            result = await self.flow.async_step_restore()

        self.assertEqual(result["type"], FlowResultType.ABORT)
        self.assertEqual(result["reason"], "compatibility_check_failed")
        self.assertEqual(
            result["description_placeholders"]["error"],
            "invalid YAML at automations.yaml, line 12",
        )
        self.manager.async_restore_blueprint.assert_not_awaited()
        self.coordinator.async_request_refresh.assert_not_awaited()

    async def test_keep_local_version_ignores_the_issue_without_restoring(self) -> None:
        with (
            patch(
                "custom_components.hippos_toolbox.repairs.ir.async_get",
                return_value=self.issue_registry,
            ),
            patch(
                "custom_components.hippos_toolbox.repairs.ir.async_ignore_issue"
            ) as ignore_issue,
        ):
            result = await self.flow.async_step_ignore()

        self.assertEqual(result["type"], FlowResultType.ABORT)
        ignore_issue.assert_called_once_with(
            self.hass,
            "hippos_toolbox",
            "local_modified_cover_automation",
            True,
        )
        self.manager.async_restore_blueprint.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
