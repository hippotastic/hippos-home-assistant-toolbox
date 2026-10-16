# Announcements

Home Assistant's standard media playback and TTS actions return at different
points depending on the player integration. Some return as soon as an
announcement starts, while others wait until playback finishes. A following
automation step can therefore restore the volume too early or start another
announcement while the first is still playing.

The Toolbox determines the audio duration and waits for any time the playback
call did not already wait, plus a short start reserve. Media and TTS announcements
also share per-player queues, so separate automations can take turns on the same
player. This gives callers a consistent, duration-based wait without manually
supplying a duration for each file or spoken message.

The Toolbox provides two actions:

- `hippos_toolbox.announce_media` plays a local PCM WAV or MP3 file.
- `hippos_toolbox.announce_tts` generates speech through a configured Home
  Assistant TTS engine, caches it, and plays the resulting audio.

## Announce Media

Select an audio file using the action's media picker, or supply its local
media-source ID:

```yaml
action: hippos_toolbox.announce_media
target:
  entity_id: media_player.announcement_speaker
data:
  media:
    media_content_id: media-source://media_source/local/announcement.wav
  volume: 0.85
```

The file must be inside a configured Home Assistant media directory and contain
PCM WAV or MP3 audio. Files up to 64 MiB are supported. Direct web URLs and live
streams are not supported by this action. The duration is read from the file's
audio data, independently of the player's current track attributes.

## Announce TTS

Choose a configured TTS engine with `engine_id`. This accepts both current
entity IDs, such as `tts.speech_engine`, and legacy provider names,
such as `microsoft`:

```yaml
action: hippos_toolbox.announce_tts
target:
  entity_id: media_player.announcement_speaker
data:
  engine_id: microsoft
  message: Die Waschmaschine ist fertig.
  language: de-de
  cache: true
  volume: 0.7
```

`language` and `options` are optional. Leaving them unset uses the engine's
configured language and voice settings. Provider-specific options can be
passed in `options`; Home Assistant validates them for the selected engine.
Text, including any provider-supported SSML, is passed to the engine unchanged.

The action fully generates the audio before changing player volume or starting
playback. WAV is requested by default. Set `options.preferred_format: mp3` to
request MP3 instead; Home Assistant performs any required conversion.

Home Assistant owns the TTS cache. Text, engine, language and options determine
cache identity, so changing the voice or speaking rate generates different
audio. `cache` defaults to `true` and allows reuse from Home Assistant's disk
cache after a restart. `cache: false` disables disk caching; Home Assistant can
still reuse its short-lived memory cache, as with its standard TTS actions.
`tts.clear_cache` clears Home Assistant's speech cache.

## Targets and Volume

Both actions accept standard Home Assistant targets: entity IDs, devices,
areas, floors and labels. Indirect targets include only media players.
Multiple selected players receive the same prepared audio concurrently.

`volume` is optional and ranges from `0` to `1`. Leaving it unset keeps the
current volume; `0` explicitly requests silence. This differs from older
scripts that used zero to mean "leave unchanged."

For Sonos, volume is passed as the clip's `extra.volume`; Sonos restores its
normal playback volume itself. Other players have their volume changed before
playback and restored afterward, including after failures and cancellation.
These players must report a restorable volume and support setting it when a
volume is requested.

The Toolbox sends `announce: true` and relies on the media player's integration
for interruption and resumption of existing playback. It does not snapshot or
reconstruct a music queue. Native announcement behavior varies between players.

## Waiting and Concurrent Calls

After the blocking `media_player.play_media` call returns, the remaining wait is:

```text
max(0, audio duration + 1 second start reserve - elapsed play_media call time)
```

This rule applies to every integration. A Sonos call that returns immediately
leaves most of the duration to wait; a HomePod call that already waited for
playback leaves little or no remaining time. The reserve allows a short delay
before the device starts playing. This is a duration-based estimate, not a
confirmation of the speaker's actual playback end.

Media and TTS announcements share player locks. Calls with overlapping entity
IDs wait for one another, including during TTS generation. Calls with disjoint
targets can run concurrently. These locks coordinate Toolbox actions; direct
media-player commands from other automations remain independent.

Audio preparation has a 60-second timeout. Playback is bounded by the audio
duration plus 60 seconds, and restoring a changed volume has a separate
60-second timeout. Preparation failures change no player state. When one of
several players fails, the action waits for the other selected players to
finish before raising the error and releasing its locks.

## Replacing Existing Scripts

Replace the existing playback, volume and delay sequence with the corresponding
Toolbox action. For the previous script fields, map `player.entity_id` to the
action target and `media_file` to `media`. The TTS action additionally takes
`engine_id` and `message`; the old manually supplied delay can be removed.

These actions are integration code. Installing an integration release and
restarting Home Assistant makes them available; switching the blueprint update
channel alone does not install them.
