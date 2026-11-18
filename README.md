# Hippo's Home Assistant Toolbox

A Home Assistant integration with reusable automation blueprints, camera features, announcements, and problem monitoring.

## Installation

[![Open your Home Assistant instance and add this repository to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=hippotastic&repository=hippos-home-assistant-toolbox&category=integration)

1. Add this repository to HACS as an **Integration** custom repository.
2. Download **Hippo's Home Assistant Toolbox** in HACS.
3. Restart Home Assistant.
4. Open **Settings > Devices & services > Add integration** and select **Hippo's Home Assistant Toolbox**.

No integration settings are required.

The toolbox installs its bundled blueprints when the integration is set up. Open **Settings > Automations & scenes > Blueprints** to find them and create automations from them.

## File Locations

Files are installed under:

```text
/config/blueprints/<domain>/hippotastic/
```

## Updates

Update the toolbox and restart Home Assistant to apply the blueprints included in the new version. On setup, the toolbox installs the bundled files at their established paths and replaces copies whose contents differ, including local edits. Customize automations through their blueprint inputs.

## Features

Choose a guide for setup, examples, and detailed behavior:

| Feature                                                              | What it does                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Problem Monitoring](docs/MONITORING.md)                             | Keeps track of open problems and alarms and sends notifications to separate recipient groups. |
| [Announcements](docs/ANNOUNCEMENTS.md)                               | Plays audio or generated speech with coordinated volume and duration-based waits.             |
| [Camera Frontend Features](docs/CAMERAS.md)                          | Adds zoom and restores interrupted camera views.                                              |
| [Progressive Snapshot Cameras](docs/PROGRESSIVE_CAMERAS.md)          | Shows a cached image immediately while fetching a fresh frame.                                |
| [Cover Automation](docs/COVER_AUTOMATION.md)                         | Coordinates sun protection, privacy, night mode, and lockout prevention.                      |
| [Sensor-based State Machine](docs/SENSOR_STATE_MACHINE.md)           | Controls one output from several sensors, with conditions and delayed turn-off.               |
| [Exponential Moving Average](docs/EXPONENTIAL_MOVING_AVERAGE.md)     | Smooths numeric measurements through regular time-based sampling.                             |
| [Irrigation](docs/IRRIGATION.md)                                     | Adjusts watering demand for weather and soil and schedules zones sequentially.                |
| [Push-Button Music Controller](docs/PUSH_BUTTON_MUSIC_CONTROLLER.md) | Controls playback, favorites, and volume from one or two wall buttons.                        |

Camera frontend features are enabled by default and can be switched off in the
toolbox options. Add monitoring and progressive cameras separately when needed.
Installing blueprints makes them available; create an automation from a blueprint
to use it. The [documentation index](docs/README.md) separates integration features
from blueprint automations.

## Contributing

Development and release instructions are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
