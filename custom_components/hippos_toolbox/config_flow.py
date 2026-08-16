"""Config flow for Hippo's Home Assistant Toolbox."""

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.components.camera import DOMAIN as CAMERA_DOMAIN
from homeassistant.const import CONF_NAME
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import entity_registry as er, selector

from .const import (
    CONF_SOURCE_ENTITY_ID,
    CONF_UPDATE_CHANNEL,
    DEFAULT_UPDATE_CHANNEL,
    DOMAIN,
    NAME,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
    UPDATE_CHANNEL_DEVELOPMENT,
    UPDATE_CHANNEL_STABLE,
    normalize_update_channel,
)


class ToolboxConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single toolbox config entry."""

    VERSION = 1

    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry: config_entries.ConfigEntry
    ) -> dict[str, type[config_entries.ConfigSubentryFlow]]:
        """Return the helper types that can be added to the toolbox entry."""

        return {
            PROGRESSIVE_CAMERA_SUBENTRY_TYPE: ProgressiveCameraSubentryFlow
        }

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


class ToolboxOptionsFlow(config_entries.OptionsFlow):
    """Configure optional blueprint update behavior."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Select the update channel and reload after changes."""

        if user_input is not None:
            return self.async_create_entry(data=user_input)

        current_channel = normalize_update_channel(
            self.config_entry.options.get(
                CONF_UPDATE_CHANNEL, DEFAULT_UPDATE_CHANNEL
            )
        )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_UPDATE_CHANNEL, default=current_channel
                    ): vol.In(
                        {
                            UPDATE_CHANNEL_STABLE: "Stable",
                            UPDATE_CHANNEL_DEVELOPMENT: "Development",
                        }
                    )
                }
            ),
        )


class ProgressiveCameraSubentryFlow(config_entries.ConfigSubentryFlow):
    """Add and reconfigure a progressive snapshot camera."""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Create a camera helper from an existing camera entity."""

        return self._async_handle_form("user", user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Change the source or display name of an existing helper."""

        return self._async_handle_form("reconfigure", user_input)

    @callback
    def _async_handle_form(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> FlowResult:
        entry = self._get_entry()
        current_subentry = (
            self._get_reconfigure_subentry()
            if step_id == "reconfigure"
            else None
        )
        errors: dict[str, str] = {}

        if user_input is not None:
            name = str(user_input[CONF_NAME]).strip()
            source_entity_id = str(user_input[CONF_SOURCE_ENTITY_ID])

            if not name:
                errors[CONF_NAME] = "invalid_name"
            elif source_error := self._source_validation_error(source_entity_id):
                errors[CONF_SOURCE_ENTITY_ID] = source_error
            elif any(
                subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
                and subentry.subentry_id
                != (
                    current_subentry.subentry_id
                    if current_subentry is not None
                    else None
                )
                and subentry.data.get(CONF_SOURCE_ENTITY_ID) == source_entity_id
                for subentry in entry.subentries.values()
            ):
                errors[CONF_SOURCE_ENTITY_ID] = "duplicate_source"

            if not errors:
                data = {CONF_SOURCE_ENTITY_ID: source_entity_id}
                if current_subentry is not None:
                    return self.async_update_and_abort(
                        entry,
                        current_subentry,
                        title=name,
                        data=data,
                    )
                return self.async_create_entry(title=name, data=data)

        default_name = (
            current_subentry.title if current_subentry is not None else ""
        )
        default_source = (
            current_subentry.data[CONF_SOURCE_ENTITY_ID]
            if current_subentry is not None
            else vol.UNDEFINED
        )
        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME, default=default_name): selector.TextSelector(),
                    vol.Required(
                        CONF_SOURCE_ENTITY_ID, default=default_source
                    ): selector.EntitySelector(
                        selector.EntitySelectorConfig(domain=CAMERA_DOMAIN)
                    ),
                }
            ),
            errors=errors,
        )

    @callback
    def _source_validation_error(self, entity_id: str) -> str | None:
        registry_entry = er.async_get(self.hass).async_get(entity_id)
        if not entity_id.startswith(f"{CAMERA_DOMAIN}.") or registry_entry is None:
            return "invalid_source"
        if registry_entry.platform == DOMAIN:
            return "source_is_progressive_camera"
        return None
