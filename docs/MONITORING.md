# Problem Monitoring

**What is this?** An optional integration feature that watches for device problems and alarms and keeps a record until each one is resolved. You choose what it monitors, who receives warnings and alarms, and how the messages are worded. It notifies those recipients when an incident is confirmed or resolved and keeps open incidents across Home Assistant restarts.

**When should you use this?** When you want to know that a device needs attention before you rely on it, without having to check every battery and sensor yourself.

**Why is this included in the toolbox?** Creating a system that notifies you when your smart home requires attention without annoying you can be surprisingly tricky. You need to distinguish a brief glitch from a real continuing fault, and a missing reading from proof that a fault has cleared. You need to prevent Home Assistant restarts from either producing duplicate warnings or premature all-clear messages. Creating your own automations for this would leave you managing confirmation delays, incident state across restarts, recovery messages, and delivery failures for every rule.

## Understand warnings and alarms

| Category | Typical use | When it starts | When it ends |
| --- | --- | --- | --- |
| Warning | Device problem, low battery, numeric threshold, disconnected alarm source | After the applicable warning delay | After continuous reliable recovery for the solution delay |
| Alarm | An entity selected through an **Alarm entities** label turns `on` | Immediately | Immediately when a reliable non-alarm state is observed |

For example, a marked smoke detector reporting `on` creates an alarm. The same source becoming `unavailable` creates a warning after the disconnection delay. Losing contact with an active alarm source does not end its alarm.

With the default delays, an ordinary problem present for one minute is confirmed and reported. If the source then recovers, it must remain reliably healthy for ten minutes before the problem is closed and an all-clear is sent. A return of the problem or an unknown reading interrupts that recovery period.

## Setup

### 1. Prepare the installation

Install and configure the [toolbox integration](../README.md#installation). Installing the toolbox does **not** create or start monitoring. One monitor can be added per toolbox installation.

Decide which sources need attention. The monitor uses existing Home Assistant entities; it does not create sensors for devices. The next steps explain which sources are detected automatically and which require a label.

If using phone notifications, connect the Home Assistant Companion app to this installation and allow notifications. Its `notify` entity will appear in the recipient selector. To maintain a shared recipient list, create a notification group under **Settings > Devices & services > Helpers > Create helper > Group**. Groups are optional: selecting several individual targets works too.

### 2. Add the monitor

Open **Settings > Devices & services**, find the toolbox integration entry, and select **Add problem monitoring** from its three-dot menu. The form contains automatic rules, delays, label selections, and separate **Warnings** and **Alarms** notification sections.

### 3. Choose automatic detection

The first two switches are enabled by default. Both work without labels:

| Switch                                           | Sources it detects                                             |
| ------------------------------------------------ | -------------------------------------------------------------- |
| **Automatically monitor problem sensors**        | Binary sensors with device class `problem`, warning while `on` |
| **Automatically monitor critical battery flags** | Entities reporting the attribute `battery_state: critical`     |

Turn either switch off if you do not want that automatic rule. A battery sensor with a low percentage but no `battery_state: critical` attribute is not detected by the battery switch; use a numeric label rule in step 5 instead.

Existing monitors without saved switch settings keep both enabled. Label rules remain independent of these switches.

### 4. Set confirmation delays

| Field                              | Default    | What must remain continuous                                            |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------- |
| **Warning delay**                  | 1 minute   | An ordinary problem before it is reported                              |
| **Solution confirmation delay**    | 10 minutes | Reliable recovery before an ordinary problem is closed                 |
| **Alarm entity unavailable delay** | 5 minutes  | An alarm source reporting `unavailable` before a disconnection warning |
| **Critical battery delay**         | 30 minutes | A critical battery flag before it is reported                          |

All values are in minutes. **Zero means no waiting**, not disabled monitoring. The battery and disconnection delays replace the ordinary warning delay; they are not added to it. If several warning rules apply to one source, an active rule with a shorter delay can report it sooner.

Actual alarms and their endings do not use these delays.

### 5. Add optional label rules

Labels let you include additional sources or exclude ordinary problems. The integration neither creates labels nor assigns them to entities. Under **Settings > Areas, labels & zones > Labels**, create any labels you need or reuse existing ones. Their names are your choice.

Assign each label **directly to the relevant entity** under **Settings > Devices & services > Entities**, then select it in the matching monitor field. Labels only on a device or area are not inherited by the monitor.

| Field                | Meaning for an entity carrying a selected label                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| **Warning when on**  | Warn while its state is `on`                                                        |
| **Alarm entities**   | Report `on` immediately as an alarm; warn about continuous `unavailable` separately |
| **Ignored problems** | Exclude it from ordinary warning rules, including automatic detection               |
| **Warning below 30** | Warn when its numeric value is less than 30                                         |
| **Warning below 20** | Warn when its numeric value is less than 20                                         |
| **Warning below 10** | Warn when its numeric value is less than 10                                         |

Each selection starts empty and accepts several labels. You only need labels for the rules you intend to use. For example, put a percentage battery sensor under one chosen numeric threshold. For a smoke detector, assign the alarm label to its actual alarm entity, not its separate battery entity.

Alarm-label behavior takes precedence over **Ignored problems**. A selected alarm source is excluded from ordinary problem, battery and threshold rules, but its disconnection warning still applies.

### 6. Choose recipients and messages

In **Warnings**, select recipients for confirmed problems and their all-clears. In **Alarms**, select recipients for actual alarms and their endings. Either section accepts individual notification targets, multiple targets, or native notification groups; both sections may use the same targets.

A recipient list left empty means **no delivery for that category**. Monitoring and dashboard entities still work. The integration does not choose a user or a phone automatically. The selector lists `notify` entities; older `notify.mobile_app_*` actions and YAML notification action groups are not shown.

Both sections have a prefilled **Title template** and **Message template**. The defaults are English and distinguish a new issue from an all-clear. Leave them unchanged for a first setup, or translate and customize them locally. Saved recipients and templates are retained across updates. See [Customize messages](#customize-messages) for the available variables.

Alarm messages use normal notification delivery by default. For Companion app recipients, the optional **Companion app data template** can add platform-specific settings such as a dashboard URL or a critical notification sound. Use `resolved` to give an all-clear different settings from the original alarm. See [Companion app notification data](#companion-app-notification-data).

### 7. Save and check the created entities

Submit the form. Monitoring starts automatically; no separate automation, start action, or Home Assistant restart is required. Existing source problems are assessed immediately and confirmed after their configured delay.

The integration creates a **Problem monitoring** device with three entities:

| Entity              | What you see                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| **Open problems**   | Number of confirmed warnings still open, with problem details in its attributes |
| **Active alarms**   | Number of ongoing alarms, with alarm details in its attributes                  |
| **Problem changes** | Events for custom automations; built-in notifications do not require one        |

Home Assistant generates the entity IDs. Use the IDs from your installation when adding a dashboard card. No dashboard is created automatically.

### 8. Verify one complete notification cycle

Create a temporary Toggle helper and give it a label selected under **Warning when on**. Turn it on and wait for the warning delay: **Open problems** should increase and warning recipients should receive a notification. Turn it off and wait for the solution delay: the problem closes and the same recipients receive an all-clear. Remove the temporary helper afterward.

## After setup

Reconfigure the monitoring entry to change rules, delays, recipients, or templates. New label assignments to entities are picked up automatically. Stored selections use label IDs, so renaming a label does not change its role.

An unconfirmed problem that disappears is removed without a message. Confirmed problems remain open until reliable recovery completes. Unknown, unavailable, and missing ordinary sources do not confirm a solution. Source sensors should therefore report `unavailable` whenever they cannot evaluate their inputs.

Confirmed problems and alarms survive Home Assistant restarts and integration reloads without repeating their original notifications. Pending warning and recovery periods restart because downtime does not establish continuous activity or recovery. Turning off an automatic rule removes issues monitored only by that rule without sending an all-clear.

Adding recipients does not replay already confirmed problems. An unchanged open problem does not generate reminders. Existing monitors without notification settings start with empty recipient lists, so upgrading does not enable delivery.

## Customize messages

The title and message editors accept plain text or Home Assistant Jinja templates. You can translate the text, change displayed names, or choose wording based on the reason and whether the issue has been resolved. These edits stay in the local monitor configuration.

Available variables:

| Variable                     | Meaning                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `problem.name`               | Source display name captured when the event occurred                        |
| `problem.entity_id`          | Source entity ID                                                            |
| `problem.reason`             | `problem`, `battery_critical`, `below_threshold`, `unavailable`, or `alarm` |
| `problem.triggered_since`    | Confirmation timestamp                                                      |
| `problem.solved_delay_since` | Start of reliable recovery, where applicable                                |
| `event_type`                 | `triggered`, `solved`, `alarm_triggered`, or `alarm_solved`                 |
| `resolved`                   | `true` for `solved` and `alarm_solved`; otherwise `false`                   |

Standard HA template functions such as `states()` and `state_attr()` are available. Event variables use the incident snapshot; those functions read current state. For example, a custom warning message can be:

```jinja
{{ problem.name }}: {{ 'Everything is clear.' if resolved else 'Please check this device.' }}
```

Invalid template syntax and blank message text are rejected when saving. If a title or message template fails at runtime or renders an empty message, the affected field uses its default text and the error is logged. An empty title is allowed. Targets without title support still receive the message.

### Companion app notification data

The optional **Companion app data template** accepts the same variables as the title and message. It must produce a mapping of [Companion app notification options](https://companion.home-assistant.io/docs/notifications/notifications-basic), such as `url` or `push`. Leave it empty or return `{{ {} }}` to use normal notification delivery. Existing configurations keep that default.

For example, this template opens a dashboard when tapped and requests an iOS critical sound for a new alarm, while sending its all-clear normally:

```jinja
{{ {'url': '/lovelace/alerts'} if resolved else {
  'url': '/lovelace/alerts',
  'push': {'sound': {'name': 'default', 'critical': 1, 'volume': 1}}
} }}
```

Replace the URL with a view from your installation. Critical sounds also require the corresponding permission in the phone's notification settings. Non-empty data requires Companion app recipients, including the members of any selected group. Other notification targets are logged and skipped for that event. If the data template fails or produces something other than a mapping, the event is not sent and an error is logged; it does not fall back to an ordinary push that might silently lose critical settings.

## Dashboard

Add an Entities card and select **Open problems** and **Active alarms** for a simple count display. For individual problem rows and recovery countdowns, use the optional custom-card examples below.

The built-in entity names are **Open problems**, **Active alarms**, and **Problem changes**. Home Assistant generates their entity IDs; replace `sensor.open_problems` and `sensor.active_alarms` below with the IDs from your installation. Existing custom names and entity IDs are retained across updates.

The following card requires [Auto-entities](https://github.com/thomasloven/lovelace-auto-entities) and [Template Entity Row](https://github.com/thomasloven/lovelace-template-entity-row), available through HACS. Add it through the dashboard's card YAML editor.

Each confirmed problem has a status line:

- **Known since 15:52 · Waiting for resolution** while it remains open, including unknown or unavailable source states. The time is its `triggered_since` value.
- **Resolved since 17:52 · All-clear in 4m** during reliable recovery. The countdown uses `solved_delay_until` and updates every minute. Less than a minute is shown as **All-clear in <1m**.

Only confirmed problems are listed. Source values keep their units and native state colors. The display uses the monitor's timestamps for every problem category.

```yaml
type: custom:auto-entities
card:
  type: entities
  title: Open problems
show_empty: false
filter:
  template: |-
    {% set problems = state_attr('sensor.open_problems', 'problems') or {} %}
    {% set current_time = as_timestamp(now()) %}
    {% set rows = namespace(items=[]) %}
    {% for problem in problems.values() if problem.triggered_since is not none %}
      {% if problem.solved_delay_since is not none %}
        {% set remaining = as_timestamp(problem.solved_delay_until) - current_time %}
        {% if remaining >= 60 %}
          {% set recovery = 'All-clear in ' ~ ((remaining / 60) | round(0, 'ceil') | int) ~ 'm' %}
        {% elif remaining > 0 %}
          {% set recovery = 'All-clear in <1m' %}
        {% else %}
          {% set recovery = 'Confirming all-clear' %}
        {% endif %}
        {% set row = {
          'type': 'custom:template-entity-row',
          'entity': problem.entity_id,
          'icon': 'mdi:timer-sand',
          'color': 'state',
          'state': '',
          'secondary': 'Resolved since ' ~ (as_timestamp(problem.solved_delay_since) | timestamp_custom('%H:%M')) ~ ' · ' ~ recovery
        } %}
      {% else %}
        {% set value = states(problem.entity_id, with_unit=true) if has_value(problem.entity_id) and state_attr(problem.entity_id, 'unit_of_measurement') else state_translated(problem.entity_id) %}
        {% set row = {
          'type': 'custom:template-entity-row',
          'entity': problem.entity_id,
          'color': 'state',
          'state': value,
          'secondary': 'Known since ' ~ (as_timestamp(problem.triggered_since) | timestamp_custom('%H:%M')) ~ ' · Waiting for resolution'
        } %}
      {% endif %}
      {% set rows.items = rows.items + [row] %}
    {% endfor %}
    {{ rows.items | to_json }}
```

Actual alarms have their own list and clear immediately after a reliable non-alarm state. Use the **Active alarms** sensor for that card:

```yaml
type: custom:auto-entities
card:
  type: entities
  title: Active alarms
show_empty: false
filter:
  template: >-
    {{ ((state_attr('sensor.active_alarms', 'alarms') or {}).keys() | list) | to_json }}
```

## Notification delivery

The integration uses Home Assistant's `notify.send_message` action for normal delivery. When a data template produces a non-empty mapping, it resolves each Companion app recipient's current device and uses HA's native mobile-app notification action to preserve those options. Native groups, including nested groups, are expanded for each event. A recipient selected directly and through one or more groups receives that event once. Deliveries run independently with a 15-second timeout per recipient. A missing, unavailable, failing, or slow target does not block another recipient or further monitoring. Each recipient keeps new messages and all-clears in event order. Failures are logged and are not automatically retried. Pending deliveries are cancelled when the integration unloads or reloads.

## State and event reference

The **Open problems** sensor counts confirmed problems until they are resolved. Its `problems` attribute also contains pending problems, keyed by source entity ID. Each record contains its source `entity_id`, display `name`, classification `reason`, and three timestamps:

- `trigger_delay_since`: start of the pending warning; cleared on triggering.
- `triggered_since`: confirmation time, retained through temporary disappearance.
- `solved_delay_since`: start of a pending reliable recovery.

Sensor records also include the derived `solved_delay_until` deadline for dashboard countdowns. It uses the configured solution delay and is `null` outside a pending recovery. Countdowns disappear if the problem returns or its source becomes unknown or unavailable; a restarted recovery receives a fresh deadline.

The **Active alarms** sensor counts ongoing alarms and exposes their records in its `alarms` attribute. An alarm which becomes unreachable stays open until a reliable non-alarm state is observed. An availability warning can therefore coexist with an ongoing alarm for the same source.

The **Problem changes** event entity emits `triggered`, `solved`, `alarm_triggered`, and `alarm_solved`. Each event has a `problem` attribute with the corresponding record; a solution event carries the record which has just been removed. This entity remains available for custom automations using **Event received** and `trigger.to_state.attributes.problem`, independently of built-in notifications.

On restart or reload, confirmed problems retain `triggered_since` and do not produce another `triggered` event. Pending warning and solution delays restart: downtime is not observed continuous activity or recovery. Event generation is persisted before publication; phone delivery acknowledgement is outside this feature's scope.

## Switching from another monitoring system

If another system already sends problem or alarm notifications:

1. Check that source sensors use `unavailable` whenever they cannot reliably evaluate a problem. Keep existing notifications active during preparation.
2. Add the monitor and select the appropriate labels. Leave its notification recipients empty while the new monitor builds its initial baseline.
3. Wait until the currently active problems have `triggered_since` in the new sensor. This can take the battery or alarm availability delay. The new monitor's initial events do not notify anyone on their own.
4. Reconfigure the monitor to select **Warnings** and **Alarms** recipients and adjust their local templates. Disable the previous notification automations when enabling built-in delivery to avoid duplicate messages. Past events are not replayed. Verify one new problem and one individual solution.
5. Update dashboard references to **Open problems** and **Active alarms**. If custom automations are still required, use **Problem changes** and leave the corresponding built-in recipient list empty.
6. Check all references to the previous system before removing components that are no longer needed. Avoid leaving both notification systems active.

The monitor does not rewrite existing helpers, dashboards, macros, or automations automatically.
