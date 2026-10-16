"""Regression tests for announcement audio, queues, volume and HA's TTS cache."""

import asyncio
from io import BytesIO
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import wave

import voluptuous as vol
import yaml
from packaging.requirements import Requirement
from packaging.version import Version

from homeassistant import loader
from homeassistant.components import ffmpeg, tts
from homeassistant.components.media_player import MediaPlayerEntityFeature
from homeassistant.components.media_source.models import PlayMedia
from homeassistant.config_entries import ConfigEntries, ConfigEntryState
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_SERVICE_REGISTERED
from homeassistant.core import Context, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.helpers import selector, service

from custom_components.hippos_toolbox import announcements, async_setup
from custom_components.hippos_toolbox.announcements import (
    _async_announce_player,
    _audio_duration,
    _read_audio_file,
)
from custom_components.hippos_toolbox.const import DOMAIN


def _wav(seconds=0.04, channels=1, rate=8000) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(bytes(round(seconds * rate) * channels * 2))
    return output.getvalue()


def _mp3(seconds=0.04) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
        input=_wav(seconds), capture_output=True, check=True,
    ).stdout


class AudioDurationTests(unittest.TestCase):
    def test_dependency_constraints_allow_both_test_and_current_ha_tts_versions(self) -> None:
        manifest = json.loads(
            Path(announcements.__file__).with_name("manifest.json").read_text()
        )
        self.assertIn("tts", manifest["dependencies"])
        # Core TTS owns Mutagen; upgrading HA must not force its downgrade
        for raw_requirement in manifest["requirements"]:
            requirement = Requirement(raw_requirement)
            if requirement.name == "mutagen":
                for version in ("1.47.0", "1.48.1"):
                    self.assertIn(Version(version), requirement.specifier)

    def test_service_metadata_matches_registered_actions(self) -> None:
        declarations = yaml.safe_load(
            Path(announcements.__file__).with_name("services.yaml").read_text()
        )
        service._SERVICES_SCHEMA(declarations)
        self.assertEqual(set(declarations), {"announce_media", "announce_tts"})
        for definition in declarations.values():
            for field in definition["fields"].values():
                selector.validate_selector(field["selector"])

    def test_pcm_duration_and_non_seekable_ffmpeg_wav(self) -> None:
        for channels, rate in ((1, 8000), (2, 48000)):
            with self.subTest(channels=channels, rate=rate):
                self.assertEqual(_audio_duration(_wav(1.25, channels, rate)), ("audio/wav", 1.25))

        # FFmpeg cannot update the sizes when writing WAV to a pipe
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "wav", "pipe:1"],
            input=_wav(1.25), capture_output=True, check=True,
        )
        self.assertEqual(_audio_duration(result.stdout), ("audio/wav", 1.25))

    def test_mp3_and_invalid_or_truncated_audio(self) -> None:
        content_type, duration = _audio_duration(_mp3(1.25))
        self.assertEqual(content_type, "audio/mpeg")
        self.assertGreater(duration, 1.2)
        self.assertLess(duration, 1.6)

        for data in (b"", b"not audio", b"RIFF0000WAVE", _wav()[:-4], _wav(0)):
            with self.subTest(data=data[:16]):
                with self.assertRaises(ServiceValidationError):
                    _audio_duration(data)

    def test_file_names_symlink_escape_and_size_limit(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            media.mkdir()
            sound = media / "Test's signal ä.wav"
            sound.write_bytes(_wav(1.25))
            self.assertEqual(_read_audio_file(sound, (str(media),)), ("audio/wav", 1.25))

            outside = root / "outside.wav"
            outside.write_bytes(_wav())
            (media / "escape.wav").symlink_to(outside)
            for path in (outside, media / "escape.wav", media / "missing.wav", media):
                with self.subTest(path=path):
                    with self.assertRaises(ServiceValidationError):
                        _read_audio_file(path, (str(media),))
            with patch.object(announcements, "_MAX_AUDIO_BYTES", 10):
                with self.assertRaises(ServiceValidationError):
                    _read_audio_file(sound, (str(media),))


class CompletionWaitTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_only_remaining_duration_for_every_integration(self) -> None:
        for sonos in (True, False):
            for call_duration, expected_wait in ((0, 3), (0.75, 2.25), (2.5, 0.5), (4, 0)):
                with self.subTest(sonos=sonos, call_duration=call_duration):
                    clock = SimpleNamespace(now=10.0)

                    async def play(*_args, **_kwargs):
                        clock.now += call_duration

                    sleep = AsyncMock()
                    timer = SimpleNamespace(
                        timeout=asyncio.timeout,
                        sleep=sleep,
                        get_running_loop=lambda: SimpleNamespace(time=lambda: clock.now),
                    )
                    hass = SimpleNamespace(services=SimpleNamespace(async_call=play))
                    call = SimpleNamespace(data={}, context=Context())
                    with patch.object(announcements, "asyncio", timer):
                        await _async_announce_player(
                            hass, call, "media_player.test", sonos, 0.2,
                            "media-source://test", "audio/wav", 2,
                        )
                    if expected_wait:
                        sleep.assert_awaited_once_with(expected_wait)
                    else:
                        sleep.assert_not_awaited()


class _Provider(tts.Provider):
    name = "Test speech"

    def __init__(self, audio: bytes) -> None:
        self.audio = audio
        self.calls: list[tuple[str, str, dict]] = []
        self.gate: asyncio.Event | None = None

    @property
    def default_language(self):
        return "de-de"

    @property
    def supported_languages(self):
        return ["de-de", "en-us"]

    @property
    def supported_options(self):
        return ["preferred_format", "voice"]

    async def async_get_tts_audio(self, message, language, options):
        self.calls.append((message, language, options))
        if self.gate is not None:
            await self.gate.wait()
        return "wav", self.audio


class _SpeechEntity(tts.TextToSpeechEntity):
    _attr_name = "Modern test speech"
    _attr_default_language = "de-de"
    _attr_supported_languages = ["de-de"]
    _attr_supported_options = ["preferred_format"]

    async def async_get_tts_audio(self, message, language, options):
        return "wav", _wav()


class AnnouncementServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.media = self.root / "media"
        self.media.mkdir()
        self.file = self.media / "Notification Sound.wav"
        self.file.write_bytes(_wav())
        self.media_id = "media-source://media_source/local/Notification Sound.wav"
        self.hass = HomeAssistant(str(self.root))
        (self.root / "custom_components").symlink_to(Path(announcements.__file__).parent.parent)
        loader.async_setup(self.hass)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        self.hass.config.media_dirs = {"local": str(self.media)}
        self.loaded = SimpleNamespace(state=ConfigEntryState.LOADED)
        self.entries_patch = patch.object(self.hass.config_entries, "async_entries", return_value=[self.loaded])
        self.entries_patch.start()
        self.registry = er.async_get(self.hass)
        await self.registry.async_load(load_empty=True)
        await ar.async_get(self.hass).async_load(load_empty=True)
        dr.async_get(self.hass).async_setup()
        await dr.async_get(self.hass).async_load(load_empty=True)
        self.sonos = self.registry.async_get_or_create(
            "media_player", "sonos", "sonos", suggested_object_id="sonos", config_entry=None,
        ).entity_id
        self.homepod = self.registry.async_get_or_create(
            "media_player", "apple_tv", "homepod", suggested_object_id="homepod", config_entry=None,
        ).entity_id
        for entity_id in (self.sonos, self.homepod):
            self.hass.states.async_set(entity_id, "idle", {
                "volume_level": 0.2,
                "supported_features": MediaPlayerEntityFeature.PLAY_MEDIA | MediaPlayerEntityFeature.VOLUME_SET,
            })
        self.calls: list[ServiceCall] = []
        self.play_started = asyncio.Event()
        self.play_gate: asyncio.Event | None = None
        self.fail_player: str | None = None

        async def record(call):
            self.calls.append(call)
            if call.service == "play_media":
                if call.data["media_content_id"].startswith("media-source://tts/"):
                    await tts.async_get_media_source_audio(self.hass, call.data["media_content_id"])
                self.play_started.set()
                if call.data["entity_id"] == self.fail_player:
                    raise HomeAssistantError("Playback failed")
                if self.play_gate is not None:
                    await self.play_gate.wait()

        self.hass.services.async_register("media_player", "play_media", record)
        self.hass.services.async_register("media_player", "volume_set", record)
        self.resolve_patch = patch.object(
            announcements.media_source, "async_resolve_media",
            new=AsyncMock(return_value=PlayMedia("/media/local/sound.wav", "audio/wav", path=self.file)),
        )
        self.resolve_patch.start()
        self.reserve_patch = patch.object(announcements, "_START_RESERVE", 0)
        self.reserve_patch.start()
        self.provider = _Provider(_wav())
        self.manager = tts.SpeechManager(self.hass, True, "tts", 300)
        await self.manager.async_init_cache()
        self.manager.providers["test"] = self.provider
        self.hass.data[tts.DATA_TTS_MANAGER] = self.manager
        self.hass.data[tts.DATA_COMPONENT] = SimpleNamespace(get_entity=lambda _: None)
        self.hass.data[ffmpeg.DATA_FFMPEG] = SimpleNamespace(binary="ffmpeg")
        await async_setup(self.hass, {})

    async def asyncTearDown(self) -> None:
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.resolve_patch.stop()
        self.reserve_patch.stop()
        self.entries_patch.stop()
        await self.hass.async_stop(force=True)
        self.directory.cleanup()

    async def _announce(self, entity_id=None, *, service="announce_media", **data):
        payload = {"entity_id": entity_id or self.sonos}
        if service == "announce_media":
            payload["media"] = {"media_content_id": self.media_id}
        else:
            payload.update(engine_id="test", message="Hello")
        payload.update(data)
        await self.hass.services.async_call(DOMAIN, service, payload, blocking=True)

    async def test_registered_names_and_sonos_clip_volume(self) -> None:
        self.assertTrue(self.hass.services.has_service(DOMAIN, "announce_media"))
        self.assertTrue(self.hass.services.has_service(DOMAIN, "announce_tts"))
        self.assertFalse(self.hass.services.has_service(DOMAIN, "announce_file"))
        context = Context()
        await self.hass.services.async_call(
            DOMAIN, "announce_media",
            {"entity_id": self.sonos, "media": {"media_content_id": self.media_id}, "volume": 0.85},
            blocking=True, context=context,
        )
        self.assertEqual([call.service for call in self.calls], ["play_media"])
        self.assertEqual(self.calls[0].data["extra"], {"volume": 85})
        self.assertTrue(self.calls[0].data["announce"])
        self.assertIs(self.calls[0].context, context)

    async def test_engine_picker_lists_modern_and_legacy_engines(self) -> None:
        descriptions = await service.async_get_all_descriptions(self.hass)
        definition = descriptions[DOMAIN]["announce_tts"]
        self.assertEqual(definition["fields"]["engine_id"]["selector"], {
            "select": {"options": [{"value": "test", "label": "Test speech"}],
                       "mode": "dropdown", "sort": True},
        })

        entity = _SpeechEntity()
        entity.entity_id = "tts.modern_test"
        self.hass.data[tts.DATA_COMPONENT].get_entity = {entity.entity_id: entity}.get
        self.manager.providers["modern_adapter"] = SimpleNamespace(has_entity=True, name="Duplicate")
        self.manager.providers["unnamed"] = SimpleNamespace(has_entity=False, name=None)
        self.hass.states.async_set(entity.entity_id, "unknown", {"friendly_name": "Modern speech"})
        self.hass.states.async_set("tts.orphan", "unavailable", {"restored": True})
        await self.hass.async_block_till_done()

        descriptions = await service.async_get_all_descriptions(self.hass)
        definition = descriptions[DOMAIN]["announce_tts"]
        engine_selector = definition["fields"]["engine_id"]["selector"]
        self.assertEqual(engine_selector["select"]["options"], [
            {"value": "test", "label": "Test speech"},
            {"value": "tts.modern_test", "label": "Modern speech"},
            {"value": "unnamed", "label": "unnamed"},
        ])
        picker = selector.SelectSelector(engine_selector["select"])
        self.assertEqual(picker("test"), "test")
        self.assertEqual(picker("tts.modern_test"), "tts.modern_test")
        with self.assertRaises(vol.Invalid):
            picker("misspelled")
        self.assertTrue(definition["fields"]["engine_id"]["required"])
        self.assertTrue(definition["fields"]["message"]["selector"]["text"]["multiline"])
        self.assertEqual(set(definition["fields"]), {
            "engine_id", "message", "language", "options", "cache", "volume",
        })
        self.assertEqual(
            selector.TargetSelector.CONFIG_SCHEMA(definition["target"]),
            selector.TargetSelector.CONFIG_SCHEMA({"entity": {"domain": "media_player"}}),
        )

    async def test_engine_picker_tracks_entity_names_ids_and_removal(self) -> None:
        entity = _SpeechEntity()
        entity.entity_id = "tts.first"
        engines = {entity.entity_id: entity}
        self.hass.data[tts.DATA_COMPONENT].get_entity = engines.get
        self.hass.states.async_set(entity.entity_id, "unknown", {"friendly_name": "First name"})
        await self.hass.async_block_till_done()
        notifications = []
        self.hass.bus.async_listen(
            EVENT_SERVICE_REGISTERED, callback(lambda event: notifications.append(event.data)),
        )

        self.hass.states.async_set(entity.entity_id, "unknown", {"friendly_name": "New name"})
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertIn({"value": "tts.first", "label": "New name"}, options)
        self.assertEqual(notifications, [{"domain": DOMAIN, "service": "announce_tts"}])

        # Speech timestamps and unrelated entities must not refresh open editors
        self.hass.states.async_set(entity.entity_id, "2026-10-16T10:00:00+00:00", {"friendly_name": "New name"})
        self.hass.states.async_set("sensor.unrelated", "on")
        await self.hass.async_block_till_done()
        self.assertEqual(len(notifications), 1)

        engines.pop("tts.first")
        self.hass.states.async_remove("tts.first")
        entity.entity_id = "tts.renamed"
        engines[entity.entity_id] = entity
        self.hass.states.async_set(entity.entity_id, "unknown", {"friendly_name": "New name"})
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertEqual(options, [
            {"value": "test", "label": "Test speech"},
            {"value": "tts.renamed", "label": "New name"},
        ])

        engines.clear()
        self.hass.states.async_remove(entity.entity_id)
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertEqual(options, [{"value": "test", "label": "Test speech"}])

    async def test_engine_picker_refreshes_after_startup_and_legacy_service_changes(self) -> None:
        # A legacy engine may finish loading after the toolbox's initial setup
        self.manager.providers["late"] = SimpleNamespace(has_entity=False, name="Late speech")
        self.hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertIn({"value": "late", "label": "Late speech"}, options)

        self.manager.providers["custom"] = SimpleNamespace(has_entity=False, name="Custom speech")
        self.hass.services.async_register("tts", "custom_service_name", AsyncMock())
        service.async_set_service_schema(self.hass, "tts", "custom_service_name", {})
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertIn({"value": "custom", "label": "Custom speech"}, options)

        self.manager.providers.clear()
        self.hass.services.async_remove("tts", "custom_service_name")
        await self.hass.async_block_till_done()
        descriptions = await service.async_get_all_descriptions(self.hass)
        options = descriptions[DOMAIN]["announce_tts"]["fields"]["engine_id"]["selector"]["select"]["options"]
        self.assertEqual(options, [])

    async def test_engine_picker_refresh_keeps_running_player_queue(self) -> None:
        self.provider.gate = asyncio.Event()
        first = asyncio.create_task(self._announce(service="announce_tts"))
        await self.hass.async_block_till_done()

        self.manager.providers["other"] = _Provider(_wav())
        self.hass.services.async_register("tts", "other_say", AsyncMock())
        await self.hass.async_block_till_done()
        second = asyncio.create_task(self._announce(service="announce_tts", message="Second"))
        await self.hass.async_block_till_done()
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(self.calls, [])

        self.provider.gate.set()
        await asyncio.wait_for(asyncio.gather(first, second), 2)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual([call.service for call in self.calls], ["play_media", "play_media"])

    async def test_homepod_volume_order_and_zero_volume(self) -> None:
        await self._announce(self.homepod, volume=0)
        self.assertEqual([call.service for call in self.calls], ["volume_set", "play_media", "volume_set"])
        self.assertEqual(self.calls[0].data["volume_level"], 0)
        self.assertEqual(self.calls[-1].data["volume_level"], 0.2)
        self.assertNotIn("extra", self.calls[1].data)
        self.calls.clear()
        await self._announce(self.homepod)
        self.assertEqual([call.service for call in self.calls], ["play_media"])

    async def test_early_return_does_not_finish_before_audio_duration(self) -> None:
        self.file.write_bytes(_wav(0.15))
        task = asyncio.create_task(self._announce())
        await self.play_started.wait()
        await asyncio.sleep(0.02)
        self.assertFalse(task.done())
        await asyncio.wait_for(task, 1)

    async def test_failed_and_cancelled_playback_restore_volume_and_release_queue(self) -> None:
        self.fail_player = self.homepod
        with self.assertRaisesRegex(HomeAssistantError, "Playback failed"):
            await self._announce(self.homepod, volume=0.8)
        self.assertEqual(self.calls[-1].data["volume_level"], 0.2)

        self.fail_player = None
        self.play_started.clear()
        self.play_gate = asyncio.Event()
        task = asyncio.create_task(self._announce(self.homepod, volume=0.8))
        await self.play_started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.calls[-1].data["volume_level"], 0.2)
        self.play_gate = None
        await asyncio.wait_for(self._announce(self.homepod, volume=0.8), 1)

    async def test_overlapping_targets_wait_for_all_siblings_after_one_fails(self) -> None:
        self.fail_player = self.sonos
        self.play_gate = asyncio.Event()
        first = asyncio.create_task(self._announce([self.sonos, self.homepod], volume=0.8))
        await self.play_started.wait()
        await asyncio.sleep(0.02)
        second = asyncio.create_task(self._announce(self.homepod))
        await asyncio.sleep(0.02)
        self.assertFalse(first.done())
        self.assertEqual(sum(call.service == "play_media" for call in self.calls), 2)
        self.play_gate.set()
        with self.assertRaisesRegex(HomeAssistantError, "Playback failed"):
            await first
        await asyncio.wait_for(second, 1)
        self.assertEqual(sum(call.service == "play_media" for call in self.calls), 3)

    async def test_file_and_tts_share_queue_while_other_players_run(self) -> None:
        self.provider.gate = asyncio.Event()
        first = asyncio.create_task(self._announce(service="announce_tts"))
        await self.hass.async_block_till_done()
        second = asyncio.create_task(self._announce())
        await self._announce(self.homepod)
        self.assertEqual([call.data["entity_id"] for call in self.calls], [self.homepod])
        self.provider.gate.set()
        await asyncio.wait_for(asyncio.gather(first, second), 2)
        self.assertEqual([call.data["entity_id"] for call in self.calls], [self.homepod, self.sonos, self.sonos])
        self.assertTrue(self.calls[1].data["media_content_id"].startswith("media-source://tts/"))
        self.assertEqual(self.calls[2].data["media_content_id"], self.media_id)

    async def test_real_ha_tts_cache_includes_message_language_and_options(self) -> None:
        for data in ({}, {}, {"message": "Different"}, {"language": "en-us"}, {"options": {"voice": "other"}}):
            await self._announce(service="announce_tts", **data)
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.assertEqual(len(self.provider.calls), 4)
        self.assertEqual(len(self.manager.file_cache), 4)
        self.assertEqual(self.provider.calls[0][2]["preferred_format"], "wav")

        # Recreate HA's manager to prove reuse from its persistent cache
        restored = tts.SpeechManager(self.hass, True, "tts", 300)
        await restored.async_init_cache()
        restored.providers["test"] = self.provider
        self.hass.data[tts.DATA_TTS_MANAGER] = restored
        await self._announce(service="announce_tts")
        self.assertEqual(len(self.provider.calls), 4)

    async def test_tts_cache_disabled_and_engine_is_part_of_cache_identity(self) -> None:
        await self._announce(service="announce_tts", cache=False)
        await self.hass.async_block_till_done(wait_background_tasks=True)
        self.assertFalse(self.manager.file_cache)
        other = _Provider(_wav())
        self.manager.providers["other"] = other
        await self._announce(service="announce_tts", engine_id="other")
        self.assertEqual(len(other.calls), 1)

    async def test_modern_tts_entity_and_mp3_to_wav_conversion_use_ha_cache(self) -> None:
        entity = _SpeechEntity()
        entity.hass = self.hass
        entity.entity_id = "tts.modern_test"
        self.hass.data[tts.DATA_COMPONENT] = SimpleNamespace(
            get_entity=lambda engine: entity if engine == entity.entity_id else None,
        )
        with patch.object(entity, "async_write_ha_state", Mock()):
            await self._announce(service="announce_tts", engine_id=entity.entity_id)

        # Exercise HA's real conversion, including the unbounded WAV data header
        with patch.object(self.provider, "async_get_tts_audio", AsyncMock(return_value=("mp3", _mp3()))) as synthesize:
            await self._announce(service="announce_tts")
            await self._announce(service="announce_tts")
            synthesize.assert_awaited_once()
        self.assertTrue(all(call.data["media_content_type"] == "audio/wav" for call in self.calls))

    async def test_volume_snapshot_is_taken_after_slow_synthesis(self) -> None:
        self.provider.gate = asyncio.Event()
        task = asyncio.create_task(self._announce(self.homepod, service="announce_tts", volume=0.8))
        await self.hass.async_block_till_done()
        self.hass.states.async_set(self.homepod, "idle", {
            "volume_level": 0.4,
            "supported_features": MediaPlayerEntityFeature.PLAY_MEDIA | MediaPlayerEntityFeature.VOLUME_SET,
        })
        self.provider.gate.set()
        await asyncio.wait_for(task, 1)
        self.assertEqual(self.calls[-1].data["volume_level"], 0.4)

    async def test_preparation_and_playback_timeouts_release_targets(self) -> None:
        self.provider.gate = asyncio.Event()
        with patch.object(announcements, "_PREPARATION_TIMEOUT", 0.01):
            with self.assertRaisesRegex(HomeAssistantError, "preparation timed out"):
                await self._announce(self.homepod, service="announce_tts", volume=0.8)
        self.assertFalse(self.calls)
        self.provider.gate.set()

        self.play_gate = asyncio.Event()
        with patch.object(announcements, "_PLAYBACK_TIMEOUT_RESERVE", 0.01):
            with self.assertRaisesRegex(HomeAssistantError, "playback timed out"):
                await self._announce(self.homepod, volume=0.8)
        self.assertEqual(self.calls[-1].data["volume_level"], 0.2)
        self.play_gate = None
        await asyncio.wait_for(self._announce(self.homepod), 1)

    async def test_invalid_tts_source_options_and_audio_do_not_change_players(self) -> None:
        for data in (
            {"engine_id": "missing"},
            {"options": {"unsupported": True}},
            {"options": {"preferred_format": "ogg"}},
            {"language": "invalid"},
        ):
            with self.subTest(data=data):
                with self.assertRaises(HomeAssistantError):
                    await self._announce(self.homepod, service="announce_tts", volume=0.8, **data)
        self.provider.audio = b"not audio"
        with self.assertRaises(ServiceValidationError):
            await self._announce(self.homepod, service="announce_tts", volume=0.8)
        self.assertFalse(self.calls)

    async def test_area_targets_filter_out_non_media_entities(self) -> None:
        area = ar.async_get(self.hass).async_create("Living room")
        self.registry.async_update_entity(self.sonos, area_id=area.id)
        sensor = self.registry.async_get_or_create("sensor", "test", "sensor", config_entry=None)
        self.registry.async_update_entity(sensor.entity_id, area_id=area.id)
        await self.hass.services.async_call(
            DOMAIN, "announce_media", {"area_id": area.id, "media": {"media_content_id": self.media_id}}, blocking=True,
        )
        self.assertEqual([call.data["entity_id"] for call in self.calls], [self.sonos])

    async def test_invalid_audio_targets_and_unrestorable_volume_fail_before_playback(self) -> None:
        self.file.write_bytes(b"not audio")
        with self.assertRaises(ServiceValidationError):
            await self._announce(self.homepod, volume=0.8)
        self.file.write_bytes(_wav())
        self.hass.states.async_set(self.homepod, "idle", {})
        for data in (
            {"entity_id": self.homepod, "volume": 0.8},
            {"entity_id": "media_player.missing"},
            {"entity_id": "sensor.test"},
            {"volume": float("nan")},
            {"volume": -0.1},
            {"media": {"media_content_id": "https://example.test/sound.wav"}},
        ):
            with self.subTest(data=data):
                with self.assertRaises((ServiceValidationError, HomeAssistantError, vol.Invalid)):
                    await self._announce(**data)
        self.loaded.state = ConfigEntryState.NOT_LOADED
        with self.assertRaises(ServiceValidationError):
            await self._announce()
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
