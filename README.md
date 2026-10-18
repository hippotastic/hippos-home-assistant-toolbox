# Hippo's Home Assistant Toolbox

Reusable Home Assistant blueprints with comfortable installation and updates through a custom Home Assistant integration.

## Installation

[![Open your Home Assistant instance and add this repository to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=hippotastic&repository=hippos-home-assistant-toolbox&category=integration)

1. Add this repository to HACS as an **Integration** custom repository.
2. Download **Hippo's Home Assistant Toolbox** in HACS.
3. Restart Home Assistant.
4. Open **Settings > Devices & services > Add integration** and select **Hippo's Home Assistant Toolbox**.

No integration settings are required.

During setup, all active blueprints contained in this repository are installed automatically. In case you already installed some of the blueprints manually, they are adopted by the integration.

## File Locations

Files are installed under:

```text
/config/blueprints/<domain>/hippotastic/
```

Before replacing an existing file, the integration keeps up to three copies in:

```text
/config/blueprints/.hippos_toolbox_backups/
```

## Updates

By default, the integration checks the published blueprints once per day. New and changed blueprints appear together as an update for the **Blueprints** update entity. Installing that update downloads the exact source files and reloads affected Home Assistant domains.

Use the **Check for updates** button entity to run the catalog check immediately. This only checks for changes; it does not install them.

### Update Channels

Every installation follows the **Stable** channel by default; initial setup does not ask for a channel. Stable reads the blueprint catalog from the latest published GitHub release.

To allow testing unreleased changes, open **Settings > Devices & services > Hippo's Home Assistant Toolbox > Configure** and select the **Development** channel. This will increase the update check frequency to every 2 hours and follow the latest catalog commit on `main`. Switching back to Stable is supported at any time.

The Development channel only affects blueprint content. HACS continues to update the integration itself from published releases.

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

## Manual Installation

The integration is the recommended installation method. Individual blueprints can still be imported manually.

- **Hippo's Cover Automation**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/cover_automation.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fcover_automation.yaml)

- **Hippo's Time-Based Exponential Moving Average (EMA)**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/exponential_moving_average.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fexponential_moving_average.yaml)

- **Hippo's Irrigation Zone Calculation**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_zone_calculation.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_zone_calculation.yaml)

- **Hippo's Irrigation Scheduler**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_scheduler.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_scheduler.yaml)

- **Hippo's Push-Button Music Controller**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/push_button_music_controller.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fpush_button_music_controller.yaml)

- **Hippo's Sensor-based State Machine**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/sensor_state_machine.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fsensor_state_machine.yaml)

## Contributing

Development and release instructions are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
