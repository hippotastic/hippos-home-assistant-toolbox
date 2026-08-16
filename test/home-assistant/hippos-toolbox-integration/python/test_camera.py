"""Regression tests for the progressive camera entity and MJPEG response."""

import asyncio
from types import MappingProxyType, SimpleNamespace
import unittest
from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.components.camera import CameraEntityFeature

from custom_components.hippos_toolbox.camera import (
    _ProgressiveSnapshotCamera,
    async_setup_entry,
)
from custom_components.hippos_toolbox.const import (
    CONF_SOURCE_ENTITY_ID,
    PROGRESSIVE_CAMERA_SUBENTRY_TYPE,
)


class _Manager:
    def __init__(self, frames: tuple[bytes, ...] = ()) -> None:
        self.frames = frames
        self.unsubscribed = False

    def has_frame(self, _subentry_id):
        return bool(self.frames)

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
            camera = _ProgressiveSnapshotCamera(
                SimpleNamespace(), manager, _subentry()
            )
            returned = await camera.handle_async_mjpeg_stream(SimpleNamespace())

        self.assertIs(returned, response)
        self.assertTrue(manager.unsubscribed)
        self.assertEqual(len(response.writes), 3)
        self.assertTrue(response.writes[0].endswith(b"cached\r\n"))
        self.assertEqual(response.writes[0], response.writes[1])
        self.assertTrue(response.writes[2].endswith(b"fresh\r\n"))
        self.assertIn(b"Content-Length: 5", response.writes[2])

    async def test_entity_is_linked_to_source_without_stream_feature(self) -> None:
        source_device = SimpleNamespace(id="source-device")
        with patch(
            "custom_components.hippos_toolbox.camera.async_entity_id_to_device",
            return_value=source_device,
        ):
            camera = _ProgressiveSnapshotCamera(
                SimpleNamespace(), _Manager((b"cached",)), _subentry()
            )

        self.assertEqual(camera.unique_id, "progressive-front-door")
        self.assertEqual(camera.name, "Front door")
        self.assertIs(camera.device_entry, source_device)
        self.assertNotIn(CameraEntityFeature.STREAM, camera.supported_features)
        self.assertTrue(camera.available)

    async def test_platform_binds_each_entity_to_its_subentry(self) -> None:
        manager = _Manager((b"cached",))
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
        ):
            await async_setup_entry(
                SimpleNamespace(), entry, add_entities
            )

        self.assertEqual(len(added), 1)
        self.assertEqual(added[0][1], subentry.subentry_id)
        self.assertEqual(len(added[0][0]), 1)


if __name__ == "__main__":
    unittest.main()
