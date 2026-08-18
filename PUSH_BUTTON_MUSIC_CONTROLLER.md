# Push-Button Music Controller

Hippo's Push-Button Music Controller turns one or two momentary on/off entities
into a complete music control. It is designed for wall switches such as KNX
buttons that change to `on` while pressed and back to `off` when released.

## Requirements

Create or select:

- one `binary_sensor`, `input_boolean`, or `switch` for the button;
- optionally, a distinct second entity from the same domains for dedicated
  volume-down control;
- one media player that supports browsing media, starting selected media,
  play, pause, and absolute volume changes;
- at least one playlist or favorite exposed by that player's Home Assistant
  Media Picker;
- one dedicated Text helper with a maximum length of 255 characters.

Do not share the Text helper with another automation or edit it manually. The
automation stores compact, versioned JSON there so sessions and volume direction
survive automation reloads and Home Assistant restarts.

Version 1 targets players whose content is available through Home Assistant's
Media Picker. Sonos favorites are the primary supported path. Native HomePod
players normally do not expose favorites or playlists there and are therefore
not supported in version 1. A future Music Assistant based path may make HomePod
support possible.

## Button behavior

Single- and double-tap behavior is identical on both configured buttons.

| Gesture                               | Result                                                |
| ------------------------------------- | ----------------------------------------------------- |
| Single tap while inactive             | Start Favorite 1 at the configured new-session volume |
| Single tap while playing or buffering | Pause the player                                      |
| Single tap during an active pause     | Resume playback                                       |
| Double-tap while inactive             | Start Favorite 2, or Favorite 1 if only one exists    |
| Double-tap during a known session     | Start the next favorite, wrapping at the end          |

If the first tap is followed by a second press that becomes a hold, the gesture
is only a long press. It does not also change the favorite. Button input is
ignored while a favorite is starting or failover is in progress.

With one configured button, the long-press direction starts upward and
alternates after every completed hold, including while the player is idle or
paused. Starting at the maximum forces the next fade downward; starting at the
minimum forces it upward.

With two distinct buttons, holding the first button only raises volume and
holding the second only lowers it. The buttons stop at their respective maximum
and minimum instead of reversing direction. The stored one-button direction is
left untouched, so removing the second button later restores the previous
alternation state. A hold never starts, pauses, or changes media.

Each gesture remains bound to the button that started it. Pressing or holding
the other button while a gesture, fade, or failover is already running is
ignored rather than being combined into a double-tap or long press. If both
button inputs select the same entity, the controller logs the configuration
problem and safely falls back to one-button alternating behavior.

## Sessions and volume

The configured start volume applies only to a new session. Resume and
double-tap preserve the reported player volume while clamping it into the
configured minimum and maximum range. If minimum and maximum are accidentally
reversed, the automation safely uses the lower value as the minimum and logs
the correction. The new-session volume is also clamped into that range.

A paused session remains resumable for 30 minutes. After that, the controller
logically resets without stopping or powering off the player; the next single
tap starts Favorite 1. `idle`, `off`, `on`, and `standby` reset immediately.
Transient `unknown` or `unavailable` states turn feedback off but preserve the
session. A player that is already paused when an empty helper is first attached
is not adopted as a session.

The player is the source of truth. Playback started outside this automation is
adopted, a single tap pauses it, and later player state changes update feedback.
Because track metadata changes during normal playback, the last known favorite
number is retained until the session resets or this automation successfully
starts another favorite.

## Favorite failover

Each favorite gets up to 10 seconds to reach the actual `playing` state.
`buffering` keeps both feedback outputs active, but does not count as success.
If an item fails, the automation logs the numbered favorite and tries every
remaining item once in cyclic order. A failed resume first retries the current
known favorite, followed by the rest.

Before replacing existing playback or retrying after buffering, the automation
pauses and confirms a non-playing baseline. This prevents the old stream from
being mistaken for a successful start. If the player cannot establish that
baseline, failover aborts safely. If every favorite fails, the listening session
is reset, feedback turns off, and the next single tap begins with Favorite 1.

The selected media content is always sent to the media player configured in the
blueprint. Any player or browse entity embedded by the Media Picker is ignored.
This lets every favorite share one explicit playback target.

## Status feedback

The optional Seeking and Playing outputs accept a `switch`, `input_boolean`, or
`light`. Calls are idempotent and isolated from playback errors, so a broken LED
output cannot prevent music control.

| Player/controller state         | Seeking | Playing |
| ------------------------------- | ------- | ------- |
| Starting a favorite or resuming | On      | On      |
| Buffering                       | On      | On      |
| Playing                         | Off     | On      |
| Paused or inactive              | Off     | Off     |
| Unknown or unavailable          | Off     | Off     |

For KNX, the Seeking entity can drive a group address configured to blink the
button LED, while Playing can drive its normal steady status indication.

## Configuration notes

The advanced gesture defaults are a 400 ms double-tap gap, a 700 ms long-press
threshold, and 15 seconds to traverse the complete configured volume range.
These timings apply equally to both buttons. Volume changes use
one-percentage-point steps.

The Logbook records successful favorite starts, every failed favorite, complete
failover, resume failures, and safety/configuration problems. Favorites are
identified as `Favorite 1`, `Favorite 2`, and so on; their list order is the
controller order.
