# Home Assistant Tests

These tests validate the repository and execute blueprint automations inside a
real Home Assistant process. They are the final stage of the local
`pnpm validate` suite but are deliberately not run in CI.

## Running Validation

Run the complete repository validation from the project root:

```sh
pnpm validate
```

This is the canonical and complete check. It deliberately runs fast static
checks before slower tests and starts Home Assistant only after those checks
pass. No preliminary or follow-up validation commands are needed when it
succeeds and the working tree remains unchanged.

The default image is `ghcr.io/home-assistant/home-assistant:stable`. The harness
uses Docker's `--pull never` policy so the tested Home Assistant version changes
only after an explicit image update:

```sh
docker pull ghcr.io/home-assistant/home-assistant:stable
```

Use `HA_IMAGE` to select another image and `HA_IMAGE_PULL_POLICY` with `never`,
`missing`, or `always` to override the defaults for one run.

## Architecture

Vitest `globalSetup` creates one Home Assistant container for the HA-backed
validation stage. Repository validation and runtime behavior execute in the
same container. Test files execute sequentially with one worker and address
Home Assistant through a small test-only integration.

The generated Home Assistant configuration contains:

- a separate validator config that instantiates every published blueprint;
- the published blueprints from `blueprints/automation`;
- one automation instance per runtime scenario;
- dedicated entities for every scenario;
- deterministic test implementations for covers, lights, and switches.

Assertions describe the intended behavior explicitly. They remain the contract
for future blueprint revisions instead of treating an older implementation as
the expected result.

## Network Isolation

The container starts with `--network none`, and no ports are published. Home
Assistant therefore cannot reach the host LAN or internet. Each test file opens
one persistent `docker exec` bridge that calls `127.0.0.1:8123` from inside the
container. This is the only communication path to Home Assistant and avoids a
new Docker and Python process for every state query.

## Fresh-State Guarantee

Every HA-backed Vitest invocation starts from a new, deterministic state:

- `mkdtemp` creates a completely new `/config` directory.
- `.storage`, SQLite data, logs, and entity states are never reused.
- Docker starts one new named `--rm` container with only that directory mounted.
- Every fixture entity has an explicit initial value.
- Cover automation controls start disabled, preventing startup triggers from
  moving covers before a scenario initializes them.
- Global setup waits for Home Assistant and every generated automation to be
  running, allows startup activity to settle, and clears the event buffer.
- Each scenario owns its entities, so tests do not depend on resets performed by
  unrelated scenarios.

`KEEP_HA_BLUEPRINT_RUNTIME_TEST_CONFIG=1` keeps a failed run's generated config
for inspection. A later run still creates a different temporary directory.

## Runtime Client

`test/api.ts` exposes operations for:

- setting states with attributes and a controlled `last_changed` age;
- calling real Home Assistant services;
- waiting for states, attributes, and service calls;
- asserting that a service call does not occur during a bounded interval;
- filtering service calls and evaluating their HA firing order;
- printing scenario states and recent events when an assertion fails.

Time stamps and context IDs are not asserted. Relevant service order, service
data, helper state, output state, and selected user-facing log messages remain
significant.

Set `HA_BLUEPRINT_RUNTIME_LOGS=1` to stream Home Assistant container logs while
debugging. `KEEP_HA_BLUEPRINT_RUNTIME_TEST_CONFIG=1` prints and preserves the
generated config path at teardown.

## Test Layout

```text
test/
  config/
    validation.test.ts
    test_*.py
    vitest.config.ts
  runtime/
    cover_automation.test.ts
    sensor_state_machine.test.ts
    helpers.ts
    vitest.config.ts
  unit/
    blueprint-catalog.test.ts
    vitest.config.ts
  custom_components/blueprint_test/
  fixtures/configuration.yaml
  api.ts
  global-setup.ts
  harness.ts
  scenarios.ts
  setup.ts
  COVERAGE.md
```

The required behavior and deliberate coverage boundaries are documented in
[`COVERAGE.md`](COVERAGE.md).
