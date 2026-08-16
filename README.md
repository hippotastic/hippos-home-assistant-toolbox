# Hippo's Home Assistant Toolbox

Reusable Home Assistant blueprints with comfortable installation and updates
through a custom Home Assistant integration.

## Installation

[![Open your Home Assistant instance and add this repository to HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=hippotastic&repository=hippos-home-assistant-toolbox&category=integration)

1. Add this repository to HACS as an **Integration** custom repository.
2. Download **Hippo's Home Assistant Toolbox** in HACS.
3. Restart Home Assistant.
4. Open **Settings > Devices & services > Add integration** and select
   **Hippo's Home Assistant Toolbox**.

No integration settings are required. During setup, all active blueprints that
do not already exist locally are installed automatically.

Blueprints previously imported from this repository through Home Assistant are
recognized by their source URL, backed up, and adopted by the integration.
Existing files under `/config/blueprints/<domain>/hippo/` are also recognized.
During adoption, the integration moves them into its managed `hippotastic/`
directory and updates existing `use_blueprint.path` references in YAML
configuration files. If a reference cannot be rewritten safely, the old file is
kept as a compatibility copy so the existing consumer continues to work.

## Updates

The integration checks the published blueprint catalog once per day. New and
changed blueprints appear together as an update for the **Blueprints** update
entity. Installing that update downloads the exact source files from one Git
commit and reloads affected Home Assistant domains.

Use the **Check for updates** button entity to run the catalog check immediately.
This only checks for changes; it does not install them.

### Update Channels

Every installation follows the **Stable** channel by default; initial setup does
not ask for a channel. Stable reads the blueprint catalog from the latest
published GitHub release.

To test upcoming changes on one Home Assistant instance, open **Settings >
Devices & services > Hippo's Home Assistant Toolbox > Configure** and select
**Development**. The integration reloads automatically and follows the latest
catalog commit on `main`. Development revisions are prefixed with `development-`
in the update entity so they remain visibly distinct from stable releases.
Switching back to Stable is supported at any time.

The Development channel only affects blueprint content. HACS continues to
update the integration itself from published releases.

Files are installed under:

```text
/config/blueprints/<domain>/hippotastic/
```

Before replacing an existing file, the integration keeps up to three copies in:

```text
/config/blueprints/.hippos_toolbox_backups/
```

### Local Changes

The integration never silently overwrites an unexpected local modification. It
creates a Repair issue instead. The repair flow backs up the local file and
restores the published version after explicit confirmation. Keeping the local
version and ignoring the issue is also supported.

### Deprecated Blueprints

Retired blueprints remain installed locally and continue to be available to
existing automations, scripts, or template entities. They no longer receive
updates, and Home Assistant shows an ignorable deprecation issue.

## Blueprints

The integration is the recommended installation method. Individual blueprints
can still be imported manually.

### Hippo's Cover Automation

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fcover_automation.yaml)

Source: [blueprints/automation/cover_automation.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/cover_automation.yaml)

### Hippo's Time-Based Exponential Moving Average (EMA)

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fexponential_moving_average.yaml)

Source: [blueprints/automation/exponential_moving_average.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/exponential_moving_average.yaml)

### Hippo's Irrigation Zone Calculation

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_zone_calculation.yaml)

Source: [blueprints/automation/irrigation_zone_calculation.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_zone_calculation.yaml)

### Hippo's Irrigation Scheduler

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_scheduler.yaml)

Source: [blueprints/automation/irrigation_scheduler.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_scheduler.yaml)

#### Irrigation quick start

The irrigation blueprints work together: one Zone Calculation automation
publishes the demand for each zone, and one shared Scheduler executes those
demands in sequence.

1. Under **Settings > Devices & services > Helpers**, create one dedicated
   **Text** helper per zone and set its maximum length to **255** characters.
2. Create one **Irrigation Zone Calculation** automation per valve. Assign a
   different helper to every zone; do not edit or reuse these helpers manually.
3. Select History Statistics sensors for rain duration and maximum temperature.
   The rain sensor must report the percentage of the last 24 hours during which
   rain was detected, not precipitation in millimetres. Temperature must be in
   degrees Celsius.
4. Optionally select a soil-moisture sensor reporting 0–100%. Moisture below the
   target increases demand by up to 100%; moisture at or above the target does
   not reduce it. An unavailable moisture sensor applies no adjustment.
5. Create one **Irrigation Scheduler** automation. Select every zone helper
   exactly once and arrange them in the desired watering order. Zones run one at
   a time.
6. Configure the primary daily start time and, if limited runs may need another
   opportunity, an additional daily start time. A time earlier than the primary
   time means the following morning.

The calculated runtime is the total demand for one planning cycle, not the
duration of every run. A maximum duration per run splits that demand without
limiting its total. For example, 110 minutes of demand with a 60-minute limit,
a primary time of 22:00, and an additional time of 08:00 produces a 60-minute
run at 22:00 followed by a 50-minute run the next morning.

For cycles longer than one day, unused primary and additional start times on
following days remain available until the next cycle begins. Any demand that
still cannot be scheduled expires at that boundary. Recalculation keeps
completed runs, subtracts their cumulative duration from the new demand, and
replans only future runs. A run that has already started always completes with
its originally scheduled duration.

### Hippo's Sensor-based State Machine

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fsensor_state_machine.yaml)

Source: [blueprints/automation/sensor_state_machine.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/sensor_state_machine.yaml)

## Compatibility

The integration requires Home Assistant `2026.7.0` or newer. Individual
blueprints currently declare Home Assistant `2024.6.0` as their minimum version
and can still be imported manually on compatible older installations.

Blueprint updates should remain backwards compatible with existing inputs.
Breaking input changes can require users to adjust existing consumers manually.

## Development

Install dependencies with:

```sh
pnpm install
```

Commit blueprint changes and the synchronized `blueprints/catalog.json` to
`main`, then select the Development channel on a test Home Assistant instance.
Development users receive those changes directly from `main`; Stable users do
not receive them until they are included in a published release. New blueprints
and deprecation tombstones follow the same process.

Run the canonical local validation suite:

```sh
pnpm validate
```

`pnpm validate` is the complete local check. It first synchronizes the generated
blueprint catalog so changed sources and their SHA-256 hashes cannot drift
apart. It then orders checks to fail early and quickly: ESLint and catalog
consistency run first, followed by TypeScript and unit tests. Finally, one
Vitest run starts a network-isolated Home Assistant container and executes both
repository validation and blueprint runtime tests. Commit an updated
`blueprints/catalog.json` alongside its blueprint changes. Do not run additional
checks before or after a successful validation unless the working tree changed.
The YAML linter reports lines longer than 140 characters as warnings.

GitHub Actions runs the Docker-free portion of the same validation flow. The
full Home Assistant-backed suite remains local.

### Releases

User-visible changes carry a Changeset. Pushes to `main` maintain a draft
release pull request containing the next semantic version and generated
changelog. Merging that pull request synchronizes the integration manifest,
creates the matching Git tag, and publishes a GitHub Release. The Stable update
channel reads blueprint content from that immutable release.

The shared validation and runtime container uses Docker networking mode `none`.
No Python installation is required on the host; Python regression tests execute
inside the Home Assistant container and are orchestrated by Vitest. See
`test/README.md` for details.

Catalog maintenance and deprecation rules are documented in
`tools/blueprint-catalog`.
