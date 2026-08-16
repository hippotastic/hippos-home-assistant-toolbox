"""RAM cache and refresh scheduler for progressive snapshot cameras."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from io import BytesIO
import logging
from pathlib import Path
import time

from PIL import Image as PillowImage

from homeassistant.components.camera import MIN_STREAM_INTERVAL, async_get_image
from homeassistant.components.camera.helper import get_camera_from_entity_id
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_OFF, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_state_change_event

_LOGGER = logging.getLogger(__name__)

_AUTOMATIC_WARMUP_DELAY = 30.0
_BACKGROUND_REFRESH_INTERVAL = 30.0
_INTERACTIVE_REFRESH_INTERVAL = 10.0
_FETCH_HANDOFF_TIMEOUT = 5.0
_FETCH_TIMEOUT = 15
_COLD_REQUEST_TIMEOUT = 9.0
_MAX_BACKGROUND_IN_FLIGHT = 2
_MAX_CONSECUTIVE_INTERACTIVE_REQUESTS = 3

_PRIORITY_INTERACTIVE = 0
_PRIORITY_BACKGROUND = 1
_JPEG_CONTENT_TYPES = frozenset(("image/jpeg", "image/jpg"))
_ERROR_OVERLAY_PATH = Path(__file__).parent / "assets" / "connection_problem.png"

type _FrameQueue = asyncio.Queue[bytes | None]


@dataclass(slots=True)
class _CameraCache:
    """Mutable state for one configured proxy camera."""

    subentry_id: str
    source_entity_id: str
    last_good_frame: bytes | None = None
    display_frame: bytes | None = None
    last_success_at: float | None = None
    last_completed_at: float | None = None
    failed: bool = False
    status_revision: int = 0
    scheduled_at: float | None = None
    scheduled_priority: int = _PRIORITY_BACKGROUND
    scheduled_order: int = 0
    in_flight: asyncio.Task[None] | None = None
    first_attempt_completed: asyncio.Event = field(default_factory=asyncio.Event)
    subscribers: set[_FrameQueue] = field(default_factory=set)
    listeners: set[Callable[[], None]] = field(default_factory=set)


class _ProgressiveCameraManager:
    """Coordinate snapshot requests and keep the latest frames in memory."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        source_entity_ids: Mapping[str, str],
    ) -> None:
        self._hass = hass
        self._entry = entry
        self._caches = {
            subentry_id: _CameraCache(subentry_id, source_entity_id)
            for subentry_id, source_entity_id in source_entity_ids.items()
        }
        self._overlay_png = b""
        self._wake = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None
        self._fetch_tasks: set[asyncio.Task[None]] = set()
        self._state_tasks: set[asyncio.Task[None]] = set()
        self._remove_state_listener: Callable[[], None] | None = None
        self._schedule_order = 0
        self._consecutive_interactive_requests = 0
        self._stopped = False

    async def async_start(self) -> None:
        """Load the overlay asset and start the shared refresh worker."""

        if not self._caches:
            return

        self._overlay_png = await self._hass.async_add_executor_job(
            _ERROR_OVERLAY_PATH.read_bytes
        )
        self._remove_state_listener = async_track_state_change_event(
            self._hass,
            {cache.source_entity_id for cache in self._caches.values()},
            self._async_source_state_changed,
        )
        self._worker = self._entry.async_create_background_task(
            self._hass,
            self._async_worker(),
            "progressive snapshot camera refresh worker",
            eager_start=False,
        )

        warmup_at = time.monotonic() + _AUTOMATIC_WARMUP_DELAY
        for cache in self._caches.values():
            self._async_schedule(cache, warmup_at, _PRIORITY_BACKGROUND)

    async def async_stop(self) -> None:
        """Cancel timers and requests and close all stream subscribers."""

        self._stopped = True
        if self._remove_state_listener is not None:
            self._remove_state_listener()
            self._remove_state_listener = None

        self._wake.set()
        if self._worker is not None:
            self._worker.cancel()
        for task in tuple(self._fetch_tasks):
            task.cancel()
        for task in tuple(self._state_tasks):
            task.cancel()

        await asyncio.gather(
            *(
                task
                for task in (
                    self._worker,
                    *self._fetch_tasks,
                    *self._state_tasks,
                )
                if task is not None
            ),
            return_exceptions=True,
        )
        self._worker = None
        self._fetch_tasks.clear()
        self._state_tasks.clear()

        for cache in self._caches.values():
            for queue in tuple(cache.subscribers):
                self._async_replace_queued_frame(queue, None)
            cache.subscribers.clear()

    async def async_get_frame(self, subentry_id: str) -> bytes | None:
        """Return the cache immediately, or briefly await the first snapshot."""

        cache = self._caches[subentry_id]
        frame = cache.display_frame
        if self._needs_interactive_refresh(cache):
            self._async_schedule(
                cache, time.monotonic(), _PRIORITY_INTERACTIVE
            )
        if frame is not None:
            return frame
        if not self._source_is_available(cache):
            return None

        try:
            async with asyncio.timeout(_COLD_REQUEST_TIMEOUT):
                await cache.first_attempt_completed.wait()
        except TimeoutError:
            pass
        return cache.display_frame

    @callback
    def async_subscribe(self, subentry_id: str) -> _FrameQueue:
        """Subscribe an MJPEG client and request a fresh frame when needed."""

        cache = self._caches[subentry_id]
        queue: _FrameQueue = asyncio.Queue(maxsize=1)
        first_subscriber = not cache.subscribers
        cache.subscribers.add(queue)
        if cache.display_frame is not None:
            queue.put_nowait(cache.display_frame)

        if first_subscriber and cache.in_flight is None:
            # The cached frame is only the instant placeholder. Always start the
            # source-camera cadence in parallel when the first live viewer arrives.
            self._async_schedule(
                cache,
                time.monotonic(),
                _PRIORITY_INTERACTIVE,
                replace=True,
            )
        return queue

    @callback
    def async_unsubscribe(self, subentry_id: str, queue: _FrameQueue) -> None:
        """Remove an MJPEG client and return to the idle refresh interval."""

        cache = self._caches[subentry_id]
        cache.subscribers.discard(queue)
        if (
            not cache.subscribers
            and cache.in_flight is None
            and cache.scheduled_at is not None
            and cache.scheduled_priority == _PRIORITY_BACKGROUND
        ):
            now = time.monotonic()
            due_at = (cache.last_completed_at or now) + _BACKGROUND_REFRESH_INTERVAL
            self._async_schedule(
                cache,
                max(now, due_at),
                _PRIORITY_BACKGROUND,
                replace=True,
            )

    @callback
    def async_add_listener(
        self, subentry_id: str, listener: Callable[[], None]
    ) -> Callable[[], None]:
        """Notify an entity when cache availability changes."""

        listeners = self._caches[subentry_id].listeners
        listeners.add(listener)

        @callback
        def remove_listener() -> None:
            listeners.discard(listener)

        return remove_listener

    @callback
    def has_frame(self, subentry_id: str) -> bool:
        """Return whether the proxy has an image it can serve."""

        return self._caches[subentry_id].display_frame is not None

    @callback
    def _async_schedule(
        self,
        cache: _CameraCache,
        scheduled_at: float,
        priority: int,
        *,
        replace: bool = False,
    ) -> None:
        if self._stopped or cache.in_flight is not None:
            return
        if (
            not replace
            and cache.scheduled_at is not None
            and (cache.scheduled_at, cache.scheduled_priority)
            <= (scheduled_at, priority)
        ):
            return

        self._schedule_order += 1
        cache.scheduled_at = scheduled_at
        cache.scheduled_priority = priority
        cache.scheduled_order = self._schedule_order
        self._wake.set()

    async def _async_worker(self) -> None:
        """Dispatch independent live requests and staggered background work."""

        try:
            while not self._stopped:
                now = time.monotonic()
                ready_live = sorted(
                    (
                        cache
                        for cache in self._caches.values()
                        if cache.subscribers
                        and cache.in_flight is None
                        and cache.scheduled_at is not None
                        and cache.scheduled_at <= now
                    ),
                    key=lambda cache: cache.scheduled_order,
                )
                if ready_live:
                    # Visible cameras match their source cadence independently.
                    # Only background warming is globally concurrency-limited.
                    for cache in ready_live:
                        cache.scheduled_at = None
                        self._async_launch_fetch(cache)
                    continue

                active_background_tasks = {
                    cache.in_flight
                    for cache in self._caches.values()
                    if not cache.subscribers
                    and cache.in_flight is not None
                    and not cache.in_flight.done()
                }
                if (
                    len(active_background_tasks)
                    >= _MAX_BACKGROUND_IN_FLIGHT
                ):
                    self._wake.clear()
                    await self._wake.wait()
                    continue

                cache = self._next_ready_cache(now)
                if cache is not None:
                    self._async_launch_fetch(cache)
                    # A quick camera hands the slot to the next source immediately;
                    # a slow camera cannot block the queue for more than five
                    # seconds, and a new live viewer interrupts the wait at once.
                    self._wake.clear()
                    try:
                        async with asyncio.timeout(_FETCH_HANDOFF_TIMEOUT):
                            await self._wake.wait()
                    except TimeoutError:
                        pass
                    continue

                self._wake.clear()
                delay = self._next_schedule_delay(now)
                try:
                    if delay is None:
                        await self._wake.wait()
                    else:
                        async with asyncio.timeout(delay):
                            await self._wake.wait()
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise

    @callback
    def _next_ready_cache(self, now: float) -> _CameraCache | None:
        ready = [
            cache
            for cache in self._caches.values()
            if cache.in_flight is None
            and cache.scheduled_at is not None
            and cache.scheduled_at <= now
        ]
        if not ready:
            return None

        background = [
            cache
            for cache in ready
            if cache.scheduled_priority == _PRIORITY_BACKGROUND
        ]
        if (
            background
            and self._consecutive_interactive_requests
            >= _MAX_CONSECUTIVE_INTERACTIVE_REQUESTS
        ):
            selected = min(background, key=lambda cache: cache.scheduled_order)
        else:
            selected = min(
                ready,
                key=lambda cache: (
                    cache.scheduled_priority,
                    cache.scheduled_order,
                ),
            )

        if selected.scheduled_priority == _PRIORITY_INTERACTIVE:
            self._consecutive_interactive_requests += 1
        else:
            self._consecutive_interactive_requests = 0
        selected.scheduled_at = None
        return selected

    @callback
    def _next_schedule_delay(self, now: float) -> float | None:
        scheduled = [
            cache.scheduled_at
            for cache in self._caches.values()
            if cache.in_flight is None and cache.scheduled_at is not None
        ]
        if not scheduled:
            return None
        return max(0.0, min(scheduled) - now)

    @callback
    def _async_launch_fetch(self, cache: _CameraCache) -> None:
        task = self._entry.async_create_background_task(
            self._hass,
            self._async_fetch(cache),
            f"refresh progressive camera {cache.source_entity_id}",
            eager_start=False,
        )
        cache.in_flight = task
        self._fetch_tasks.add(task)
        task.add_done_callback(self._async_fetch_done)

    @callback
    def _async_fetch_done(self, task: asyncio.Task[None]) -> None:
        self._fetch_tasks.discard(task)
        self._wake.set()

    async def _async_fetch(self, cache: _CameraCache) -> None:
        started_at = time.monotonic()
        try:
            if not self._source_is_available(cache):
                await self._async_record_failure(
                    cache, "source entity is unavailable"
                )
                return

            image = await async_get_image(
                self._hass, cache.source_entity_id, timeout=_FETCH_TIMEOUT
            )
            content_type = image.content_type.lower().split(";", 1)[0].strip()
            if not image.content:
                raise ValueError("source returned an empty image")
            if (
                content_type not in _JPEG_CONTENT_TYPES
                and not image.content.startswith(b"\xff\xd8\xff")
            ):
                raise ValueError(
                    f"source returned unsupported content type {content_type!r}"
                )
            self._async_record_success(cache, image.content)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # Home Assistant integrations expose varied errors.
            if self._stopped:
                return
            await self._async_record_failure(cache, str(err) or type(err).__name__)
        finally:
            cache.in_flight = None
            cache.last_completed_at = time.monotonic()
            cache.first_attempt_completed.set()
            if not self._stopped and self._source_is_available(cache):
                if cache.subscribers:
                    interval = self._source_frame_interval(cache)
                    # Match Home Assistant's still-stream cadence: request the
                    # next frame relative to fetch start, not fetch completion.
                    scheduled_at = max(
                        cache.last_completed_at, started_at + interval
                    )
                else:
                    scheduled_at = (
                        cache.last_completed_at + _BACKGROUND_REFRESH_INTERVAL
                    )
                self._async_schedule(
                    cache,
                    scheduled_at,
                    _PRIORITY_BACKGROUND,
                    replace=True,
                )
            self._wake.set()

    def _source_frame_interval(self, cache: _CameraCache) -> float:
        """Return the same still-stream interval as the source camera."""

        try:
            return get_camera_from_entity_id(
                self._hass, cache.source_entity_id
            ).frame_interval
        except HomeAssistantError:
            return MIN_STREAM_INTERVAL

    @callback
    def _async_record_success(self, cache: _CameraCache, frame: bytes) -> None:
        was_failed = cache.failed
        previous_display = cache.display_frame
        cache.status_revision += 1
        cache.failed = False
        cache.last_good_frame = frame
        cache.display_frame = frame
        cache.last_success_at = time.monotonic()

        if was_failed:
            _LOGGER.info(
                "Progressive camera source %s recovered", cache.source_entity_id
            )
        if previous_display != frame:
            self._async_publish(cache, frame)
        else:
            self._async_notify_listeners(cache)

    async def _async_record_failure(
        self, cache: _CameraCache, reason: str
    ) -> None:
        if cache.failed:
            _LOGGER.debug(
                "Progressive camera source %s still failing: %s",
                cache.source_entity_id,
                reason,
            )
            return

        cache.failed = True
        cache.status_revision += 1
        failure_revision = cache.status_revision
        _LOGGER.warning(
            "Progressive camera source %s failed: %s",
            cache.source_entity_id,
            reason,
        )
        if cache.last_good_frame is None:
            cache.display_frame = None
            self._async_notify_listeners(cache)
            return

        try:
            overlay_frame = await self._hass.async_add_executor_job(
                _render_error_overlay,
                cache.last_good_frame,
                self._overlay_png,
            )
        except Exception:
            _LOGGER.exception(
                "Could not render the error marker for %s",
                cache.source_entity_id,
            )
            self._async_notify_listeners(cache)
            return

        # Rendering runs in an executor. Do not let an old failure overwrite a
        # newer successful frame that arrived while Pillow was working.
        if cache.status_revision != failure_revision:
            return
        cache.display_frame = overlay_frame
        self._async_publish(cache, overlay_frame)

    @callback
    def _async_publish(self, cache: _CameraCache, frame: bytes) -> None:
        for queue in tuple(cache.subscribers):
            self._async_replace_queued_frame(queue, frame)
        self._async_notify_listeners(cache)

    @staticmethod
    @callback
    def _async_replace_queued_frame(
        queue: _FrameQueue, frame: bytes | None
    ) -> None:
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(frame)

    @staticmethod
    @callback
    def _async_notify_listeners(cache: _CameraCache) -> None:
        for listener in tuple(cache.listeners):
            listener()

    @callback
    def _async_source_state_changed(self, event: Event) -> None:
        if self._stopped:
            return
        source_entity_id = event.data["entity_id"]
        cache = next(
            (
                item
                for item in self._caches.values()
                if item.source_entity_id == source_entity_id
            ),
            None,
        )
        if cache is None:
            return

        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        old_available = old_state is not None and old_state.state not in {
            STATE_OFF,
            STATE_UNAVAILABLE,
            STATE_UNKNOWN,
        }
        new_available = new_state is not None and new_state.state not in {
            STATE_OFF,
            STATE_UNAVAILABLE,
            STATE_UNKNOWN,
        }
        if new_available and not old_available:
            self._async_schedule(
                cache, time.monotonic(), _PRIORITY_INTERACTIVE
            )
        elif not new_available and old_available:
            # Recovery is event-driven, so an unavailable source needs no timed
            # retry that would only consume a dispatcher slot.
            cache.scheduled_at = None
            self._wake.set()
            task = self._entry.async_create_background_task(
                self._hass,
                self._async_record_failure(cache, "source entity became unavailable"),
                f"mark progressive camera {source_entity_id} unavailable",
                eager_start=False,
            )
            self._state_tasks.add(task)
            task.add_done_callback(self._async_state_task_done)

    @callback
    def _async_state_task_done(self, task: asyncio.Task[None]) -> None:
        self._state_tasks.discard(task)

    @callback
    def _source_is_available(self, cache: _CameraCache) -> bool:
        state = self._hass.states.get(cache.source_entity_id)
        return state is not None and state.state not in {
            STATE_OFF,
            STATE_UNAVAILABLE,
            STATE_UNKNOWN,
        }

    @staticmethod
    @callback
    def _needs_interactive_refresh(cache: _CameraCache) -> bool:
        if cache.in_flight is not None:
            return False
        if cache.failed or cache.last_success_at is None:
            return True
        return (
            time.monotonic() - cache.last_success_at
            >= _INTERACTIVE_REFRESH_INTERVAL
        )


def _render_error_overlay(frame: bytes, overlay_png: bytes) -> bytes:
    """Bake the connection marker into a same-size JPEG frame."""

    with PillowImage.open(BytesIO(frame)) as source_image:
        source_image.load()
        canvas = source_image.convert("RGBA")
    with PillowImage.open(BytesIO(overlay_png)) as overlay_image:
        overlay_image.load()
        icon_size = max(48, min(160, round(min(canvas.size) * 0.12)))
        icon = overlay_image.convert("RGBA").resize(
            (icon_size, icon_size), PillowImage.Resampling.LANCZOS
        )

    margin = round(icon_size / 4)
    canvas.alpha_composite(
        icon, (canvas.width - icon_size - margin, margin)
    )
    output = BytesIO()
    canvas.convert("RGB").save(output, format="JPEG", quality=90)
    return output.getvalue()
