# Blueprint Runtime Test Coverage

This matrix is the behavioral contract for the Docker-backed blueprint tests.
Each scenario evaluates the published blueprint against explicit expectations
that remain stable across future implementations.

## Cover Automation

| Area                   | Required behavior                                                                                              | Runtime scenario                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Automatic control      | Disabled control blocks changes; enabling it reconciles the target state                                       | `default`, all scenario initialization            |
| Defaults and overrides | Default position is used and a valid external angle overrides the configured default                           | `default`                                         |
| Invalid angle override | Values outside `-1..100` fall back to the configured default                                                   | `invalidAngle`, `invalidHighAngle`                |
| Sun protection         | Brightness, minimum elevation, normal azimuth ranges, and ranges crossing north are evaluated                  | `sun`                                             |
| Mode priority          | Sun, privacy, night, and lockout apply in order and serialize the complete active mode list                    | `sun`, `modes`                                    |
| Lockout                | Lockout opens a cover when required and blocks movement to a less-open position                                | `lockout`, `modes`                                |
| Manual movement        | Normal triggers preserve manual position changes; explicitly re-enabling automatic control reconciles them     | `manual`                                          |
| Tolerance              | Position and tilt differences of at most two points do not issue movement calls                                | `tolerance`                                       |
| Fully open cover       | Tilt is not changed when both current and target positions are fully open                                      | `fullyOpen`                                       |
| Missing tilt support   | Covers without a usable tilt attribute do not receive tilt calls                                               | `positionOnly`                                    |
| Missing position       | Tilt-only covers do not evaluate a missing position and still receive tilt calls                               | `tiltOnly`                                        |
| Angle homing           | Intermediate tilt targets call `0` before the target                                                           | `homing`                                          |
| Homing exclusions      | Disabled homing and extreme target angles skip the extra homing call                                           | `homingDisabled`, `homingExtreme`                 |
| Availability           | An unavailable configured mode or required cover blocks execution; omitted mode entities remain valid          | `availability`, `requiredAvailability`, `minimal` |
| Status and calls       | Status helper JSON, cover call order, position, and angle are significant                                      | all cover scenarios                               |
| User logs              | Mode changes, lockout protection, manual preservation, and movement summaries remain meaningful                | `default`, `modes`, `lockout`, `manual`           |

## Sensor State Machine

| Area                   | Required behavior                                                                                         | Runtime scenario                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Multiple sensors       | Any valid on sensor activates the output; the output turns off only when all valid sensors are off        | `transitions`                                  |
| Off delay              | `0.1` minutes keeps the output on before a real six-second delayed turn-off                               | `delay`                                        |
| Condition grace        | Conditions becoming valid inside the off-delay window can still activate the output                       | `delay`                                        |
| Required-on condition  | A false required-on condition blocks activation, later permits it, and turning false ends an active state | `conditions`                                   |
| Required-off condition | A true required-off condition ends an active state; returning off permits activation                      | `conditions`                                   |
| Invalid sensors        | `unknown` and `unavailable` sensors are ignored when valid sensors remain                                 | `invalid`                                      |
| No valid sensor        | Zero valid sensors never satisfies the all-off trigger                                                    | `invalid`                                      |
| Maximum duration       | The output expires only when maximum duration is enabled and every valid sensor is stale                  | `maxDuration`                                  |
| Disabled duration      | A zero maximum duration leaves stale active sensors alone                                                 | `domainBoolean` in `maxDuration` test          |
| Output domains         | Default control uses the native `input_boolean`, `light`, and `switch` services                           | `domainBoolean`, `domainLight`, `domainSwitch` |
| Custom actions         | Custom actions retain their order and suppress a duplicate default output service call                    | `actions`                                      |
| Reconciliation         | Enabling an automation reconciles input changes made while it was disabled                                | `reconcile`                                    |
| Startup guard          | The configurable uptime sensor suppresses startup turn-off for 30 seconds; an old uptime releases it      | `startup`                                      |

## Time-Based Exponential Moving Average

| Area              | Required behavior                                                                                | Runtime scenario |
| ----------------- | ------------------------------------------------------------------------------------------------ | ---------------- |
| Repeated sampling | Every sampling cycle moves the average again even when the source sensor state remains unchanged | `default`        |
| EMA formula       | Period length 4 applies alpha 0.4 to both the initial and subsequent samples                      | `default`        |
| Precision         | The calculated EMA is limited to the configured decimal places before being stored                | `default`        |
| Directed rounding | A rising average rounds upward and a falling average rounds downward so each sample can advance    | `default`        |
| No-op updates     | A source value that rounds to the stored average does not write the number helper                 | `default`        |
| Invalid input     | A nonnumeric source state such as `unavailable` does not write the number helper                  | `default`        |

## Irrigation Zone Calculation

| Area                  | Required behavior                                                                                   | Runtime scenario          |
| --------------------- | --------------------------------------------------------------------------------------------------- | ------------------------- |
| Climate formula       | Cold suppresses watering; heat scales and caps runtime; rainfall reduces it; final minutes round up | `formula`                 |
| Sensor fallbacks      | Invalid rainfall and temperature states use `0` and `20` respectively                               | `fallback`                |
| Invalid helper        | Malformed helper content becomes a valid status object                                              | `fallback`                |
| Helper normalization  | Empty, malformed, and valid non-object JSON become a valid calculated status                        | `emptyHelper`, `fallback` |
| Metadata preservation | Scheduler timestamps and unknown status properties survive recalculation                            | `fallback`                |
| No-op writes          | An unchanged valve, interval, and runtime do not rewrite the helper                                 | `noOp`                    |
| Reconciliation        | Re-enabling the automation recalculates values changed while it was disabled                        | `reconcile`               |
| Valve logbook         | Runtime changes explain their climate inputs on the valve entity                                    | `emptyHelper`             |

## Irrigation Scheduler

| Area                    | Required behavior                                                                                                   | Runtime scenario                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Stable scheduling       | Positive runtimes are scheduled contiguously in helper order and serialize matching durations                       | `planning`                      |
| Zero runtime            | Stale schedule fields are removed while unrelated status data remains                                               | `planning`                      |
| Daily interval anchor   | `last_end` before or after the daily start selects the correct previous watering period                             | `interval`                      |
| Invalid zones           | Malformed, non-object, and valveless helper values are ignored                                                      | `invalid`                       |
| Cleared helper          | Manually clearing a configured helper triggers safe replanning rather than being mistaken for an internal update    | `emptyHelper`                   |
| Scheduled execution     | The daily trigger runs two preplanned zones in order, keeping each active until its own `next_end`                  | `timeTrigger`                   |
| Pump and valve ordering | Competing valves stop before the pump starts, and the current valve starts after pump settling                      | `active`                        |
| Exclusive control       | Stopped competing zones receive `last_end` only when their recorded completion is missing or stale                  | `active`                        |
| Control window          | Recent watering is cleaned up; devices outside the 30-minute ownership window are left untouched                    | `recentWindow`, `outsideWindow` |
| Natural handoff         | Completion records `last_end`, retriggers scheduling, stops the old valve, and starts the next due zone             | `handoff`                       |
| Trigger filtering       | Schedule-only helper writes are ignored; material changes retrigger planning; invalid target states are excluded    | `triggerFilter`                 |
| Startup settling        | An unavailable valve delays processing by the configured startup settle time                                        | `startup`                       |
| Component contract      | Calculated valve, interval, and runtime flow into a future scheduler plan without manually triggering the scheduler | `endToEnd`                      |
| Valve logbook           | Plan changes and actual watering transitions are attached to the affected valve entity                              | `planning`, `active`, `handoff` |

## Assertion Rules

The tests intentionally ignore:

- timestamps and Home Assistant context IDs;
- harmless whitespace differences in selected logbook messages;
- debug-only logbook entries and YAML formatting.

The tests intentionally preserve:

- output and helper states;
- ordered relevant service calls and their data;
- mode serialization and action ordering;
- bounded assertions that prohibited calls do not happen;
- user-facing log meaning for safety and manual-control decisions.
- the absence of unexpected Home Assistant runtime warnings and errors.

## Deliberate Non-Coverage

- Home Assistant frontend rendering and the formatting produced by its manual
  blueprint importer are not runtime-test contracts. The toolbox integration
  installs the repository source without YAML reserialization.
- Network discovery and real integrations are excluded because the container has
  no network interface beyond loopback.
- Long-duration soak behavior and automation queue exhaustion are not tested.
- Every possible selector combination is not enumerated; scenarios focus on
  behaviorally distinct branches.
- Debug log wording and incidental whitespace are not compatibility contracts.
