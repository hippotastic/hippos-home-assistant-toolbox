# Problem Monitoring

Add **Problem monitoring** from the three-dot menu of the toolbox integration
entry under **Settings > Devices & services**. One monitor can be configured per
toolbox installation. Reconfigure that entry to change its delays or labels.

The monitor reacts to source state and entity-label changes and schedules the next
pending deadline. It does not poll the warning macro or the HA state machine on a
fixed interval. Problem state is stored through Home Assistant's storage API.

## Warning rules

The following rules are combined, with one problem record per source entity:

- Binary sensors with device class `problem` warn while `on`.
- A `battery_state: critical` attribute warns after the critical battery delay.
- Entities with a selected **Warning when on** label warn while `on`.
- Selected **Warning below 30**, **Warning below 20**, and **Warning below 10**
  labels apply their respective numeric thresholds. Invalid numeric states do not
  confirm either a problem or its solution.
- **Ignored problems** labels exclude sources from these ordinary warning rules.

The existing **Alarm bei Status On** behavior is preserved: entities
with a selected **Alarm entities** label are excluded from ordinary warning rules,
but their `unavailable` state creates an availability warning after the configured
delay. This includes disconnected smoke detectors. An actual alarm (`on`) triggers an immediate `alarm_triggered` event, independently
of all warning delays. A reliably observed non-alarm state ends it immediately
with `alarm_solved`. Unknown, unavailable, or missing states do not end an ongoing
alarm. Confirmed alarms are persisted and do not trigger again after reloads.
An actual alarm is not also sent as an ordinary warning.
As in the legacy macro, alarm availability takes precedence over ordinary ignore
labels. An alarm entity in `unknown` confirms neither disconnection nor recovery.

Existing labels named **Warnung bei Status On**, **Alarm bei Status On**,
**Problem ignorieren**, and **Warnung bei < 30/20/10** are preselected if present.
Selections are stored as label IDs and continue working when a label is renamed.
The monitor uses labels assigned directly to entities, matching the legacy macro.

## Delays

| Setting                        | Default    | Meaning                                                  |
| ------------------------------ | ---------- | -------------------------------------------------------- |
| Warning delay                  | 1 minute   | Continuous ordinary problem before triggering            |
| Solution confirmation delay    | 10 minutes | Continuous reliable recovery before removal              |
| Alarm entity unavailable delay | 5 minutes  | Total continuous disconnection before triggering         |
| Critical battery delay         | 30 minutes | Total continuous critical battery flag before triggering |

Special delays replace the ordinary warning delay; they do not add another
minute. Battery percentage changes do not restart the critical battery delay
while the critical flag remains set. If several rules apply, an active ordinary
threshold/on rule can trigger sooner than the battery flag rule.

All delays are configurable in minutes. Zero disables that delay. An unconfirmed
problem that disappears is removed silently. Unknown, unavailable, and missing
ordinary sources never confirm a solution. Already triggered problems remain
open until their source reliably reports a solution for the entire solution delay.

Domain-specific helpers remain responsible for their own validity. For example,
a pool-dosing problem helper should expose `unavailable` while its pump is stopped
or warming up, `on` when an assessable problem is present, and `off` when it can
reliably confirm recovery. The monitor has no pool entity IDs or pump rules.

## Problem state and events

The **Open problems** sensor counts confirmed problems until they are resolved.
Its `problems` attribute also contains pending problems, keyed by source entity ID.
Each record contains its source `entity_id`, display `name`, classification
`reason`, and three timestamps:

- `trigger_delay_since`: start of the pending warning; cleared on triggering.
- `triggered_since`: confirmation time, retained through temporary disappearance.
- `solved_delay_since`: start of a pending reliable recovery.

The **Active alarms** sensor counts ongoing alarms and exposes their records in
its `alarms` attribute. An alarm which becomes unreachable stays open until a
reliable non-alarm state is observed. An availability warning can therefore coexist
with an ongoing alarm for the same source.

The **Problem changes** event entity emits `triggered`, `solved`, `alarm_triggered`,
and `alarm_solved`. Each event has
a `problem` attribute with the corresponding record; a solution event carries the
record which has just been removed. Notification automations should use the native
**Event received** trigger on this entity and read
`trigger.to_state.attributes.problem` from that event's snapshot. Filter event types
so warning and critical alarm notifications go through their respective actions.

For example, a notification can use the record's `name`, and append a disconnected
message when `reason == 'unavailable'`. The integration does not select recipients
or send phone notifications itself.

On restart or reload, confirmed problems retain `triggered_since` and do not
produce another `triggered` event. Pending warning and solution delays restart:
downtime is not observed continuous activity or recovery. Event generation is
persisted before publication; phone delivery acknowledgement is outside this
feature's scope.

## Migrating the existing warning setup

1. Make source validity explicit first, including the pool helper's `unavailable`
   phases. Keep the existing alarm automation active during preparation.
2. Add the monitor with the existing labels. Keep the existing notification
   automation connected to the old tracker while the new monitor builds its
   initial baseline. Do not connect a second notification automation yet.
3. Wait until the already reported active problems have `triggered_since` in the
   new sensor. This can take the battery or alarm availability delay. The new
   monitor's initial events do not notify anyone on their own.
4. Switch the existing notification automation to **Problem changes** and update
   the dashboard counter to **Open problems**. Past events are not replayed when
   a new automation is attached. Verify one new problem and one individual solution.
5. Switch the existing alarm notification automation to `alarm_triggered` and
   `alarm_solved`, preserving its critical notification action and recipients.
   Use **Active alarms** for the alarm list and visibility conditions.
6. Remove the old warning tracker, warning/alarm counter helpers, unused
   last-notification helpers, and monitoring macros after checking their consumers.

The monitor does not rewrite existing helpers, dashboards, macros, or automations
automatically.
