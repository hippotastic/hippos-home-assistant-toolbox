"""Repair flows for managed blueprint conflicts."""

from typing import Any

import voluptuous as vol

from homeassistant.components.repairs import RepairsFlow
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.exceptions import HomeAssistantError

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
        issue_id.removeprefix(LOCAL_MODIFIED_PREFIX),
    )


class RestoreBlueprintRepairFlow(RepairsFlow):
    """Confirm replacement of a locally modified blueprint."""

    def __init__(self, hass: HomeAssistant, blueprint_id: str) -> None:
        """Initialize the repair flow."""

        self.hass = hass
        self._blueprint_id = blueprint_id

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Restore the published blueprint after explicit confirmation."""

        if user_input is not None:
            entries = self.hass.config_entries.async_entries(DOMAIN)
            if not entries:
                return self.async_abort(reason="integration_not_configured")

            runtime_data = entries[0].runtime_data
            await runtime_data.manager.async_restore_blueprint(self._blueprint_id)
            await runtime_data.coordinator.async_request_refresh()
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({}),
            description_placeholders={"blueprint_id": self._blueprint_id},
        )
