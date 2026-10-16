"""File and TTS announcements with shared player queues and completion waits."""

import asyncio
from contextlib import AsyncExitStack
from io import BytesIO
import logging
import math
from pathlib import Path
import struct
import sys
import wave

from mutagen import MutagenError
from mutagen.mp3 import MP3
import voluptuous as vol

from homeassistant.components import media_source, tts
from homeassistant.components.media_player import MediaPlayerEntityFeature
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import (
    EVENT_HOMEASSISTANT_STARTED,
    EVENT_SERVICE_REGISTERED,
    EVENT_SERVICE_REMOVED,
    EVENT_STATE_CHANGED,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import Event, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.service import async_set_service_schema
from homeassistant.helpers.target import (
    TargetSelection,
    async_extract_referenced_entity_ids,
)
from homeassistant.util.yaml import load_yaml_dict

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
_START_RESERVE = 1.0
_PREPARATION_TIMEOUT = 60.0
_PLAYBACK_TIMEOUT_RESERVE = 60.0
_MAX_AUDIO_BYTES = 64 * 1024 * 1024

_COMMON_FIELDS = {
    vol.Optional("volume"): vol.All(vol.Coerce(float), vol.Range(min=0, max=1))
}
_MEDIA_SCHEMA = cv.make_entity_service_schema(
    {
        **_COMMON_FIELDS,
        vol.Required("media"): vol.Schema(
            {vol.Required("media_content_id"): cv.string}, extra=vol.ALLOW_EXTRA
        ),
    }
)
_TTS_SCHEMA = cv.make_entity_service_schema(
    {
        **_COMMON_FIELDS,
        vol.Required("engine_id"): cv.string,
        vol.Required("message"): vol.All(cv.string, vol.Length(min=1)),
        vol.Optional("language"): cv.string,
        vol.Optional("options", default=dict): dict,
        vol.Optional("cache", default=True): cv.boolean,
    }
)


def _audio_duration(data: bytes) -> tuple[str, float]:
    """Read duration from complete PCM WAV or MP3 audio, including streamed WAVs."""

    if not data or len(data) > _MAX_AUDIO_BYTES:
        raise ServiceValidationError(
            "Announcement audio must be between 1 byte and 64 MiB"
        )
    try:
        if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
            with wave.open(BytesIO(data), "rb") as audio:
                frame_size = audio.getnchannels() * audio.getsampwidth()
                declared_frames = audio.getnframes()
                frames = audio.readframes(declared_frames)
                # FFmpeg's non-seekable WAV output uses an unknown data size.
                # Count actual PCM frames rather than treating 0xffffffff as duration.
                unknown_size = declared_frames == 0xFFFFFFFF // frame_size
                if len(frames) % frame_size or (
                    not unknown_size and len(frames) != declared_frames * frame_size
                ):
                    raise ValueError("Incomplete WAV audio")
                duration = len(frames) / frame_size / audio.getframerate()
            content_type = "audio/wav"
        else:
            duration = MP3(BytesIO(data)).info.length
            content_type = "audio/mpeg"
    except (
        wave.Error, EOFError, MutagenError, ValueError, ZeroDivisionError,
        struct.error,
    ) as err:
        raise ServiceValidationError(
            "Announcement must contain readable PCM WAV or MP3 audio"
        ) from err
    if not math.isfinite(duration) or duration <= 0:
        raise ServiceValidationError("Announcement audio has no positive duration")
    return content_type, duration


def _read_audio_file(path: Path, media_dirs: tuple[str, ...]) -> tuple[str, float]:
    """Read a file confined to Home Assistant's configured media directories."""

    try:
        path = path.resolve()
        if not any(path.is_relative_to(Path(root).resolve()) for root in media_dirs):
            raise ServiceValidationError(
                "Announcement file is outside the configured media directories"
            )
        if not path.is_file() or path.stat().st_size > _MAX_AUDIO_BYTES:
            raise ServiceValidationError(
                "Announcement must be a local audio file of at most 64 MiB"
            )
        with path.open("rb") as audio:
            return _audio_duration(audio.read(_MAX_AUDIO_BYTES + 1))
    except OSError as err:
        raise ServiceValidationError(f"Cannot read announcement file: {err}") from err


async def async_setup_announcements(hass: HomeAssistant) -> None:
    """Register both actions once, retaining shared queues across entry reloads."""

    player_locks: dict[str, asyncio.Lock] = {}

    async def handle_announcement(call: ServiceCall) -> None:
        if not any(
            entry.state is ConfigEntryState.LOADED
            for entry in hass.config_entries.async_entries(DOMAIN)
        ):
            raise ServiceValidationError(
                "Hippo's Home Assistant Toolbox is not loaded"
            )

        selected = async_extract_referenced_entity_ids(
            hass, TargetSelection(call.data)
        )
        if (
            selected.missing_areas or selected.missing_devices
            or selected.missing_floors or selected.missing_labels
        ):
            raise ServiceValidationError("An announcement target does not exist")
        entity_ids = selected.referenced | {
            entity_id
            for entity_id in selected.indirectly_referenced
            if entity_id.startswith("media_player.")
        }
        if not entity_ids or any(
            not entity_id.startswith("media_player.") for entity_id in entity_ids
        ):
            raise ServiceValidationError(
                "Select one or more media players for the announcement"
            )

        # A stable acquisition order prevents deadlocks for overlapping target sets.
        # Reserve the players before preparing audio to serialize media and TTS.
        async with AsyncExitStack() as stack:
            for entity_id in sorted(entity_ids):
                await stack.enter_async_context(
                    player_locks.setdefault(entity_id, asyncio.Lock())
                )

            volume = call.data.get("volume")
            if volume is not None and not math.isfinite(volume):
                raise ServiceValidationError(
                    "Announcement volume must be a finite number between 0 and 1"
                )

            try:
                async with asyncio.timeout(_PREPARATION_TIMEOUT):
                    if call.service == "announce_media":
                        media_id = call.data["media"]["media_content_id"]
                        if not media_id.startswith("media-source://media_source/"):
                            raise ServiceValidationError(
                                "Select a file from Home Assistant's local media"
                            )
                        media = await media_source.async_resolve_media(
                            hass, media_id, None
                        )
                        if media.path is None:
                            raise ServiceValidationError(
                                "Announcement media did not resolve to a local file"
                            )
                        content_type, duration = await hass.async_add_executor_job(
                            _read_audio_file,
                            media.path,
                            tuple(hass.config.media_dirs.values()),
                        )
                    else:
                        options = dict(call.data["options"])
                        options.setdefault("preferred_format", "wav")
                        if options["preferred_format"] not in ("wav", "mp3"):
                            raise ServiceValidationError(
                                "Announcement TTS format must be wav or mp3"
                            )
                        media_id = tts.generate_media_source_id(
                            hass,
                            call.data["message"],
                            engine=call.data["engine_id"],
                            language=call.data.get("language"),
                            options=options,
                            cache=call.data["cache"],
                        )
                        # HA owns synthesis and its memory/disk cache. Fully loading
                        # audio here makes its duration known before any player changes.
                        _extension, audio = await tts.async_get_media_source_audio(
                            hass, media_id
                        )
                        content_type, duration = await hass.async_add_executor_job(
                            _audio_duration, audio
                        )
            except TimeoutError as err:
                raise HomeAssistantError(
                    "Announcement audio preparation timed out"
                ) from err

            # Capture volumes after synthesis, immediately before playback. An
            # external volume change during slow synthesis must not be undone.
            registry = er.async_get(hass)
            players: list[tuple[str, bool, float | None]] = []
            for entity_id in sorted(entity_ids):
                state = hass.states.get(entity_id)
                if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                    raise ServiceValidationError(
                        f"Announcement player is unavailable: {entity_id}"
                    )
                features = state.attributes.get("supported_features", 0)
                if not features & MediaPlayerEntityFeature.PLAY_MEDIA:
                    raise ServiceValidationError(
                        f"Player cannot play announcement media: {entity_id}"
                    )
                entry = registry.async_get(entity_id)
                is_sonos = entry is not None and entry.platform == "sonos"
                previous_volume = state.attributes.get("volume_level")
                if volume is not None and not is_sonos and (
                    not features & MediaPlayerEntityFeature.VOLUME_SET
                    or not isinstance(previous_volume, (int, float))
                    or not math.isfinite(previous_volume)
                    or not 0 <= previous_volume <= 1
                ):
                    raise ServiceValidationError(f"Cannot restore the volume of {entity_id}")
                players.append((entity_id, is_sonos, previous_volume))

            # Wait for every target even if one fails; otherwise its sibling could
            # outlive the released locks and overlap a subsequent announcement.
            results = await asyncio.gather(
                *(
                    _async_announce_player(
                        hass, call, entity_id, is_sonos, previous_volume,
                        media_id, content_type, duration,
                    )
                    for entity_id, is_sonos, previous_volume in players
                ),
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, BaseException):
                    raise result

    hass.services.async_register(
        DOMAIN, "announce_media", handle_announcement, schema=_MEDIA_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, "announce_tts", handle_announcement, schema=_TTS_SCHEMA
    )

    descriptions = await hass.async_add_executor_job(
        load_yaml_dict, str(Path(__file__).with_name("services.yaml"))
    )
    tts_description = descriptions["announce_tts"]
    engine_selector = tts_description["fields"]["engine_id"]["selector"]["select"]

    @callback
    def async_update_tts_engines(event: Event | None = None) -> None:
        """Keep the native picker in sync with loaded entities and legacy providers."""

        if hass.is_stopping:
            return
        if event is not None:
            if event.event_type == EVENT_STATE_CHANGED:
                if not event.data["entity_id"].startswith("tts."):
                    return
            elif event.event_type in (EVENT_SERVICE_REGISTERED, EVENT_SERVICE_REMOVED):
                if event.data["domain"] != "tts":
                    return

        options: list[dict[str, str]] = []
        component = hass.data.get(tts.DATA_COMPONENT)
        if component is not None:
            for state in hass.states.async_all("tts"):
                # Restored states without a loaded engine are not usable choices.
                if component.get_entity(state.entity_id) is not None:
                    options.append({"value": state.entity_id, "label": state.name})
        manager = hass.data.get(tts.DATA_TTS_MANAGER)
        if manager is not None:
            for engine_id, provider in manager.providers.items():
                # Entity-backed legacy adapters would duplicate a modern engine.
                if not provider.has_entity:
                    options.append({"value": engine_id, "label": provider.name or engine_id})
        options.sort(key=lambda option: option["value"])
        if event is not None and options == engine_selector["options"]:
            return

        engine_selector["options"] = options
        async_set_service_schema(hass, DOMAIN, "announce_tts", tts_description)
        # Re-register the same handler to notify open editors through HA's service
        # event; its existing player locks and any running calls remain intact.
        hass.services.async_register(
            DOMAIN, "announce_tts", handle_announcement, schema=_TTS_SCHEMA
        )

    async_update_tts_engines()
    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, async_update_tts_engines)
    hass.bus.async_listen(EVENT_STATE_CHANGED, async_update_tts_engines)
    hass.bus.async_listen(EVENT_SERVICE_REGISTERED, async_update_tts_engines)
    hass.bus.async_listen(EVENT_SERVICE_REMOVED, async_update_tts_engines)


async def _async_announce_player(
    hass: HomeAssistant,
    call: ServiceCall,
    entity_id: str,
    is_sonos: bool,
    previous_volume: float | None,
    media_id: str,
    content_type: str,
    duration: float,
) -> None:
    """Play one prepared announcement and restore any volume changed by us."""

    volume = call.data.get("volume")
    restore_volume = volume is not None and not is_sonos
    data = {
        "entity_id": entity_id,
        "media_content_id": media_id,
        "media_content_type": content_type,
        "announce": True,
    }
    if is_sonos and volume is not None:
        data["extra"] = {"volume": round(volume * 100)}
    try:
        async with asyncio.timeout(duration + _PLAYBACK_TIMEOUT_RESERVE):
            if restore_volume:
                await hass.services.async_call(
                    "media_player", "volume_set",
                    {"entity_id": entity_id, "volume_level": volume},
                    blocking=True,
                    context=call.context,
                )
            started = asyncio.get_running_loop().time()
            await hass.services.async_call(
                "media_player", "play_media", data,
                blocking=True,
                context=call.context,
            )
            # Account for time already spent inside play_media on every player;
            # blocking integrations must not wait a second full audio duration.
            elapsed = asyncio.get_running_loop().time() - started
            remaining = duration + _START_RESERVE - elapsed
            if remaining > 0:
                await asyncio.sleep(remaining)
    except TimeoutError as err:
        raise HomeAssistantError(
            f"Announcement playback timed out: {entity_id}"
        ) from err
    finally:
        if restore_volume:
            playback_error = sys.exception()
            try:
                async with asyncio.timeout(_PLAYBACK_TIMEOUT_RESERVE):
                    await hass.services.async_call(
                        "media_player", "volume_set",
                        {"entity_id": entity_id, "volume_level": previous_volume},
                        blocking=True,
                        context=call.context,
                    )
            except Exception:
                if playback_error is None:
                    raise
                _LOGGER.exception(
                    "Could not restore announcement volume for %s", entity_id
                )
