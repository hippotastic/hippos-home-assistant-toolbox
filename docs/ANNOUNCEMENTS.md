# Announcements

**What is this?** A set of actions you can use in your automations and scripts to play announcements on supported speakers. You can either play an audio file or TTS-generated speech, and the actions are able to temporarily set the announcement volume, wait for the announcement to finish, and restore any volume they changed before handing control back to your code. Also, multiple announcements sent to the same speaker are automatically queued to play one after another without conflicts.

**When should you use this?** When you want your smart home to play a doorbell sound or speak a reminder and then continue an automation, without having to worry about volume management, playback durations or multiple announcements overlapping one another.

**Why is this included in the toolbox?** Home Assistant's playback action does not consistently wait for an announcement to finish across media player integrations. Some players return instantly, some wait for the announcement to complete. Using fixed delays in your automations are only a workaround as they need to be adjusted whenever the announcement changes. Building a reusable announcement sequence yourself therefore means determining each audio file's duration, accounting for time already spent in the playback call, restoring volume even after errors, and coordinating messages from several automations that share a speaker.

## Before you start

Install and configure the [toolbox integration](../README.md#installation). The actions become available with the integration; there is no separate announcement entry to add. Select a media player that supports announcements. For file playback, place a PCM WAV or MP3 file in a configured Home Assistant media directory. For speech, configure a Home Assistant TTS engine first.

## Choose an action

The toolbox provides two actions:

- `hippos_toolbox.announce_media` plays a local PCM WAV or MP3 file.
- `hippos_toolbox.announce_tts` generates speech through a configured Home Assistant TTS engine, caches it, and plays the resulting audio.

## Announce Media

Select an audio file using the action's media picker, or supply its local media-source ID:

```yaml
action: hippos_toolbox.announce_media
target:
  entity_id: media_player.announcement_speaker
data:
  media:
    media_content_id: media-source://media_source/local/announcement.wav
  volume: 0.85
```

The file must be inside a configured Home Assistant media directory and contain PCM WAV or MP3 audio. Files up to 64 MiB are supported. Direct web URLs and live streams are not supported by this action. The duration is read from the file's audio data, independently of the player's current track attributes.

## Announce TTS

Choose a configured TTS engine from the action's dropdown. It lists loaded TTS entities and legacy providers by name and updates when engines are added, renamed or removed. In YAML, `engine_id` accepts both current entity IDs, such as `tts.speech_engine`, and legacy provider names, such as `microsoft`:

```yaml
action: hippos_toolbox.announce_tts
target:
  entity_id: media_player.announcement_speaker
data:
  engine_id: tts.speech_engine
  message: The task is complete.
  language: en-us
  cache: true
  volume: 0.7
```

`language` and `options` are optional. Leaving them unset uses the engine's configured language and voice settings. Provider-specific options can be passed in `options`; Home Assistant validates them for the selected engine. Text, including any provider-supported SSML, is passed to the engine unchanged.

The action fully generates the audio before changing player volume or starting playback. WAV is requested by default. Set `options.preferred_format: mp3` to request MP3 instead; Home Assistant performs any required conversion.

Home Assistant owns the TTS cache. Text, engine, language and options determine cache identity, so changing the voice or speaking rate generates different audio. `cache` defaults to `true` and allows reuse from Home Assistant's disk cache after a restart. `cache: false` disables disk caching; Home Assistant can still reuse its short-lived memory cache, as with its standard TTS actions. `tts.clear_cache` clears Home Assistant's speech cache.

## Targets and Volume

Both actions accept standard Home Assistant targets: entity IDs, devices, areas, floors and labels. Indirect targets include only media players. Multiple selected players receive the same prepared audio concurrently.

`volume` is optional and ranges from `0` to `1`. Leaving it unset keeps the current volume; `0` explicitly requests silence.

For Sonos, volume is passed as the clip's `extra.volume`; Sonos restores its normal playback volume itself. Other players have their volume changed before playback and restored afterward, including after failures and cancellation. These players must report a restorable volume and support setting it when a volume is requested.

The Toolbox sends `announce: true` and relies on the media player's integration for interruption and resumption of existing playback. It does not snapshot or reconstruct a music queue. Native announcement behavior varies between players.

## Waiting and Concurrent Calls

After the blocking `media_player.play_media` call returns, the remaining wait is:

```text
max(0, audio duration + 1 second start reserve - elapsed play_media call time)
```

This rule applies to every integration. A Sonos call that returns immediately leaves most of the duration to wait; a HomePod call that already waited for playback leaves little or no remaining time. The reserve allows a short delay before the device starts playing. This is a duration-based estimate, not a confirmation of the speaker's actual playback end.

Media and TTS announcements share player locks. Calls with overlapping entity IDs wait for one another, including during TTS generation. Calls with disjoint targets can run concurrently. These locks coordinate Toolbox actions; direct media-player commands from other automations remain independent.

Audio preparation has a 60-second timeout. Playback is bounded by the audio duration plus 60 seconds, and restoring a changed volume has a separate 60-second timeout. Preparation failures change no player state. When one of several players fails, the action waits for the other selected players to finish before raising the error and releasing its locks.

## Using announcements in automations

Use the corresponding Toolbox action in place of a separate playback, volume, and delay sequence. Select the player through the action target and the audio file through `media`. Text announcements take `engine_id` and `message` instead. Both actions include the duration-based wait.

These actions are integration code. Installing an integration release and restarting Home Assistant makes them available; switching the blueprint update channel alone does not install them.
