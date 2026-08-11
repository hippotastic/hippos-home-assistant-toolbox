# Test Suite

The test suite combines fast Node.js unit tests with configuration and runtime
tests inside a real Home Assistant process. The Home Assistant-backed tests are
the final stage of `pnpm validate` but are deliberately not run in CI.

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

The harness marks the end of Home Assistant startup and inspects every
subsequent container log entry before shutdown. Unexpected Home Assistant
`WARNING`, `ERROR`, or `CRITICAL` entries fail validation even when all state
and service-call assertions passed. Repeated messages are grouped in the
failure output. The only allowlist entries are recognizable warnings emitted by
the frozen Irrigation reference blueprints; published blueprints receive no
warning exemptions.

The generated Home Assistant configuration contains:

- a separate validator config that instantiates every published blueprint;
- the published blueprints from `blueprints/automation`;
- temporary committed-version references for the Irrigation blueprints;
- one automation instance per runtime scenario;
- dedicated entities for every scenario;
- deterministic test implementations for covers, lights, and switches.

The blueprint loading checks live in
`test/home-assistant/blueprint-loading`. Its
`fixtures/configuration.yaml` provides a minimal Home Assistant configuration,
while `fixtures/automations.yaml` instantiates every published blueprint with
explicit inputs. Add matching inputs there whenever a blueprint gains a new
required input.

The regression tests for the repository's Home Assistant integration live in
`test/home-assistant/hippos-toolbox-integration`. They execute their Python test
suite inside the same Home Assistant container used by the blueprint tests.

Assertions describe the intended behavior explicitly. They remain the contract
for future blueprint revisions instead of treating an older implementation as
the expected result.

During the Irrigation revision, current and reference automations receive
identical inputs but own separate status helpers, valves, and pumps. Neither
variant is automatically authoritative. The references and their duplicate
automation instances are removed after the recommended versions are accepted;
the behavior tests remain.

## Test-Only Scalar Values

Blueprints may annotate a YAML scalar with a faster runtime-test value:

```yaml
settle_seconds: 30 # @blueprint-test-value 0.1
```

The harness parses the blueprint and replaces only the annotated scalar's
source range while copying it into the temporary runtime configuration. The
repository source, published blueprint, catalog hash, and separate Home
Assistant configuration validator continue to use `30`. Invalid directives or
directives attached to non-scalar nodes fail fixture setup. This mechanism is
reserved for deterministic test timing and must not alter functional inputs or
outputs.

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

`test/home-assistant/harness/client.ts` exposes operations for:

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
  unit/
    blueprint-catalog.test.ts
    blueprint-test-overrides.test.ts
    blueprint-yaml.test.ts
    ha-runtime-logs.test.ts
    vitest.config.ts
  home-assistant/
    blueprint-loading/
      fixtures/
        automations.yaml
        configuration.yaml
      blueprint-loading.test.ts
      vitest.config.ts
    hippos-toolbox-integration/
      python/
        repository.py
        test_*.py
      hippos-toolbox-integration.test.ts
      vitest.config.ts
    harness/
      blueprint-test-overrides.ts
      client.ts
      container.ts
      container-command.ts
      generated-config.ts
      global-setup.ts
      log-validation.ts
      setup.ts
    runtime/
      cover-automation/
        cover-automation.test.ts
        helpers.ts
        scenarios.ts
      sensor-state-machine/
        sensor-state-machine.test.ts
        helpers.ts
        scenarios.ts
      irrigation/
        helpers.ts
        scenarios.ts
        scheduler.test.ts
        zone-calculation.test.ts
      helpers/
        assertions.ts
        entities.ts
        timing.ts
      fixtures/
        configuration.yaml
        custom_components/blueprint_test/
        reference-blueprints/
      vitest.config.ts
    vitest.config.ts
  vitest.shared.ts
  COVERAGE.md
  README.md
```

The required behavior and deliberate coverage boundaries are documented in
[`COVERAGE.md`](COVERAGE.md).
