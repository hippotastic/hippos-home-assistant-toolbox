"""Serve the camera bundle and publish its non-sensitive feature switches."""

from dataclasses import dataclass, field
from hashlib import sha256
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback

from .const import CAMERA_FRONTEND_OPTIONS, CAMERA_FRONTEND_PROTOCOL, DATA_CAMERA_FRONTEND, DOMAIN

_DATA_KEY = DATA_CAMERA_FRONTEND
_BUNDLE_PATH = f"/{DOMAIN}/frontend/cameras.js"
_SUBSCRIBE_COMMAND = f"{DOMAIN}/frontend/subscribe"
_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _FrontendState:
    settings: dict[str, bool] = field(
        default_factory=lambda: dict.fromkeys(CAMERA_FRONTEND_OPTIONS, False)
    )
    subscribers: set[tuple[websocket_api.ActiveConnection, int]] = field(default_factory=set)
    url: str | None = None


@callback
def async_setup_frontend(hass: HomeAssistant) -> None:
    """Register once; subscriptions survive config-entry reloads."""

    if _DATA_KEY in hass.data:
        return
    state = hass.data[_DATA_KEY] = _FrontendState()

    @callback
    @websocket_api.websocket_command({"type": _SUBSCRIBE_COMMAND, vol.Optional("protocol"): int})
    def subscribe(hass, connection, msg: dict[str, Any]) -> None:
        if type(msg.get("protocol")) is not int or msg["protocol"] != CAMERA_FRONTEND_PROTOCOL:
            connection.send_error(msg["id"], "incompatible_version", "Unsupported camera frontend protocol")
            return
        subscriber = (connection, msg["id"])
        state.subscribers.add(subscriber)
        connection.subscriptions[msg["id"]] = lambda: state.subscribers.discard(subscriber)
        connection.send_result(msg["id"])
        connection.send_event(msg["id"], {"protocol": CAMERA_FRONTEND_PROTOCOL, **state.settings})

    websocket_api.async_register_command(hass, subscribe)


@callback
def async_update_frontend(hass: HomeAssistant, entry: ConfigEntry | None) -> None:
    """Push the protocol and three public booleans, never the config entry itself."""

    state = hass.data[_DATA_KEY]
    settings = {
        option: bool(entry.options.get(option, True)) if entry is not None else False
        for option in CAMERA_FRONTEND_OPTIONS
    }
    if state.settings == settings:
        return
    state.settings = settings
    for connection, message_id in tuple(state.subscribers):
        connection.send_event(message_id, {"protocol": CAMERA_FRONTEND_PROTOCOL, **settings})


async def async_setup_entry_frontend(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Load one content-versioned module through HA's frontend extension API."""

    state = hass.data[_DATA_KEY]
    try:
        if state.url is None:
            bundle = Path(__file__).parent / "frontend" / "cameras.js"
            content = await hass.async_add_executor_job(bundle.read_bytes)
            await hass.http.async_register_static_paths([
                StaticPathConfig(_BUNDLE_PATH, str(bundle), True)
            ])
            state.url = f"{_BUNDLE_PATH}?v={sha256(content).hexdigest()[:12]}"
        frontend.add_extra_js_url(hass, state.url)
    except Exception:  # Optional enhancements must not prevent backend setup.
        async_update_frontend(hass, None)
        _LOGGER.warning("Camera frontend could not be loaded; using Home Assistant's native viewer", exc_info=True)
        return
    async_update_frontend(hass, entry)


@callback
def async_unload_frontend(hass: HomeAssistant) -> None:
    """Turn off connected clients and stop loading the bundle in new clients."""

    state = hass.data[_DATA_KEY]
    async_update_frontend(hass, None)
    if state.url is not None:
        frontend.remove_extra_js_url(hass, state.url)
