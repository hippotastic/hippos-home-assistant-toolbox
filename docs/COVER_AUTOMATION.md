# Cover Automation

**What is this?** An automation blueprint to automatically control any cover (e.g. blind or shutter). It coordinates default positions, sun protection, privacy, night mode, and lockout prevention. Covers with tilt support can also receive a slat angle for each mode.

**When should you use this?** When you find yourself repeatedly adjusting your covers manually to prevent bright sunlight from blinding you, opening them up again after the sun has moved on, closing them at night to ensure your privacy, and much more. Why should you do this manually when your smart home can do it for you?

**Why is this included in the toolbox?** Creating an automation that properly handles all combinations of environmental states and events to move covers to the intuitively correct position is hard. You need to balance potentially conflicting needs to calculate one target position and angle in any scenario. This blueprint aims to solve that, removing most of your daily need to manually move covers. At the same time, it still allows you to manually adjust your covers without ever fighting you - it will just gracefully resume operation once the environment changes again. And when you ever wonder what it did and why, one look into the cover's logbook will reveal everything you need to know.

## Before you start

Install the [toolbox integration](../README.md#installation) or import the [blueprint](../blueprints/automation/cover_automation.yaml) manually. You need a cover entity and a dedicated Text helper for its automation state. Sun protection, privacy, night mode, and lockout prevention take optional input entities; the blueprint does not create those inputs.

## Setup

1. Under **Settings > Devices & services > Helpers**, create a dedicated **Text** helper with a maximum length of **255** characters. Do not share it with another cover automation or edit its contents manually.
2. Under **Settings > Automations & scenes**, create an automation from **Hippo's Cover Automation**. Select the cover and its Text helper.
3. Set the default position and angle. Position uses **100% for open** and **0% for closed**. Tilt controls are used only when the cover supports them.
4. Optionally select an external enable/disable input. Automatic control runs while that input is on; without one, automatic control is always allowed.
5. Configure the special modes you need. Leave unused mode inputs empty.
6. Save and leave the automation enabled. Change a configured mode input and check the cover's Activity for the mode explanation and requested position.

Installing the blueprint only makes it available. Repeat these steps to create one automation and Text helper for each cover.

## Choose the modes

| Mode               | When it applies                                                    | Configuration                                                                  |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Default            | No overriding mode applies                                         | Position and slat angle                                                        |
| Sun protection     | Its input is on and the sun is within the configured window angles | Window orientation, side angle, minimum sun elevation, position and slat angle |
| Privacy            | Its input is on                                                    | Position and slat angle                                                        |
| Night              | Its input is on                                                    | Position and slat angle                                                        |
| Lockout prevention | Its input is on                                                    | An opening position and slat angle, for example while a door is open           |

Sun protection uses the selected Sun entity, normally `sun.sun`, to decide whether the sun can reach the window. Its external input supplies the separate decision that sunlight is strong enough to require shading.

Default, sun protection, privacy, and night values are applied in that order; later active modes override earlier position and angle values. Lockout prevention is applied last: it can open the cover further when needed and prevents a command to a less-open position while active.

## Slat angles

Optional numeric input entities can override the configured default, sun protection, privacy, and night angles. Angle homing is enabled by default: it moves the slats to a reference position before certain angle changes to reduce drift. Disable it if that behavior is not needed for the cover.

The blueprint's input descriptions contain the complete set of settings and defaults. Use the cover's Activity to see which modes are active and why a movement was requested or prevented.
