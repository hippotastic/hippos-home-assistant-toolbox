# Sensor-based State Machine

**What is this?** An automation blueprint that lets several on/off inputs control one light, switch, or toggle helper together. Any active input can turn the output on, and a configurable delay keeps it on briefly after the last input clears. Optional conditions can restrict activation, and you can add actions when the combined state changes.

**When should you use this?** When you are still in a room but the lights go out because one motion sensor has cleared, even though another still detects you.

**Why is this included in the toolbox?** Independent on/off automations do not share a decision about whether a room is still occupied. Combining them yourself means coordinating every input with activation conditions, turn-off delays, unavailable sensors, and restart handling. You also need to distinguish a room that is clear from one where none of the sensors can currently report a valid state.

## Before you start

Install the [toolbox integration](../README.md#installation) or import the [blueprint](../blueprints/automation/sensor_state_machine.yaml) manually. Select existing input entities from `binary_sensor`, `input_boolean`, `light`, or `switch`. The output can be a light, switch, or Toggle helper (`input_boolean`).

The blueprint also takes a Home Assistant Uptime sensor for its startup guard. Its default is `sensor.uptime`; configure the Uptime integration if needed and select the actual entity ID from your installation.

## Setup

1. Choose the output entity. If you only want to store a logical state, create a **Toggle** helper under **Settings > Devices & services > Helpers**.
2. Under **Settings > Automations & scenes**, create an automation from **Hippo's Sensor-based State Machine**.
3. Select the input sensors and output under **State entity**.
4. Set **Off delay**: the default is **5 minutes** after all valid inputs are off.
5. Optionally select conditions that must all be on, and conditions that must all be off. For example, a brightness condition can permit motion lighting only when the room is dark enough.
6. Review **Maximum on duration**, which defaults to **120 minutes**, and select the Uptime sensor. Set the maximum duration to **0** to disable that safeguard.
7. Leave the custom action lists empty for direct output control, or add actions to run on each transition. Save and leave the automation enabled.
8. Activate one input, then clear all inputs. Check that the output turns on and turns off only after the configured delay.

Installing the blueprint does not create the automation or its optional helper.

## How conditions affect the output

All required-on conditions must be on, and all required-off conditions must be off, before the output can activate. If the conditions stop being satisfied, an active output turns off. If they become satisfied while an input still calls for activation, the output can turn on.

## Maximum duration and unavailable inputs

The maximum on duration is a stale-input safeguard, not an unconditional timeout from the moment the output turns on. When enabled, it turns the output off if an input remains active but all valid input sensors have stayed unchanged longer than the configured duration.

Unknown and unavailable input sensors are excluded while valid sensors remain. Having no valid sensors does not count as all sensors being off. The Uptime sensor provides a 30-second startup guard for the blueprint's startup handling.

## Custom actions

On and off action lists run on their respective transitions. By default, the blueprint also turns the selected State entity on or off using its native service. If the corresponding custom action list references that entity, the default call for that transition is suppressed; those actions must then apply the desired state themselves.
