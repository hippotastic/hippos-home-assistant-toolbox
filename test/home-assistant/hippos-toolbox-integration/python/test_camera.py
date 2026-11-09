"""Regression tests for the progressive camera entity and MJPEG response."""

import asyncio
from types import MappingProxyType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import UnixConnector

from homeassistant import config_entries
from homeassistant.components.camera import CameraEntityFeature, StreamType

from custom_components.hippos_toolbox.camera import (
    _ProgressiveSnapshotCamera,
    _access_token_store,
    async_setup_entry,
)
from custom_components.hippos_toolbox.const import (
    CONF_SOURCE_ENTITY_ID,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)


class _Manager:
    def __init__(
        self,
        frames: tuple[bytes, ...] = (),
        *,
        source_available: bool = True,
    ) -> None:
        self.frames = frames
        self.source_available = source_available
        self.unsubscribed = False

    def is_available(self, _subentry_id):
        return self.source_available or bool(self.frames)

    def async_subscribe(self, _subentry_id):
        queue = asyncio.Queue()
        for frame in self.frames:
            queue.put_nowait(frame)
        queue.put_nowait(None)
        return queue

    def async_unsubscribe(self, _subentry_id, _queue):
        self.unsubscribed = True


class _Response:
    def __init__(self) -> None:
        self.content_type = ""
        self.writes: list[bytes] = []

    async def prepare(self, _request) -> None:
        return None

    async def write(self, content: bytes) -> None:
        self.writes.append(content)


def _subentry() -> config_entries.ConfigSubentry:
    return config_entries.ConfigSubentry(
        data=MappingProxyType(
            {CONF_SOURCE_ENTITY_ID: "camera.front_door_snapshot"}
        ),
        subentry_id="progressive-front-door",
        subentry_type=PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
        title="Front door",
        unique_id=None,
    )


def _hass() -> SimpleNamespace:
    return SimpleNamespace(data={})


class ProgressiveSnapshotCameraTests(unittest.IsolatedAsyncioTestCase):
    """Verify entity identity and the cache-to-fresh multipart sequence."""

    async def test_stream_sends_first_frame_twice_and_updates_once(self) -> None:
        manager = _Manager((b"cached", b"fresh"))
        response = _Response()

        with (
            patch(
                "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
                return_value=SimpleNamespace(id="source-device"),
            ),
            patch(
                "custom_components.hippos_toolbox.camera.web.StreamResponse",
                return_value=response,
            ),
        ):
            camera = _ProgressiveSnapshotCamera(_hass(), manager, _subentry())
            returned = await camera.handle_async_mjpeg_stream(SimpleNamespace())

        self.assertIs(returned, response)
        self.assertTrue(manager.unsubscribed)
        payload = b"".join(response.writes)
        self.assertEqual(payload.count(b"cached"), 2)
        self.assertEqual(payload.count(b"fresh"), 1)
        self.assertEqual(payload.count(b"--frameboundary\r\n"), 3)
        self.assertIn(b"Content-Length: 5", payload)

    async def test_entity_is_linked_to_source_without_stream_feature(self) -> None:
        source_device = SimpleNamespace(id="source-device")
        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=source_device,
        ):
            camera = _ProgressiveSnapshotCamera(
                _hass(), _Manager((b"cached",)), _subentry()
            )

        self.assertEqual(camera.unique_id, "progressive-front-door")
        self.assertEqual(camera.name, "Front door")
        self.assertIs(camera.device_entry, source_device)
        self.assertNotIn(CameraEntityFeature.STREAM, camera.supported_features)
        self.assertTrue(camera.available)

    async def test_entity_is_available_before_its_first_frame(self) -> None:
        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=SimpleNamespace(id="source-device"),
        ):
            camera = _ProgressiveSnapshotCamera(_hass(), _Manager(), _subentry())

        self.assertTrue(camera.available)
        self.assertIn("access_token", camera.state_attributes)

    async def test_webrtc_passthrough_for_native_and_external_providers(self) -> None:
        source = SimpleNamespace(
            camera_capabilities=SimpleNamespace(frontend_stream_types={StreamType.WEB_RTC}),
            async_handle_async_webrtc_offer=AsyncMock(),
            async_on_webrtc_candidate=AsyncMock(),
            close_webrtc_session=Mock(),
        )
        with (
            patch("custom_components.hippos_toolbox.camera.async_entity_id_to_device"),
            patch("custom_components.hippos_toolbox.camera.get_camera_from_entity_id", return_value=source),
        ):
            camera = _ProgressiveSnapshotCamera(_hass(), _Manager(), _subentry())
            self.assertIn(CameraEntityFeature.STREAM, camera.supported_features)
            send = Mock()
            for provider in (None, SimpleNamespace(domain="go2rtc")):
                source.webrtc_provider = provider
                await camera.async_handle_async_webrtc_offer("offer", "session", send)
                await camera.async_on_webrtc_candidate("session", "candidate")
                camera.close_webrtc_session("session")
                await camera.async_on_webrtc_candidate("session", "too late")
                source.async_handle_async_webrtc_offer.assert_awaited_once_with("offer", "session", send)
                source.async_on_webrtc_candidate.assert_awaited_once_with("session", "candidate")
                source.close_webrtc_session.assert_called_once_with("session")
                source.async_handle_async_webrtc_offer.reset_mock()
                source.async_on_webrtc_candidate.reset_mock()
                source.close_webrtc_session.reset_mock()

    async def test_go2rtc_receives_relay_url_and_early_ice_waits_for_offer(self) -> None:
        pending = asyncio.Event()
        registered = asyncio.Event()

        async def register(camera, *_):
            self.assertEqual(await camera.stream_source(), "rtsp://127.0.0.1:9001/paced")
            pending.set()
            await registered.wait()

        provider = SimpleNamespace(
            domain="go2rtc",
            _session=SimpleNamespace(connector=Mock(spec=UnixConnector)),
            async_handle_async_webrtc_offer=AsyncMock(side_effect=register),
            async_on_webrtc_candidate=AsyncMock(),
            async_close_session=Mock(),
        )
        source = SimpleNamespace(
            webrtc_provider=provider,
            stream_source=AsyncMock(return_value="rtsp://camera.invalid/main"),
            camera_entity_capabilities=SimpleNamespace(two_way_audio=True),
        )
        with (
            patch("custom_components.hippos_toolbox.camera.async_entity_id_to_device"),
            patch("custom_components.hippos_toolbox.camera.get_camera_from_entity_id", return_value=source),
            patch(
                "custom_components.hippos_toolbox.camera_relay._CameraRelay.async_get_url",
                return_value="rtsp://127.0.0.1:9001/paced",
            ) as relay,
        ):
            camera = _ProgressiveSnapshotCamera(_hass(), _Manager(), _subentry())
            offer = asyncio.create_task(
                camera.async_handle_async_webrtc_offer("offer", "session", Mock())
            )
            await asyncio.wait_for(pending.wait(), 1)
            candidate = asyncio.create_task(
                camera.async_on_webrtc_candidate("session", "candidate")
            )
            await asyncio.sleep(0)
            provider.async_on_webrtc_candidate.assert_not_called()
            registered.set()
            await asyncio.gather(offer, candidate)
            camera.close_webrtc_session("session")
            relay.assert_awaited_once_with("rtsp://camera.invalid/main", True)

        provider.async_on_webrtc_candidate.assert_awaited_once_with("session", "candidate")
        provider.async_close_session.assert_called_once_with("session")

    async def test_cached_frame_keeps_entity_available_without_source(self) -> None:
        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=SimpleNamespace(id="source-device"),
        ):
            cached = _ProgressiveSnapshotCamera(
                _hass(),
                _Manager((b"cached",), source_available=False),
                _subentry(),
            )
            cold = _ProgressiveSnapshotCamera(
                _hass(),
                _Manager(source_available=False),
                _subentry(),
            )

        self.assertTrue(cached.available)
        self.assertFalse(cold.available)

    async def test_access_tokens_survive_reload_and_rotate_normally(self) -> None:
        hass = _hass()
        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=SimpleNamespace(id="source-device"),
        ):
            original = _ProgressiveSnapshotCamera(hass, _Manager(), _subentry())
            original.access_tokens.clear()
            original.access_tokens.extend(("previous", "current"))
            await original.async_will_remove_from_hass()

            restored = _ProgressiveSnapshotCamera(hass, _Manager(), _subentry())

        self.assertEqual(tuple(restored.access_tokens), ("previous", "current"))
        restored.async_update_token()
        self.assertEqual(restored.access_tokens[0], "current")
        self.assertEqual(len(restored.access_tokens), 2)

    async def test_platform_binds_each_entity_to_its_subentry(self) -> None:
        manager = _Manager((b"cached",))
        hass = _hass()
        _access_token_store(hass)["removed-subentry"] = ("stale",)
        subentry = _subentry()
        ignored = config_entries.ConfigSubentry(
            data=MappingProxyType({}),
            subentry_id="ignored",
            subentry_type="different_type",
            title="Ignored",
            unique_id=None,
        )
        entry = SimpleNamespace(
            runtime_data=SimpleNamespace(progressive_camera_manager=manager),
            subentries={
                subentry.subentry_id: subentry,
                ignored.subentry_id: ignored,
            },
        )
        added: list[tuple[list[object], str | None]] = []

        def add_entities(
            entities, update_before_add=False, *, config_subentry_id=None
        ) -> None:
            added.append((list(entities), config_subentry_id))

        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=SimpleNamespace(id="source-device"),
        ), patch("custom_components.hippos_toolbox.camera.async_setup_camera_streams"):
            await async_setup_entry(hass, entry, add_entities)

        self.assertEqual(len(added), 1)
        self.assertEqual(added[0][1], subentry.subentry_id)
        self.assertEqual(len(added[0][0]), 1)
        self.assertNotIn("removed-subentry", _access_token_store(hass))


if __name__ == "__main__":
    unittest.main()
