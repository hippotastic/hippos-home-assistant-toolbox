"""Regression tests for progressive snapshot caching and scheduling."""

import asyncio
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from PIL import Image as PillowImage

from custom_components.hippos_toolbox import progressive_camera
from custom_components.hippos_toolbox.progressive_camera import (
    _ProgressiveCameraManager,
)


def _jpeg(color: tuple[int, int, int] = (40, 90, 140)) -> bytes:
    output = BytesIO()
    PillowImage.new("RGB", (800, 600), color).save(output, format="JPEG")
    return output.getvalue()


class _States:
    def __init__(self, entity_ids: tuple[str, ...]) -> None:
        self._states = {
            entity_id: SimpleNamespace(state="idle") for entity_id in entity_ids
        }

    def get(self, entity_id: str) -> SimpleNamespace | None:
        return self._states.get(entity_id)


class _Hass:
    def __init__(self, entity_ids: tuple[str, ...]) -> None:
        self.states = _States(entity_ids)

    async def async_add_executor_job(self, function, *args):
        return function(*args)


class _Entry:
    def async_create_background_task(
        self, _hass, coroutine, name, eager_start=True
    ):
        if eager_start:
            raise AssertionError("manager tasks must not use eager start")
        return asyncio.create_task(coroutine, name=name)


async def _wait_until(predicate, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition did not become true")
        await asyncio.sleep(0.002)


class ProgressiveCameraManagerTests(unittest.IsolatedAsyncioTestCase):
    """Verify cache transitions and live/background request dispatching."""

    async def test_dashboard_access_overtakes_delayed_warmup(self) -> None:
        source = "camera.front_door"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"front": source})
        snapshot = _jpeg()

        with (
            patch.object(
                progressive_camera, "async_track_state_change_event", return_value=lambda: None
            ),
            patch.object(progressive_camera, "_AUTOMATIC_WARMUP_DELAY", 0.5),
            patch.object(progressive_camera, "_FETCH_HANDOFF_TIMEOUT", 0.005),
            patch.object(
                progressive_camera,
                "async_get_image",
                AsyncMock(
                    return_value=SimpleNamespace(
                        content_type="image/jpeg", content=snapshot
                    )
                ),
            ) as get_image,
        ):
            await manager.async_start()
            await asyncio.sleep(0.02)
            self.assertEqual(get_image.await_count, 0)

            frame = await manager.async_get_frame("front")
            self.assertEqual(frame, snapshot)
            self.assertEqual(get_image.await_count, 1)
            get_image.assert_awaited_once_with(
                hass, source, timeout=progressive_camera._FETCH_TIMEOUT
            )
            await manager.async_stop()

    async def test_eight_cameras_are_staggered_with_two_in_flight(self) -> None:
        sources = tuple(f"camera.snapshot_{index}" for index in range(8))
        hass = _Hass(sources)
        manager = _ProgressiveCameraManager(
            hass,
            _Entry(),
            {f"camera-{index}": source for index, source in enumerate(sources)},
        )
        active = 0
        maximum_active = 0
        calls: list[str] = []
        snapshot = _jpeg()

        async def get_image(_hass, entity_id, timeout):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            calls.append(entity_id)
            try:
                await asyncio.sleep(0.02)
                return SimpleNamespace(content_type="image/jpeg", content=snapshot)
            finally:
                active -= 1

        with (
            patch.object(
                progressive_camera, "async_track_state_change_event", return_value=lambda: None
            ),
            patch.object(progressive_camera, "_AUTOMATIC_WARMUP_DELAY", 0.0),
            patch.object(progressive_camera, "_FETCH_HANDOFF_TIMEOUT", 0.005),
            patch.object(progressive_camera, "_BACKGROUND_REFRESH_INTERVAL", 60.0),
            patch.object(progressive_camera, "async_get_image", side_effect=get_image),
        ):
            await manager.async_start()
            await _wait_until(lambda: len(calls) == len(sources))
            await _wait_until(lambda: active == 0)
            await manager.async_stop()

        self.assertEqual(set(calls), set(sources))
        self.assertEqual(maximum_active, 2)

    async def test_visible_cameras_follow_source_cadence_in_parallel(self) -> None:
        sources = tuple(f"camera.live_{index}" for index in range(4))
        hass = _Hass(sources)
        manager = _ProgressiveCameraManager(
            hass,
            _Entry(),
            {f"camera-{index}": source for index, source in enumerate(sources)},
        )
        active = 0
        maximum_active = 0
        all_started = asyncio.Event()
        release = asyncio.Event()
        snapshot = _jpeg()

        async def get_image(_hass, _entity_id, timeout):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            if active == len(sources):
                all_started.set()
            try:
                await release.wait()
                return SimpleNamespace(
                    content_type="image/jpeg", content=snapshot
                )
            finally:
                active -= 1

        with (
            patch.object(
                progressive_camera,
                "async_track_state_change_event",
                return_value=lambda: None,
            ),
            patch.object(
                progressive_camera, "_AUTOMATIC_WARMUP_DELAY", 60.0
            ),
            patch.object(
                progressive_camera,
                "get_camera_from_entity_id",
                return_value=SimpleNamespace(frame_interval=0.5),
            ),
            patch.object(
                progressive_camera, "async_get_image", side_effect=get_image
            ),
        ):
            await manager.async_start()
            queues = [
                manager.async_subscribe(f"camera-{index}")
                for index in range(len(sources))
            ]
            await asyncio.wait_for(all_started.wait(), timeout=1.0)
            release.set()
            await _wait_until(lambda: active == 0)
            for index, queue in enumerate(queues):
                manager.async_unsubscribe(f"camera-{index}", queue)
            await manager.async_stop()

        self.assertEqual(maximum_active, len(sources))

    async def test_live_view_interrupts_background_handoff_wait(self) -> None:
        sources = ("camera.background", "camera.live")
        hass = _Hass(sources)
        manager = _ProgressiveCameraManager(
            hass,
            _Entry(),
            {"background": sources[0], "live": sources[1]},
        )
        background_started = asyncio.Event()
        live_started = asyncio.Event()
        release = asyncio.Event()
        snapshot = _jpeg()

        async def get_image(_hass, entity_id, timeout):
            if entity_id == sources[0]:
                background_started.set()
            else:
                live_started.set()
            await release.wait()
            return SimpleNamespace(content_type="image/jpeg", content=snapshot)

        with (
            patch.object(
                progressive_camera,
                "async_track_state_change_event",
                return_value=lambda: None,
            ),
            patch.object(progressive_camera, "_AUTOMATIC_WARMUP_DELAY", 0.0),
            patch.object(progressive_camera, "_FETCH_HANDOFF_TIMEOUT", 1.0),
            patch.object(
                progressive_camera,
                "get_camera_from_entity_id",
                return_value=SimpleNamespace(frame_interval=0.5),
            ),
            patch.object(
                progressive_camera, "async_get_image", side_effect=get_image
            ),
        ):
            await manager.async_start()
            await asyncio.wait_for(background_started.wait(), timeout=1.0)

            queue = manager.async_subscribe("live")
            await asyncio.wait_for(live_started.wait(), timeout=0.5)

            release.set()
            await _wait_until(
                lambda: all(
                    cache.in_flight is None
                    for cache in manager._caches.values()
                )
            )
            manager.async_unsubscribe("live", queue)
            await manager.async_stop()

    async def test_refresh_interval_follows_live_subscribers(self) -> None:
        source = "camera.garden"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"garden": source})
        cache = manager._caches["garden"]
        snapshot = _jpeg()

        with (
            patch.object(
                progressive_camera,
                "async_get_image",
                AsyncMock(
                    return_value=SimpleNamespace(
                        content_type="image/jpeg", content=snapshot
                    )
                ),
            ),
            patch.object(
                progressive_camera,
                "get_camera_from_entity_id",
                return_value=SimpleNamespace(frame_interval=0.5),
            ),
        ):
            await manager._async_fetch(cache)
            self.assertAlmostEqual(
                cache.scheduled_at - cache.last_completed_at,
                progressive_camera._BACKGROUND_REFRESH_INTERVAL,
                places=3,
            )

            cache.subscribers.add(asyncio.Queue())
            await manager._async_fetch(cache)
            self.assertAlmostEqual(
                cache.scheduled_at - cache.last_completed_at,
                0.5,
                places=3,
            )

    async def test_live_cards_share_one_immediate_source_schedule(self) -> None:
        source = "camera.garage_snapshots"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"garage": source})
        cache = manager._caches["garage"]
        now = asyncio.get_running_loop().time()
        cache.display_frame = b"cached"
        cache.last_success_at = now
        cache.last_completed_at = now
        cache.scheduled_at = now + progressive_camera._BACKGROUND_REFRESH_INTERVAL
        cache.scheduled_priority = progressive_camera._PRIORITY_BACKGROUND

        subscribed_at = asyncio.get_running_loop().time()
        first_queue = manager.async_subscribe("garage")
        scheduled_order = cache.scheduled_order
        second_queue = manager.async_subscribe("garage")

        self.assertEqual(first_queue.get_nowait(), b"cached")
        self.assertEqual(second_queue.get_nowait(), b"cached")
        self.assertEqual(
            cache.scheduled_priority, progressive_camera._PRIORITY_INTERACTIVE
        )
        self.assertLessEqual(cache.scheduled_at, subscribed_at + 0.01)
        self.assertEqual(cache.scheduled_order, scheduled_order)
        manager.async_unsubscribe("garage", first_queue)
        manager.async_unsubscribe("garage", second_queue)

    async def test_source_recovery_publishes_availability_immediately(self) -> None:
        source = "camera.front_door"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"front": source})
        notifications: list[bool] = []
        manager.async_add_listener("front", lambda: notifications.append(True))

        manager._async_source_state_changed(
            SimpleNamespace(
                data={
                    "entity_id": source,
                    "old_state": SimpleNamespace(state="unavailable"),
                    "new_state": SimpleNamespace(state="idle"),
                }
            )
        )

        cache = manager._caches["front"]
        self.assertEqual(notifications, [True])
        self.assertTrue(manager.is_available("front"))
        self.assertEqual(
            cache.scheduled_priority, progressive_camera._PRIORITY_INTERACTIVE
        )

    async def test_failure_marks_last_frame_once_and_success_cleans_it(self) -> None:
        source = "camera.driveway"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"driveway": source})
        cache = manager._caches["driveway"]
        clean = _jpeg()
        manager._overlay_png = (
            Path(progressive_camera.__file__).parent
            / "assets"
            / "connection_problem.png"
        ).read_bytes()

        success = SimpleNamespace(content_type="image/jpeg", content=clean)
        with patch.object(
            progressive_camera,
            "async_get_image",
            AsyncMock(side_effect=(success, RuntimeError("offline"), RuntimeError("offline"), success)),
        ):
            await manager._async_fetch(cache)
            self.assertIs(cache.last_good_frame, clean)
            self.assertIs(cache.display_frame, clean)

            await manager._async_fetch(cache)
            marked = cache.display_frame
            self.assertNotEqual(marked, clean)
            self.assertIs(cache.last_good_frame, clean)
            with PillowImage.open(BytesIO(marked)) as marked_image:
                self.assertEqual(marked_image.size, (800, 600))
                overlay_pixels = list(
                    marked_image.crop((710, 18, 782, 90)).getdata()
                )
                self.assertTrue(
                    any(
                        red > 180 and red > green * 1.3 and red > blue * 1.3
                        for red, green, blue in overlay_pixels
                    )
                )
                self.assertTrue(
                    any(
                        red > 220 and green > 220 and blue > 220
                        for red, green, blue in overlay_pixels
                    )
                )

            await manager._async_fetch(cache)
            self.assertIs(cache.display_frame, marked)

            await manager._async_fetch(cache)
            self.assertIs(cache.display_frame, clean)
            self.assertFalse(cache.failed)

    async def test_non_jpeg_without_cache_stays_unavailable(self) -> None:
        source = "camera.invalid"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"invalid": source})
        cache = manager._caches["invalid"]

        with patch.object(
            progressive_camera,
            "async_get_image",
            AsyncMock(
                return_value=SimpleNamespace(
                    content_type="image/png", content=b"not-a-jpeg"
                )
            ),
        ):
            await manager._async_fetch(cache)

        self.assertIsNone(cache.display_frame)
        self.assertTrue(manager.is_available("invalid"))
        self.assertTrue(cache.failed)

    async def test_unavailable_source_is_not_requested(self) -> None:
        source = "camera.offline"
        hass = _Hass(())
        manager = _ProgressiveCameraManager(hass, _Entry(), {"offline": source})
        cache = manager._caches["offline"]

        with patch.object(
            progressive_camera, "async_get_image", new_callable=AsyncMock
        ) as get_image:
            await manager._async_fetch(cache)

        get_image.assert_not_awaited()
        self.assertFalse(manager.is_available("offline"))

    async def test_slow_stream_subscriber_only_keeps_latest_frame(self) -> None:
        source = "camera.patio"
        hass = _Hass((source,))
        manager = _ProgressiveCameraManager(hass, _Entry(), {"patio": source})
        cache = manager._caches["patio"]
        cache.display_frame = b"cached"
        cache.last_success_at = asyncio.get_running_loop().time()
        cache.last_completed_at = cache.last_success_at

        queue = manager.async_subscribe("patio")
        manager._async_publish(cache, b"fresh-one")
        manager._async_publish(cache, b"fresh-two")

        self.assertEqual(queue.qsize(), 1)
        self.assertEqual(queue.get_nowait(), b"fresh-two")
        manager.async_unsubscribe("patio", queue)


class ProgressiveCameraOverlayAssetTests(unittest.TestCase):
    """Verify the checked-in runtime asset is a transparent PNG."""

    def test_overlay_asset_has_alpha_and_expected_dimensions(self) -> None:
        asset = (
            Path(progressive_camera.__file__).parent
            / "assets"
            / "connection_problem.png"
        )
        with PillowImage.open(asset) as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.size, (512, 512))
            alpha = image.getchannel("A")
            self.assertEqual(alpha.getextrema(), (0, 255))

            # A scaled SVG blur once reached the asset edges and was clipped into
            # a faint rectangle that became visible over bright camera frames.
            meaningful_alpha = alpha.point(
                lambda value: 255 if value > 8 else 0
            )
            bounds = meaningful_alpha.getbbox()
            self.assertIsNotNone(bounds)
            left, top, right, bottom = bounds
            self.assertGreater(left, 0)
            self.assertGreater(top, 0)
            self.assertLess(right, image.width)
            self.assertLess(bottom, image.height)


if __name__ == "__main__":
    unittest.main()
