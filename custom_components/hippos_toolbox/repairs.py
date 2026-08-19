"""Repair flows for managed blueprint conflicts."""

import logging
import re
from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import issue_registry as ir, selector

from .const import DOMAIN
from .models import AffectedAutomation

LOCAL_MODIFIED_PREFIX = "local_modified_"
_CONF_CONFIRM_COMPATIBILITY = "confirm_compatibility"
_LOGGER = logging.getLogger(__name__)


async def async_create_fix_flow(
    hass: HomeAssistant,
    issue_id: str,
    data: dict[str, str | int | float | None] | None,
) -> RepairsFlow:
    """Create a repair flow for a local blueprint conflict."""

    if not issue_id.startswith(LOCAL_MODIFIED_PREFIX):
        raise HomeAssistantError(f"Unsupported repair issue: {issue_id}")

    return RestoreBlueprintRepairFlow(
        hass,
        issue_id,
        issue_id.removeprefix(LOCAL_MODIFIED_PREFIX),
    )


class RestoreBlueprintRepairFlow(RepairsFlow):
    """Confirm replacement of a locally modified blueprint."""

    def __init__(
        self, hass: HomeAssistant, issue_id: str, blueprint_id: str
    ) -> None:
        """Initialize the repair flow."""

        super().__init__()
        self.hass = hass
        self._issue_id = issue_id
        self._blueprint_id = blueprint_id
        self._affected_automations: tuple[AffectedAutomation, ...] | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Ask how the locally modified blueprint should be handled."""

        return self.async_show_menu(
            step_id="init",
            menu_options=["restore", "ignore"],
            description_placeholders=self._description_placeholders,
        )

    async def async_step_restore(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Restore the published blueprint after explicit confirmation."""

        if user_input is not None:
            # A submitted restore must never bypass the compatibility step,
            # including if a caller posts directly to this step ID.
            if self._affected_automations is None:
                return await self.async_step_restore()
            if self._affected_automations:
                return await self.async_step_restore_with_compatibility_warning(
                    user_input
                )
            return await self._async_restore()

        runtime_data = self._runtime_data
        if runtime_data is None:
            return self.async_abort(reason="integration_not_configured")

        try:
            self._affected_automations = (
                await runtime_data.manager.async_check_restore_compatibility(
                    self._blueprint_id
                )
            )
        # Any checker failure makes the prediction incomplete, so fail closed
        # while preserving the Repair for a later retry.
        except Exception as err:
            _LOGGER.warning(
                "Could not check compatibility before restoring blueprint %s",
                self._blueprint_id,
                exc_info=True,
            )
            return self.async_abort(
                reason="compatibility_check_failed",
                description_placeholders={
                    **self._description_placeholders,
                    "error": _code_block_value(err),
                },
            )

        if self._affected_automations:
            return await self.async_step_restore_with_compatibility_warning()

        return self.async_show_form(
            step_id="restore",
            data_schema=vol.Schema({}),
            description_placeholders=self._description_placeholders,
            last_step=True,
        )

    async def async_step_restore_with_compatibility_warning(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Require acknowledgement of automations that will become invalid."""

        if self._affected_automations is None:
            return await self.async_step_restore()

        errors: dict[str, str] = {}
        if user_input is not None:
            if user_input.get(_CONF_CONFIRM_COMPATIBILITY) is True:
                return await self._async_restore()
            errors[_CONF_CONFIRM_COMPATIBILITY] = "confirmation_required"

        return self.async_show_form(
            step_id="restore_with_compatibility_warning",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        _CONF_CONFIRM_COMPATIBILITY, default=False
                    ): selector.BooleanSelector()
                }
            ),
            errors=errors,
            description_placeholders=self._compatibility_placeholders,
            last_step=True,
        )

    async def async_step_ignore(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Keep the local blueprint and ignore this issue."""

        ir.async_ignore_issue(self.hass, DOMAIN, self._issue_id, True)
        return self.async_abort(
            reason="issue_ignored",
            description_placeholders=self._description_placeholders,
        )

    async def _async_restore(self) -> FlowResult:
        runtime_data = self._runtime_data
        if runtime_data is None:
            return self.async_abort(reason="integration_not_configured")

        restored = await runtime_data.manager.async_restore_blueprint(
            self._blueprint_id
        )
        await runtime_data.coordinator.async_request_refresh()
        if not restored:
            return self.async_abort(
                reason="migration_incomplete",
                description_placeholders=self._description_placeholders,
            )
        return self.async_create_entry(title="", data={})

    @property
    def _runtime_data(self) -> Any | None:
        entries = self.hass.config_entries.async_entries(DOMAIN)
        return entries[0].runtime_data if entries else None

    @property
    def _compatibility_placeholders(self) -> dict[str, str]:
        affected = self._affected_automations or ()
        lines: list[str] = []
        for automation in affected:
            automation_id = (
                f" (`{automation.automation_id}`)"
                if automation.automation_id is not None
                else ""
            )
            missing_inputs = ", ".join(
                f"`{input_name}`" for input_name in automation.missing_inputs
            )
            lines.append(
                f"- **{_markdown_text(automation.name)}**{automation_id}\n"
                f"  Missing: {missing_inputs}"
            )

        return {
            **self._description_placeholders,
            "affected_automation_count": str(len(affected)),
            "affected_automation_noun": (
                "automation" if len(affected) == 1 else "automations"
            ),
            "affected_automations": "\n".join(lines),
        }

    @property
    def _description_placeholders(self) -> dict[str, str]:
        issue = ir.async_get(self.hass).async_get_issue(DOMAIN, self._issue_id)
        if issue is not None and issue.translation_placeholders is not None:
            return issue.translation_placeholders
        return {
            "blueprint_name": self._blueprint_id,
            "path": self._blueprint_id,
        }


def _markdown_text(value: str) -> str:
    """Escape an automation name embedded in generated Markdown."""

    single_line = " ".join(value.splitlines())
    return re.sub(r"([\\`*_{}\[\]<>()#+\-.!|])", r"\\\1", single_line)


def _code_block_value(error: Exception) -> str:
    """Keep an error readable without allowing it to close a Markdown fence."""

    value = str(error) or type(error).__name__
    return value.replace("```", "'''")
