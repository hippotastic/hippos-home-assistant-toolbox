"""Deterministic media players for blueprint runtime tests."""

from __future__ import annotations

import asyncio
from typing import Any

import voluptuous as vol

from homeassistant.components.media_player import (
    BrowseMedia,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
    PLATFORM_SCHEMA,
)
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.entity_platform import AddEntitiesCallback


DOMAIN = "blueprint_test"
SERVICE_CONFIGURE = "configure_media_player"
TEST_STATES = [state.value for state in MediaPlayerState] + ["unavailable", "unknown"]

ENTITY_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Optional("state", default=MediaPlayerState.IDLE): vol.In(TEST_STATES),
        vol.Optional("volume_level", default=0.2): vol.All(
            vol.Coerce(float), vol.Range(min=0, max=1)
        ),
    }
)

PLATFORM_SCHEMA = PLATFORM_SCHEMA.extend(
    {vol.Required("entities"): [ENTITY_SCHEMA]}
)

CONFIGURE_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): str,
        vol.Optional("state"): vol.In(TEST_STATES),
        vol.Optional("volume_level"): vol.All(
            vol.Coerce(float), vol.Range(min=0, max=1)
        ),
        vol.Optional("pause_fails"): bool,
        vol.Optional("resume_fails"): bool,
        vol.Optional("shuffle"): bool,
        vol.Optional("volume_set_fails"): bool,
    }
)


async def async_setup_platform(
    hass: HomeAssistant,
    config: dict[str, Any],
    async_add_entities: AddEntitiesCallback,
    discovery_info: dict[str, Any] | None = None,
) -> None:
    """Set up configured fake media players."""

    players = [BlueprintTestMediaPlayer(hass, entity) for entity in config["entities"]]
    hass.data[DOMAIN].setdefault("media_players", {}).update(
        {player.entity_id: player for player in players}
    )
    async_add_entities(players)

    if hass.services.has_service(DOMAIN, SERVICE_CONFIGURE):
        return

    async def configure_media_player(call: ServiceCall) -> None:
        player = hass.data[DOMAIN]["media_players"].get(call.data["entity_id"])
        if player is None:
            raise ValueError(f"Unknown test media player: {call.data['entity_id']}")
        player.configure(call.data)

    hass.services.async_register(
        DOMAIN,
        SERVICE_CONFIGURE,
        configure_media_player,
        schema=CONFIGURE_SCHEMA,
    )


class BlueprintTestMediaPlayer(MediaPlayerEntity):
    """A media player whose content IDs select deterministic outcomes."""

    _attr_should_poll = False
    _attr_supported_features = (
        MediaPlayerEntityFeature.BROWSE_MEDIA
        | MediaPlayerEntityFeature.PAUSE
        | MediaPlayerEntityFeature.PLAY
        | MediaPlayerEntityFeature.PLAY_MEDIA
        | MediaPlayerEntityFeature.SHUFFLE_SET
        | MediaPlayerEntityFeature.VOLUME_SET
    )

    def __init__(self, hass: HomeAssistant, config: dict[str, Any]) -> None:
        self.hass = hass
        object_id = config["id"]
        self.entity_id = f"media_player.{object_id}"
        self._attr_name = object_id.replace("_", " ").title()
        self._attr_unique_id = object_id
        self._attr_available = config["state"] != "unavailable"
        self._attr_state = (
            None
            if config["state"] in ["unavailable", "unknown"]
            else MediaPlayerState(config["state"])
        )
        self._attr_volume_level = config["volume_level"]
        self._attr_media_content_id: str | None = None
        self._attr_media_content_type: str | None = None
        self._attr_shuffle = False
        self._pause_fails = False
        self._resume_fails = False
        self._volume_set_fails = False
        self._play_generation = 0

    def configure(self, data: dict[str, Any]) -> None:
        """Apply test-only state and behavior controls."""

        self._play_generation += 1
        if "state" in data:
            self._attr_available = data["state"] != "unavailable"
            self._attr_state = (
                None
                if data["state"] in ["unavailable", "unknown"]
                else MediaPlayerState(data["state"])
            )
        if "volume_level" in data:
            self._attr_volume_level = data["volume_level"]
        if "pause_fails" in data:
            self._pause_fails = data["pause_fails"]
        if "resume_fails" in data:
            self._resume_fails = data["resume_fails"]
        if "shuffle" in data:
            self._attr_shuffle = data["shuffle"]
        if "volume_set_fails" in data:
            self._volume_set_fails = data["volume_set_fails"]
        self.async_write_ha_state()

    async def async_media_pause(self) -> None:
        """Pause immediately unless the test configured a failure."""

        self._play_generation += 1
        if not self._pause_fails:
            self._attr_state = MediaPlayerState.PAUSED
            self.async_write_ha_state()

    async def async_media_play(self) -> None:
        """Resume immediately unless the test configured a failure."""

        self._play_generation += 1
        if not self._resume_fails:
            self._attr_state = MediaPlayerState.PLAYING
            self.async_write_ha_state()

    async def async_set_volume_level(self, volume: float) -> None:
        """Set volume immediately unless the test configured a failure."""

        if not self._volume_set_fails:
            self._attr_volume_level = volume
            self.async_write_ha_state()

    async def async_set_shuffle(self, shuffle: bool) -> None:
        """Set shuffle mode immediately."""

        self._attr_shuffle = shuffle
        self.async_write_ha_state()

    async def async_play_media(
        self,
        media_type: str,
        media_id: str,
        **kwargs: Any,
    ) -> None:
        """Use the test content ID to fail, buffer, or play immediately."""

        self._play_generation += 1
        generation = self._play_generation
        self._attr_media_content_id = media_id
        self._attr_media_content_type = media_type

        if media_id.startswith("test://fail/"):
            self.async_write_ha_state()
            return

        if media_id.startswith("test://slow/"):
            self._attr_state = MediaPlayerState.BUFFERING
            self.async_write_ha_state()
            self.hass.async_create_task(
                self._finish_slow_playback(generation),
                f"Finish test playback for {self.entity_id}",
            )
            return

        self._attr_state = MediaPlayerState.PLAYING
        self.async_write_ha_state()

    async def async_browse_media(
        self,
        media_content_type: str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        """Expose a minimal deterministic media tree."""

        return BrowseMedia(
            title="Test favorites",
            media_class=MediaType.PLAYLIST,
            media_content_id=media_content_id or "test://favorites",
            media_content_type=media_content_type or MediaType.PLAYLIST,
            can_play=False,
            can_expand=False,
            children=[],
        )

    async def _finish_slow_playback(self, generation: int) -> None:
        # The delay leaves enough time to press the button while the automation
        # owns a deterministic seeking/failover run.
        await asyncio.sleep(0.18)
        if generation != self._play_generation:
            return
        self._attr_state = MediaPlayerState.PLAYING
        self.async_write_ha_state()
