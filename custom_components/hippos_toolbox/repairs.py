"""Repair flows for managed blueprint conflicts."""

from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN

LOCAL_MODIFIED_PREFIX = "local_modified_"


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
            entries = self.hass.config_entries.async_entries(DOMAIN)
            if not entries:
                return self.async_abort(reason="integration_not_configured")

            runtime_data = entries[0].runtime_data
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

        return self.async_show_form(
            step_id="restore",
            data_schema=vol.Schema({}),
            description_placeholders=self._description_placeholders,
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

    @property
    def _description_placeholders(self) -> dict[str, str]:
        issue = ir.async_get(self.hass).async_get_issue(DOMAIN, self._issue_id)
        if issue is not None and issue.translation_placeholders is not None:
            return issue.translation_placeholders
        return {
            "blueprint_name": self._blueprint_id,
            "path": self._blueprint_id,
        }
