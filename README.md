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

## Progressive Snapshot Cameras

The integration can expose an existing JPEG snapshot camera through a RAM-only cache. Dashboard cards receive the previous full-resolution frame immediately while the source is refreshed in the background. With a live camera card, a newly fetched frame replaces the cached image without reloading the dashboard.

To add one, open **Settings > Devices & services > Hippo's Home Assistant Toolbox**, open the integration entry's three-dot menu, and select **Add progressive snapshot camera**. Add one helper for each source camera. YAML configuration is not required.

Configure Area, Picture Glance, or Picture Entity cards with the new camera entity and set `camera_view: live` for immediate cache-to-fresh transitions. With `camera_view: auto`, Home Assistant still shows the cache immediately, but its standard still-image polling controls when the refreshed frame appears. Area Cards automatically select a camera from the area; hide the original snapshot entity—but do not disable it—if the Area Card should select the progressive camera linked to the same source device.

Frames are intentionally kept only in RAM and are rebuilt after every Home Assistant restart or integration reload. Automatic warmup begins after 30 seconds. Idle cameras refresh every 30 seconds through a staggered background queue with at most two source snapshots in flight. A live view shows the cached frame immediately and then follows its source. Native MJPEG sources use one shared upstream connection per progressive camera; their JPEG payloads are remuxed without decoding or recompression and distributed to every live card. Still-only sources follow the source camera's snapshot interval instead. A failed source keeps its last frame and adds a connection-problem marker until the next successful refresh. Version 1 accepts JPEG snapshots and MJPEG streams containing complete JPEG frames only.

### Rebuilding the connection marker

The runtime uses [`custom_components/hippos_toolbox/assets/connection_problem.png`](custom_components/hippos_toolbox/assets/connection_problem.png). Its editable source is [`assets/camera-overlay/connection_problem.svg`](assets/camera-overlay/connection_problem.svg). After changing that SVG, regenerate the PNG with:

```sh
pnpm camera-overlay:render
```

The renderer is generic. Optional positional arguments select another SVG, output path, and square pixel size:

```sh
pnpm camera-overlay:render -- path/to/icon.svg path/to/icon.png 512
```

## Irrigation Blueprints

Setup, behavior, formulas, triggers, scheduling rules, and log examples are documented in [Irrigation Blueprints](IRRIGATION.md).

## Push-Button Music Controller

Setup, gestures, session behavior, failover, player compatibility, and LED feedback are documented in [Push-Button Music Controller](PUSH_BUTTON_MUSIC_CONTROLLER.md).

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
