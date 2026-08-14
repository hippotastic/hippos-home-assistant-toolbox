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
same container. Test files execute concurrently with up to three workers and
address Home Assistant through a small test-only integration. Every scenario
owns its entities and event cursor, so one test never clears or consumes
another test's observations.

The harness marks the end of Home Assistant startup and inspects every
subsequent container log entry before shutdown. Unexpected Home Assistant
`WARNING`, `ERROR`, or `CRITICAL` entries fail validation even when all state
and service-call assertions passed. Repeated messages are grouped in the
failure output. There are currently no warning exemptions.

The generated Home Assistant configuration contains:

- a separate validator config that instantiates every published blueprint;
- the published blueprints from `blueprints/automation`;
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
suite inside the same Home Assistant container used by the blueprint tests. A
startup scenario also loads an existing automation from the legacy `hippo/`
directory, migrates it through the production manager, reloads automations, and
verifies that Home Assistant now counts the managed `hippotastic/` blueprint as
in use. This reuses the shared container and adds no second Home Assistant boot.

Assertions describe the intended behavior explicitly. They remain the contract
for future blueprint revisions instead of treating an older implementation as
the expected result.

## Test Case Style

Tests should read from top to bottom as a sequence of small behavioral
scenarios. Prefer explicit, linear setup, actions, and assertions over helpers
that hide the state transitions relevant to the test.

- Separate behaviorally distinct phases with blank lines
- Add a short comment before each phase whose purpose is not immediately clear
- Write comments in English and sentence case without punctuation at the end
- Prefer `If <situation>, expect <behavior>` for comments that describe expected behavior
- Wrap a comment across multiple lines when that makes its situation and expectation easier to scan
- Explain why a combination matters instead of narrating the individual API calls
- Assert meaningful intermediate states immediately after the transition that produces them
- Keep separate assertions for distinct states even when the final result would otherwise cover both
- State non-obvious fixture values explicitly, including units and relevant conversions
- Distinguish the expected timing from a larger technical timeout used to reduce test flakiness
- Write test timing literals without numeric separators, for example `5000` rather than `5_000`

For example:

```ts
await withSensorScenario(SENSOR_SCENARIOS.delay, async ({ scenario, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
  // If presence is detected while the required condition is not met,
  // expect the output to remain off
  await setBoolean(scenario.inputs[0], true)
  await expectOutputToBecome('off', { withinMs: 0 })
  await expectNoOutputChanges()

  // If the required condition becomes met inside the off-delay window,
  // expect the output to turn on
  await setBoolean(scenario.conditionOn!, true)
  await expectOutputToBecome('on')
})
```

Comments should clarify the behavioral contract. Do not add comments to
self-explanatory setup or assertions merely to make every block look alike.

`withSensorScenario` adds diagnostics, initializes the scenario, and supplies
the scenario, raw client, and bound test functions to the callback. Destructure
only the functions used by that test. Use `expectOutputToBecome` for
transitions; by default, the expected state must be reached within 500 ms. Pass
`withinMs` only when the behavior intentionally takes longer. Use
`expectNoOutputChanges` to reject output state changes caused by the preceding
action. Without `forMs`, the assertion waits for that scenario's automation to
finish and evaluates its local event window, so an action that starts no
automation completes quickly. Pass `forMs` only when behavior after the
current automation run matters, such as a delayed or future time trigger.
`expectNoOutputUpdates` additionally rejects matching service calls and is
reserved for behavior where even an idempotent device command is significant.
Use `prepareNextAction` between behavioral phases that should have independent
event histories. Generic Home Assistant operations remain available through
`client`.

`withCoverScenario` follows the same structure and supplies bound operations
for automatic control, modes, sun position, helper state, and the physical
cover state. `expectHelperToBecome` and `expectCoverToBecome` wait for an
explicit expected state. `expectNoHelperChanges` observes only visible helper
state changes, while `expectNoCoverUpdates` also rejects movement service
calls. This distinction keeps assertions focused on effects that matter in
Home Assistant: an identical `input_text` write creates no History or Logbook
entry, while an idempotent cover command can still reach physical hardware.
All scenario fixtures reuse the same central `ToBecome`, `NoChanges`, and
`NoUpdates` expectation logic. A fast negative assertion fails instead of
silently passing when its automation remains inside a delay beyond the action
settling timeout.

The irrigation fixtures also separate neutral initialization from the
behavioral setup in each test. `setZoneHelper` supplies the scenario's valve
entity automatically;
`setRawZoneHelper` is reserved for deliberately malformed fixture data.
`startSchedulers` finishes the setup action, starts a fresh local event window,
renews the relative-time anchor, and then enables the scenario automation.
Calculation tests switch their automation explicitly with
`setAutomationEnabled`. A scheduler fixture's `relativeTime` supports only the
`minutes` and `milliseconds` offsets required by the runtime tests.

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
- Runtime clients use monotonic local event cursors and detect when retained
  event history would be too short for a reliable assertion.

`KEEP_HA_BLUEPRINT_RUNTIME_TEST_CONFIG=1` keeps a failed run's generated config
for inspection. A later run still creates a different temporary directory.

## Runtime Client

`test/home-assistant/harness/client.ts` exposes operations for:

- setting states with attributes and a controlled `last_changed` age;
- calling real Home Assistant services;
- waiting for states, attributes, and service calls;
- waiting for scenario automations to finish the current action;
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
        actions.ts
        assertions.ts
        entities.ts
        timing.ts
      fixtures/
        configuration.yaml
        custom_components/blueprint_test/
      vitest.config.ts
    vitest.config.ts
  vitest.shared.ts
  COVERAGE.md
  README.md
```

The required behavior and deliberate coverage boundaries are documented in
[`COVERAGE.md`](COVERAGE.md).
