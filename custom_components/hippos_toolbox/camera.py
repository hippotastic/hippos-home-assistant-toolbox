"""Camera platform for progressive snapshot helpers."""

from typing import cast

from aiohttp import web

from homeassistant.components.camera import Camera
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONTENT_TYPE_MULTIPART
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device import async_entity_id_to_device
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import ToolboxConfigEntry
from .const import (
    CONF_SOURCE_ENTITY_ID,
    DOMAIN,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)
from .progressive_camera import _FrameQueue, _ProgressiveCameraManager

_BOUNDARY = "frameboundary"
_ACCESS_TOKEN_STORE = f"{DOMAIN}.progressive_camera_access_tokens"

type _AccessTokenStore = dict[str, tuple[str, ...]]


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
    """Expose a cached snapshot and publish refreshes as an MJPEG stream."""

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

    async def async_added_to_hass(self) -> None:
        """Update Home Assistant state when source or cache status changes."""

        await super().async_added_to_hass()
        self.async_on_remove(
            self._manager.async_add_listener(
                self._subentry_id, self.async_write_ha_state
            )
        )

    async def async_will_remove_from_hass(self) -> None:
        """Keep current access tokens valid across a config-entry reload."""

        _access_token_store(self._token_store_hass)[self._subentry_id] = tuple(
            self.access_tokens
        )
        await super().async_will_remove_from_hass()

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
