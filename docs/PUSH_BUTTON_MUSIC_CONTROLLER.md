# Push-Button Music Controller

**What is this?** An automation blueprint that turns one or two press/release wall buttons into a music controller for a supported media player. Single taps start, pause, or resume playback; double-taps skip tracks; triple-taps switch favorites; and holds adjust volume. If a favorite fails to start, it tries the next one; optional status lights show startup and playback.

**When should you use this?** When you want to allow anyone to quickly start playing music in your house, no matter if it's for cooking, working out, or just as a nice background - without the need to ever grab a phone, open an app, start a playlist and set the volume.

**Why is this included in the toolbox?** Transforming button press/release events into intuitive gestures like taps, multi-taps and long presses, and then using these gestures to control a music player isn't as simple as it might seem. Creating a controller automation yourself means deciding which gesture each press belongs to, tracking the current listening session, and handling failed playback and volume limits. This blueprint already does all the heavy lifting, allowing you to concentrate on what's really important: picking the perfect playlists.

## Requirements

Install the [toolbox integration](../README.md#installation) to make the blueprint available, or import it manually. Create or select:

- one `binary_sensor`, `input_boolean`, or `switch` for the button;
- optionally, a distinct second entity from the same domains for dedicated volume-down control;
- one media player that supports browsing media, starting selected media, play, pause, next-track, and absolute volume changes;
- shuffle control on that player if the optional Shuffle setting is enabled;
- at least one playlist or favorite exposed by that player's Home Assistant Media Picker;
- one dedicated Text helper with a maximum length of 255 characters.

Do not share the Text helper with another automation or edit it manually. The automation stores compact, versioned JSON there so sessions and volume direction survive automation reloads and Home Assistant restarts.

Version 1 targets players whose content is available through Home Assistant's Media Picker. Sonos favorites are the primary supported path. Native HomePod players normally do not expose favorites or playlists there and are therefore not supported by this controller.

## Setup

1. Create a dedicated **Text** helper under **Settings > Devices & services > Helpers**, with a maximum length of **255** characters.
2. Under **Settings > Automations & scenes**, create an automation from **Hippo's Push-Button Music Controller**. Installing the blueprint alone does not create the automation.
3. Select the first press/release button, the media player, and the Text helper. Optionally select a distinct second button for dedicated volume-down holds.
4. Add at least one favorite using the Media Picker. Arrange the list in playback order; the first item starts a new session.
5. Choose the starting volume and volume limits. Optionally enable shuffle and assign the Seeking and Playing feedback outputs.
6. Save and leave the automation enabled. From an inactive player, tap once to start the first favorite, then tap again to pause. Hold a button to check the configured volume behavior.

## Button behavior

Single-, double-, and triple-tap behavior is identical on both configured buttons.

| Gesture                               | Result                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| Single tap while inactive             | Start Favorite 1 at the configured new-session volume      |
| Single tap while playing or buffering | Pause the player                                           |
| Single tap during an active pause     | Resume playback                                            |
| Double-tap                            | Send next-track without changing session, volume, or state |
| Triple-tap while inactive             | Start Favorite 2, or Favorite 1 if only one exists         |
| Triple-tap during a known session     | Start the next favorite, wrapping at the end               |

If an earlier tap is followed by a second or third press that becomes a hold, the complete gesture is only a long press. It does not also skip a track or change the favorite. Button input is ignored while a favorite is starting or failover is in progress.

Double-tap forwards next-track even while the player is paused or inactive and does not force a playback-state change. The selected player decides the outcome; an inactive player will normally do nothing, while a paused player can remain paused on its next track. Double-tap waits one additional multi-tap window after the second release so a third tap can still upgrade the gesture.

With one configured button, the long-press direction starts upward and alternates after every completed hold, including while the player is idle or paused. Starting at the maximum forces the next fade downward; starting at the minimum forces it upward.

With two distinct buttons, holding the first button only raises volume and holding the second only lowers it. The buttons stop at their respective maximum and minimum instead of reversing direction. The stored one-button direction is left untouched, so removing the second button later restores the previous alternation state. A hold never starts, pauses, or changes media.

Each gesture remains bound to the button that started it. Pressing or holding the other button while a gesture, fade, or failover is already running is ignored rather than being combined into a double-tap or long press. If both button inputs select the same entity, the controller logs the configuration problem and safely falls back to one-button alternating behavior. Cross-button presses are never combined into a triple-tap either.

## Sessions and volume

The default start volume is 50%, with a 25% minimum and 75% maximum. The configured start volume applies only to a new session. Resume and triple-tap preserve the reported player volume while clamping it into the configured minimum and maximum range. If minimum and maximum are accidentally reversed, the automation safely uses the lower value as the minimum and logs the correction. The new-session volume is also clamped into that range.

A paused session remains resumable for 30 minutes. After that, the controller logically resets without stopping or powering off the player; the next single tap starts Favorite 1. `idle`, `off`, `on`, and `standby` reset immediately. Transient `unknown` or `unavailable` states turn feedback off but preserve the session. A player that is already paused when an empty helper is first attached is not adopted as a session.

The player is the source of truth. Playback started outside this automation is adopted, a single tap pauses it, and later player state changes update feedback. Because track metadata changes during normal playback, the last known favorite number is retained until the session resets or this automation successfully starts another favorite.

## Favorite failover

Each favorite gets up to 10 seconds to reach the actual `playing` state. `buffering` keeps both feedback outputs active, but does not count as success. If an item fails, the automation logs the numbered favorite and tries every remaining item once in cyclic order. A failed resume first retries the current known favorite, followed by the rest.

Before replacing existing playback or retrying after buffering, the automation pauses and confirms a non-playing baseline. This prevents the old stream from being mistaken for a successful start. If the player cannot establish that baseline, failover aborts safely. If every favorite fails, the listening session is reset, feedback turns off, and the next single tap begins with Favorite 1.

The selected media content is always sent to the media player configured in the blueprint. Any player or browse entity embedded by the Media Picker is ignored. This lets every favorite share one explicit playback target.

Shuffle is disabled by default. When enabled, the controller turns shuffle on after a favorite has successfully created its new queue. Failed favorites do not change shuffle. Leaving the option disabled preserves the player's existing shuffle state instead of forcing it off. A player that does not support Home Assistant's shuffle service still starts playback; the unsupported shuffle call is isolated from the favorite result.

## Status feedback

The optional Seeking and Playing outputs accept a `switch`, `input_boolean`, or `light`. Calls are idempotent and isolated from playback errors, so a broken LED output cannot prevent music control.

| Player/controller state         | Seeking | Playing |
| ------------------------------- | ------- | ------- |
| Starting a favorite or resuming | On      | On      |
| Buffering                       | On      | On      |
| Playing                         | Off     | On      |
| Paused or inactive              | Off     | Off     |
| Unknown or unavailable          | Off     | Off     |

For KNX, the Seeking entity can drive a group address configured to blink the button LED, while Playing can drive its normal steady status indication.

## Configuration notes

The advanced gesture defaults are a 400 ms gap between taps, a 700 ms long-press threshold, and 15 seconds to traverse the complete configured volume range. These timings apply equally to both buttons. Volume changes use one-percentage- point steps.

The Logbook records successful favorite starts, every failed favorite, complete failover, resume failures, and safety/configuration problems. Favorites are identified as `Favorite 1`, `Favorite 2`, and so on; their list order is the controller order.
