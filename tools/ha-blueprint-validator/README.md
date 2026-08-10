# Home Assistant Blueprint Validator

This directory contains the minimal configuration used to validate every
repository blueprint against Home Assistant.

## Test Coverage

The Vitest test file `test/config/validation.test.ts` performs three
checks:

- parse repository and validator YAML with Home Assistant's custom YAML tags;
- execute the Python integration regression tests inside the HA container;
- run Home Assistant's real `check_config --fail-on-warnings` against the
  validator fixtures.

`fixtures/configuration.yaml` provides the minimal Home Assistant configuration,
and `fixtures/automations.yaml` instantiates every published blueprint with
explicit inputs.

## Running Tests

Run only repository and Home Assistant configuration validation:

```sh
pnpm test:ha:config
```

Run all HA-backed validation and runtime tests with one shared container:

```sh
pnpm test:ha
```

The canonical `pnpm validate` command runs linting, type checking, unit tests,
and then `test:ha`.

The default image is `ghcr.io/home-assistant/home-assistant:stable`. The harness
uses Docker's `--pull never` policy. Update the image explicitly when desired:

```sh
docker pull ghcr.io/home-assistant/home-assistant:stable
```

Use `HA_IMAGE` to select a different image and `HA_IMAGE_PULL_POLICY` with
`never`, `missing`, or `always` to change the pull behavior for one run. The
container uses `--network none`, publishes no ports, and cannot contact the LAN
or internet.

Set `KEEP_HA_BLUEPRINT_RUNTIME_TEST_CONFIG=1` to preserve the generated runtime
and validator configurations for inspection.

## Updating Fixtures

When a blueprint gains a new required input, add a matching explicit value to
`fixtures/automations.yaml`.
