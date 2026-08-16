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

Frames are intentionally kept only in RAM and are rebuilt after every Home Assistant restart or integration reload. Automatic warmup begins after 30 seconds. Idle cameras refresh every 30 seconds through a staggered background queue with at most two source snapshots in flight. A live view shows the cached frame immediately, starts its source independently, and then follows the source camera's own frame interval. Multiple live cards for the same progressive camera share that source cadence. A failed source keeps its last frame and adds a connection-problem marker until the next successful refresh. Version 1 accepts JPEG snapshots only.

### Rebuilding the connection marker

The runtime uses [`custom_components/hippos_toolbox/assets/connection_problem.png`](custom_components/hippos_toolbox/assets/connection_problem.png). Its editable source is [`assets/camera-overlay/connection_problem.svg`](assets/camera-overlay/connection_problem.svg). After changing that SVG, regenerate the PNG with:

```sh
pnpm camera-overlay:render
```

The renderer is generic. Optional positional arguments select another SVG, output path, and square pixel size:

```sh
pnpm camera-overlay:render -- path/to/icon.svg path/to/icon.png 512
```

## About the Irrigation Blueprints

The two irrigation blueprints work together:

- For each zone, an individual **Irrigation Zone Calculation** automation calculates the zone's watering demand during the current watering interval.
- A shared **Irrigation Scheduler** automation executes those demands in sequence for all zones it is configured to manage.

### Required Configuration

1. Under **Settings > Devices & services > Helpers**, create one dedicated **Text** helper per zone and set its maximum length to **255** characters.
2. Create one **Irrigation Zone Calculation** automation per valve. Assign a different helper to every zone; do not edit or reuse these helpers manually.
3. Select a History Statistics sensor for rain duration and a sensor reporting the maximum temperature of the last 24 hours. The rain sensor must report the percentage of the last 24 hours during which rain was detected, not precipitation in millimetres. Temperature must be in degrees Celsius.
4. Optionally select a soil-moisture sensor reporting 0–100%. Moisture below the target increases demand by up to 100%; moisture at or above the target does not reduce it. An unavailable moisture sensor applies no adjustment.
5. Create one **Irrigation Scheduler** automation. Select every zone helper exactly once and arrange them in the desired watering order. Zones run one at a time.
6. Configure the primary daily start time and, if limited runs may need another opportunity, an additional daily start time. A time earlier than the primary time means the following morning.

### How Scheduling Works

Each zone calculates its watering demand in minutes for the current watering interval based on the configured default duration, rain, temperature, and soil moisture.

The scheduler then plans runs for all zones in the order they were selected. It always attempts to satisfy each zone's watering demand in full. If an optional maximum duration per run is configured for a zone, the scheduler splits its demand into multiple runs, each with a duration not exceeding the limit.

The scheduler supports a primary and an additional daily start time. It first schedules runs at the primary time. If a zone's watering demand cannot be fully satisfied at that primary time, it attempts to schedule the remaining demand at the additional time. If that is also insufficient, the remaining demand can also be carried over to the next days, until the next watering interval begins. Any demand that still cannot be scheduled expires at that boundary.

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

- **Hippo's Sensor-based State Machine**\
  [Source](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/sensor_state_machine.yaml) · [Import manually into Home Assistant](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fsensor_state_machine.yaml)

## Contributing

Development and release instructions are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
