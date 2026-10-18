# Feature Guides

Start with [installation](../README.md#installation), then choose the feature you want to use. Each guide explains its purpose before setup and detailed behavior.

## Integration features

These features are provided by the toolbox integration. They do not require an automation created from a blueprint.

| Guide | Purpose | How it becomes active |
| --- | --- | --- |
| [Problem Monitoring](MONITORING.md) | Track persistent problems and alarms and notify selected recipients | Add a monitoring entry explicitly |
| [Announcements](ANNOUNCEMENTS.md) | Coordinate audio or speech playback, volume, and waiting | Use an announcement action in an automation or script |
| [Camera Frontend Features](CAMERAS.md) | Zoom camera views and restore interrupted streams | Enabled by default; review the toolbox options |
| [Progressive Snapshot Cameras](PROGRESSIVE_CAMERAS.md) | Show cached camera frames while fetching fresh images | Add one progressive camera entry per source |

## Blueprint automations

The integration installs the blueprint files. To make a blueprint do anything, create an automation from it under **Settings > Automations & scenes** and leave that automation enabled. The guides explain the inputs and any helpers needed.

| Guide                                                           | Purpose                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Cover Automation](COVER_AUTOMATION.md)                         | Coordinate sun protection, privacy, night mode, and lockout prevention |
| [Sensor-based State Machine](SENSOR_STATE_MACHINE.md)           | Combine several on/off inputs into one controlled output               |
| [Exponential Moving Average](EXPONENTIAL_MOVING_AVERAGE.md)     | Smooth numeric readings through minute-based sampling                  |
| [Irrigation](IRRIGATION.md)                                     | Calculate weather-adjusted demand and schedule sequential watering     |
| [Push-Button Music Controller](PUSH_BUTTON_MUSIC_CONTROLLER.md) | Control playback, favorites, and volume with wall buttons              |

## Development

See [Contributing](../CONTRIBUTING.md) for development and release instructions, the [test suite](../test/README.md) for validation, and the [catalog guide](../tools/blueprint-catalog/README.md) for blueprint lifecycle rules.
