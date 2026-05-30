# Hippo's Home Assistant Toolbox

Reusable Home Assistant blueprints for automations I use locally and share with friends.

## Blueprints

Import a blueprint with the **My Home Assistant** button, or copy the GitHub source URL into **Settings > Automations & scenes > Blueprints > Import Blueprint**.

### Hippo's Cover Automation

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fcover_automation.yaml)

Source: [blueprints/automation/cover_automation.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/cover_automation.yaml)

### Hippo's Irrigation Scheduler

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_scheduler.yaml)

Source: [blueprints/automation/irrigation_scheduler.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_scheduler.yaml)

### Hippo's Irrigation Zone Calculation

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Firrigation_zone_calculation.yaml)

Source: [blueprints/automation/irrigation_zone_calculation.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_zone_calculation.yaml)

### Hippo's Sensor-based State Machine

[![Open your Home Assistant instance and import this blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fhippotastic%2Fhippos-home-assistant-toolbox%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fsensor_state_machine.yaml)

Source: [blueprints/automation/sensor_state_machine.yaml](https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/sensor_state_machine.yaml)

## Manual Import

Use these GitHub URLs when importing manually:

| Blueprint | File |
| --- | --- |
| Hippo's Cover Automation | `https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/cover_automation.yaml` |
| Hippo's Irrigation Scheduler | `https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_scheduler.yaml` |
| Hippo's Irrigation Zone Calculation | `https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/irrigation_zone_calculation.yaml` |
| Hippo's Sensor-based State Machine | `https://github.com/hippotastic/hippos-home-assistant-toolbox/blob/main/blueprints/automation/sensor_state_machine.yaml` |

For GitHub imports, Home Assistant stores the blueprint under its own blueprint directory using the GitHub user and YAML filename, for example:

```text
/config/blueprints/automation/hippotastic/cover_automation.yaml
```

The repository subfolder is only part of the source URL. It does not need to mirror the local Home Assistant storage path.

## Updates

When a blueprint changes:

1. Push the updated blueprint file to GitHub.
2. In Home Assistant, open **Settings > Automations & scenes > Blueprints**.
3. Open the three-dot menu for the blueprint.
4. Select **Re-import blueprint**.
5. Reload automations under **Settings > Developer tools > YAML**.

Automations created from a blueprint continue to reference that blueprint, so they pick up compatible blueprint changes after the updated blueprint is loaded.

## Local Use

For my own Home Assistant instance, use the same GitHub import flow as everyone else. That keeps the local installation on the same tested path as friends using the shared repository.

Alternatively, for development only, copy or sync the files into the Home Assistant configuration directory under:

```text
/config/blueprints/automation/hippotastic/
```

Then reload automations after changes.

If this repository is checked out directly on the Home Assistant host, pull the latest changes before reloading automations.

## Compatibility

These blueprints declare a minimum Home Assistant version of `2024.6.0`, because they use modern blueprint schema features such as input sections. If a blueprint is tested against a newer required Home Assistant version, update its `homeassistant.min_version` before publishing.

Breaking input changes can require existing automations to be adjusted manually after re-importing. Prefer additive changes for shared blueprints whenever possible.

## Validation

The repository includes a Home Assistant based blueprint validator in `tools/ha-blueprint-validator`.

Run ESLint:

```sh
pnpm lint
```

ESLint also checks YAML files and reports overly long lines as warnings. Use those warnings as a cue to split complex Jinja expressions or introduce local variables before publishing.

Apply automatic ESLint fixes:

```sh
pnpm lint:fix
```

Format annotated Jinja template blocks in blueprints:

```sh
pnpm format:blueprints
```

Check blueprint formatting without writing files:

```sh
pnpm format:blueprints --check
```

The formatter acts on folded scalar blocks that contain `{#- ... #}` Jinja comments. See `tools/ha-blueprint-formatter` for the exact style rules.

Run the lightweight YAML syntax check:

```sh
pnpm validate --syntax-only
```

Run the full Docker-based Home Assistant configuration check:

```sh
pnpm validate
```

The full check creates a temporary Home Assistant configuration, installs the repository blueprints into it, adds one fixture automation per blueprint, and runs `hass --script check_config`.

The Home Assistant validation container runs with Docker networking disabled. The validator also uses Docker's `--pull never` policy by default, so pull the Home Assistant image explicitly before the first full run.
