"""Camera platform for progressive cameras."""

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, cast

from aiohttp import UnixConnector, web
from webrtc_models import RTCIceCandidateInit

from homeassistant.components.camera import (
    Camera,
    CameraEntityFeature,
    CameraWebRTCProvider,
    StreamType,
    WebRTCClientConfiguration,
    WebRTCSendMessage,
)
from homeassistant.components.camera.helper import get_camera_from_entity_id
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONTENT_TYPE_MULTIPART, EVENT_HOMEASSISTANT_STOP
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device import async_entity_id_to_device
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from . import ToolboxConfigEntry
from .camera_relay import _CameraRelay
from .camera_stream import async_setup_camera_streams
from .const import (
    CONF_SOURCE_ENTITY_ID,
    DOMAIN,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)
from .progressive_camera import _FrameQueue, _ProgressiveCameraManager

if TYPE_CHECKING:
    from homeassistant.components.camera import CameraEntityCapabilities

_BOUNDARY = "frameboundary"
_ACCESS_TOKEN_STORE = f"{DOMAIN}.progressive_camera_access_tokens"

type _AccessTokenStore = dict[str, tuple[str, ...]]


@dataclass(slots=True)
class _WebRTCSession:
    source: Camera
    provider: CameraWebRTCProvider | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)

    def close(self, session_id: str) -> None:
        self.ready.set()
        if self.provider is not None:
            self.provider.async_close_session(session_id)
        else:
            self.source.close_webrtc_session(session_id)


def _access_token_store(hass: HomeAssistant) -> _AccessTokenStore:
    """Return reload-safe camera tokens kept only for this HA process."""

    return cast(
        _AccessTokenStore,
        hass.data.setdefault(_ACCESS_TOKEN_STORE, {}),
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ToolboxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one proxy entity for every camera config subentry."""

    async_setup_camera_streams(hass)
    manager = entry.runtime_data.progressive_camera_manager
    subentries = tuple(
        subentry
        for subentry in entry.subentries.values()
        if subentry.subentry_type == PROGRESSIVE_CAMERA_SUBENTRY_TYPE
    )
    token_store = _access_token_store(hass)
    active_subentry_ids = {subentry.subentry_id for subentry in subentries}
    for removed_subentry_id in token_store.keys() - active_subentry_ids:
        del token_store[removed_subentry_id]

    for subentry in subentries:
        async_add_entities(
            [_ProgressiveSnapshotCamera(hass, manager, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class _ProgressiveSnapshotCamera(Camera):
    """Expose a cached snapshot and the best live view available from the source."""

    _attr_should_poll = False

    def __init__(
        self,
        hass: HomeAssistant,
        manager: _ProgressiveCameraManager,
        subentry: ConfigSubentry,
    ) -> None:
        super().__init__()
        self._token_store_hass = hass
        self._manager = manager
        self._subentry_id = subentry.subentry_id
        self._source_entity_id = str(subentry.data[CONF_SOURCE_ENTITY_ID])
        self._relay = _CameraRelay(hass, subentry.data)
        self._relay_url: str | None = None
        self._sessions: dict[str, _WebRTCSession] = {}
        if previous_tokens := _access_token_store(hass).get(self._subentry_id):
            # A config-subentry change reloads every toolbox camera. Retaining
            # the existing deque avoids invalidating in-flight thumbnail URLs.
            self.access_tokens.clear()
            self.access_tokens.extend(previous_tokens)
        self._attr_unique_id = subentry.subentry_id
        self._attr_name = subentry.title
        self.content_type = "image/jpeg"
        self.device_entry = async_entity_id_to_device(
            hass, self._source_entity_id
        )

    @property
    def available(self) -> bool:
        """Remain available while the source or a cached frame is available."""

        return self._manager.is_available(self._subentry_id)

    def _source_camera(self) -> Camera | None:
        try:
            return get_camera_from_entity_id(
                self._token_store_hass, self._source_entity_id
            )
        except HomeAssistantError:
            return None

    @property
    def supported_features(self) -> CameraEntityFeature:
        source = self._source_camera()
        if source and StreamType.WEB_RTC in source.camera_capabilities.frontend_stream_types:
            return CameraEntityFeature.STREAM
        return CameraEntityFeature(0)

    @property
    def camera_entity_capabilities(self) -> "CameraEntityCapabilities | None":
        source = self._source_camera()
        # Two-way audio capabilities first appeared after the Toolbox's HA minimum.
        return getattr(
            source, "camera_entity_capabilities",
            getattr(super(), "camera_entity_capabilities", None),
        )

    async def async_added_to_hass(self) -> None:
        """Update Home Assistant state when source or cache status changes."""

        await super().async_added_to_hass()
        self.async_on_remove(
            self._manager.async_add_listener(
                self._subentry_id, self.async_write_ha_state
            )
        )
        self.async_on_remove(
            async_track_state_change_event(
                self.hass, self._source_entity_id, self._async_source_changed
            )
        )
        self.async_on_remove(
            self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._async_shutdown)
        )

    @callback
    def _async_source_changed(self, _event: Event) -> None:
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        """Keep current access tokens valid across a config-entry reload."""

        _access_token_store(self._token_store_hass)[self._subentry_id] = tuple(
            self.access_tokens
        )
        await self._async_shutdown()
        await super().async_will_remove_from_hass()

    async def _async_shutdown(self, _event: Event | None = None) -> None:
        for session_id in tuple(self._sessions):
            self.close_webrtc_session(session_id)
        await self._relay.async_stop()

    async def stream_source(self) -> str | None:
        """Give the source's go2rtc provider this camera's processed input."""

        return self._relay_url

    @callback
    def _async_get_webrtc_client_configuration(self) -> WebRTCClientConfiguration:
        source = self._source_camera()
        if source is not None:
            # HA adds the shared ICE servers to the returned configuration.
            return source._async_get_webrtc_client_configuration()
        return WebRTCClientConfiguration()

    async def async_handle_async_webrtc_offer(
        self, offer_sdp: str, session_id: str, send_message: WebRTCSendMessage
    ) -> None:
        source = self._source_camera()
        if source is None:
            raise HomeAssistantError("Camera source is unavailable")

        session = self._sessions[session_id] = _WebRTCSession(source)
        try:
            provider = getattr(
                source, "webrtc_provider", getattr(source, "_webrtc_provider", None)
            )
            # Only HA-managed go2rtc shares this process's loopback network.
            if (
                provider is not None
                and provider.domain == "go2rtc"
                and isinstance(
                    getattr(getattr(provider, "_session", None), "connector", None),
                    UnixConnector,
                )
            ):
                if url := await source.stream_source():
                    if relay_url := await self._relay.async_get_url(
                        url, getattr(self.camera_entity_capabilities, "two_way_audio", False)
                    ):
                        self._relay_url = relay_url
                        session.provider = provider

            if self._sessions.get(session_id) is not session:
                return
            if session.provider is not None:
                await session.provider.async_handle_async_webrtc_offer(
                    self, offer_sdp, session_id, send_message
                )
            else:
                await source.async_handle_async_webrtc_offer(
                    offer_sdp, session_id, send_message
                )
        except BaseException:
            self._sessions.pop(session_id, None)
            raise
        finally:
            session.ready.set()
            if self._sessions.get(session_id) is not session:
                # The offer can finish after the client has already closed the dialog.
                session.close(session_id)

    async def async_on_webrtc_candidate(
        self, session_id: str, candidate: RTCIceCandidateInit
    ) -> None:
        if (session := self._sessions.get(session_id)) is None:
            return
        # In particular, go2rtc registers the session only after opening the relay.
        await session.ready.wait()
        if self._sessions.get(session_id) is not session:
            return
        if session.provider is not None:
            await session.provider.async_on_webrtc_candidate(session_id, candidate)
        else:
            await session.source.async_on_webrtc_candidate(session_id, candidate)

    @callback
    def close_webrtc_session(self, session_id: str) -> None:
        if session := self._sessions.pop(session_id, None):
            session.close(session_id)

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Return the full-resolution RAM cache and refresh in parallel."""

        return await self._manager.async_get_frame(self._subentry_id)

    async def handle_async_mjpeg_stream(
        self, request: web.Request
    ) -> web.StreamResponse:
        """Push the cache first and relay subsequent source frames."""

        response = web.StreamResponse()
        response.content_type = CONTENT_TYPE_MULTIPART.format(f"--{_BOUNDARY}")
        await response.prepare(request)
        queue = self._manager.async_subscribe(self._subentry_id)
        first_frame = True
        try:
            while (frame := await queue.get()) is not None:
                await self._async_write_frame(response, frame)
                if first_frame:
                    # Chromium displays the previous multipart frame, so the first
                    # image must be sent twice before subsequent updates are enough.
                    await self._async_write_frame(response, frame)
                    first_frame = False
        finally:
            self._manager.async_unsubscribe(self._subentry_id, queue)
        return response

    @staticmethod
    async def _async_write_frame(
        response: web.StreamResponse, frame: bytes
    ) -> None:
        header = (
            f"--{_BOUNDARY}\r\n"
            "Content-Type: image/jpeg\r\n"
            f"Content-Length: {len(frame)}\r\n\r\n"
        ).encode()
        # Keep large JPEG payloads out of a concatenated temporary bytes object.
        await response.write(header)
        await response.write(frame)
        await response.write(b"\r\n")
