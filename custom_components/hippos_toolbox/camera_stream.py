"""Close individual native MJPEG responses through the existing HA WebSocket."""

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
import secrets
from typing import Any

from aiohttp import web
import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import camera, websocket_api
from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.http.const import KEY_HASS_USER
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv

from .const import CONF_CAMERA_STREAM_CLEANUP, DATA_CAMERA_FRONTEND, DOMAIN

_DATA_KEY = f"{DOMAIN}.camera_streams"
_STREAM_PATH = f"/api/{DOMAIN}/camera_stream"
_OPEN_COMMAND = f"{DOMAIN}/camera_stream/open"
_STOP_COMMAND = f"{DOMAIN}/camera_stream/stop"
_OPEN_TIMEOUT = 30


@dataclass(slots=True)
class _CameraStreamSession:
    entity_id: str
    connection: websocket_api.ActiveConnection
    expires: asyncio.TimerHandle | None = None
    request: web.Request | None = None
    task: asyncio.Task | None = None


type _CameraStreamSessions = dict[str, _CameraStreamSession]


@callback
def _stop_session(
    sessions: _CameraStreamSessions, stream_id: str, *, unsubscribe: bool = True
) -> bool:
    """Close only this HTTP response and release its upstream camera subscriber."""

    if (session := sessions.pop(stream_id, None)) is None:
        return False
    if session.expires is not None:
        session.expires.cancel()
    # HA iterates subscriptions during WebSocket shutdown; do not mutate that
    # dictionary from a shutdown callback. HA clears it after the iteration.
    if unsubscribe:
        session.connection.subscriptions.pop((_DATA_KEY, stream_id), None)
    if session.request is not None and session.request.transport is not None:
        session.request.transport.close()
    if session.task is not None and session.task is not asyncio.current_task():
        session.task.cancel()
    return True


class _CameraStreamView(camera.CameraMjpegStream):
    """Keep HA's authentication and platform-specific MJPEG implementation."""

    url = f"{_STREAM_PATH}/{{entity_id}}"
    name = f"api:{DOMAIN}:camera_stream"
    requires_auth = True

    def __init__(self, component, sessions: _CameraStreamSessions) -> None:
        super().__init__(component)
        self._sessions = sessions

    async def handle(self, request: web.Request, entity: camera.Camera) -> web.StreamResponse:
        stream_id = request.query.get("stream_id", "")
        session = self._sessions.get(stream_id)
        user = request[KEY_HASS_USER]
        if (
            session is None or session.entity_id != entity.entity_id
            or session.connection.user.id != user.id
        ):
            raise web.HTTPNotFound
        # A signed URL is single-use. Two views of the same camera get separate
        # sessions, so removing one cannot interrupt the other.
        if session.request is not None:
            raise web.HTTPConflict
        session.request = request
        session.task = asyncio.current_task()
        if session.expires is not None:
            session.expires.cancel()
        try:
            return await super().handle(request, entity)
        finally:
            _stop_session(self._sessions, stream_id)


@callback
def async_setup_camera_streams(hass: HomeAssistant) -> None:
    """Register native stream lifecycle control once across config-entry reloads."""

    if _DATA_KEY in hass.data:
        return
    sessions: _CameraStreamSessions = {}
    hass.data[_DATA_KEY] = sessions
    component = hass.data[camera.DATA_COMPONENT]
    hass.http.register_view(_CameraStreamView(component, sessions))

    @callback
    @websocket_api.websocket_command(
        {
            vol.Required("type"): _OPEN_COMMAND,
            vol.Required("entity_id"): cv.entity_id,
            vol.Optional("interval"): cv.positive_float,
        }
    )
    def open_stream(hass, connection, msg: dict[str, Any]) -> None:
        frontend = hass.data.get(DATA_CAMERA_FRONTEND)
        if frontend is None or not frontend.settings[CONF_CAMERA_STREAM_CLEANUP]:
            connection.send_error(msg["id"], "feature_disabled", "Camera stream cleanup is disabled")
            return
        entity_id = msg["entity_id"]
        if not connection.user.permissions.check_entity(entity_id, POLICY_READ):
            connection.send_error(msg["id"], "unauthorized", "Camera access denied")
            return
        if component.get_entity(entity_id) is None:
            connection.send_error(msg["id"], "not_found", "Camera not found")
            return
        stream_id = secrets.token_hex(16)
        session = sessions[stream_id] = _CameraStreamSession(entity_id, connection)
        connection.subscriptions[(_DATA_KEY, stream_id)] = partial(
            _stop_session, sessions, stream_id, unsubscribe=False
        )
        # Closing before HTTP starts removes the reservation, so a late request
        # cannot resurrect an abandoned stream. Unused reservations expire too.
        session.expires = hass.loop.call_later(
            _OPEN_TIMEOUT, _stop_session, sessions, stream_id
        )
        path = f"{_STREAM_PATH}/{entity_id}?stream_id={stream_id}"
        if "interval" in msg:
            path += f"&interval={msg['interval']}"
        path = async_sign_path(
            hass,
            path,
            timedelta(seconds=_OPEN_TIMEOUT),
            refresh_token_id=connection.refresh_token_id,
        )
        connection.send_result(msg["id"], {"stream_id": stream_id, "path": path})

    @callback
    @websocket_api.websocket_command(
        {vol.Required("type"): _STOP_COMMAND, vol.Required("stream_id"): cv.string}
    )
    def stop_stream(hass, connection, msg: dict[str, Any]) -> None:
        stream_id = msg["stream_id"]
        session = sessions.get(stream_id)
        if session is not None and session.connection is not connection:
            connection.send_error(msg["id"], "unauthorized", "Stream belongs to another connection")
            return
        connection.send_result(msg["id"], {"stopped": _stop_session(sessions, stream_id)})

    websocket_api.async_register_command(hass, open_stream)
    websocket_api.async_register_command(hass, stop_stream)


@callback
def async_stop_camera_streams(hass: HomeAssistant) -> None:
    """Release remaining sessions when disabling or unloading the feature."""

    sessions = hass.data.get(_DATA_KEY, {})
    for stream_id in tuple(sessions):
        _stop_session(sessions, stream_id)
