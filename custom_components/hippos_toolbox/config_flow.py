"""Config flow for Hippo's Home Assistant Toolbox."""

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_RELEASE_CHANNEL,
    DEFAULT_RELEASE_CHANNEL,
    DOMAIN,
    NAME,
    RELEASE_CHANNEL_BETA,
    RELEASE_CHANNEL_STABLE,
)


class ToolboxConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single toolbox config entry."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Return the options flow without adding choices to initial setup."""

        return ToolboxOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Confirm setup without requiring configuration values."""

        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        if user_input is not None:
            return self.async_create_entry(title=NAME, data={})

        return self.async_show_form(step_id="user")


class ToolboxOptionsFlow(config_entries.OptionsFlowWithReload):
    """Configure optional blueprint update behavior."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Select the release channel and reload after changes."""

        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current_channel = self.config_entry.options.get(
            CONF_RELEASE_CHANNEL, DEFAULT_RELEASE_CHANNEL
        )
        if current_channel not in (
            RELEASE_CHANNEL_STABLE,
            RELEASE_CHANNEL_BETA,
        ):
            current_channel = DEFAULT_RELEASE_CHANNEL

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_RELEASE_CHANNEL, default=current_channel
                    ): vol.In(
                        {
                            RELEASE_CHANNEL_STABLE: "Stable",
                            RELEASE_CHANNEL_BETA: "Beta",
                        }
                    )
                }
            ),
        )
