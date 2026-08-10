import { describe, expect, test } from 'vitest'
import { withScenarioDiagnostics } from '../api.ts'
import { SENSOR_SCENARIOS } from '../scenarios.ts'
import { callsForEntity, expectNoCalls, initializeSensorScenario, normalizeServiceNames, scenarioEntityIds, setBoolean, settle, waitForOutputState } from './helpers.ts'

describe("Hippo's Sensor-based State Machine", () => {
	test('turns on for any sensor and off only after all sensors turn off', async () => {
		const scenario = SENSOR_SCENARIOS.transitions
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')

			await client.clearEvents()
			await setBoolean(client, scenario.inputs[1], true)
			await setBoolean(client, scenario.inputs[0], false)
			await settle()
			expect((await client.getState(scenario.entities.output))?.state).toBe('on')

			await setBoolean(client, scenario.inputs[1], false)
			await waitForOutputState(client, scenario, 'off')
		})
	})

	test('enforces required-on and required-off conditions in both directions', async () => {
		const scenario = SENSOR_SCENARIOS.conditions
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await setBoolean(client, scenario.inputs[0], true)
			await expectNoCalls(client, [{ domain: scenario.outputDomain, entityId: scenario.entities.output, service: 'turn_on' }])

			await setBoolean(client, scenario.conditionOn!, true)
			await waitForOutputState(client, scenario, 'on')

			await setBoolean(client, scenario.conditionOff!, true)
			await waitForOutputState(client, scenario, 'off')

			await setBoolean(client, scenario.conditionOff!, false)
			await waitForOutputState(client, scenario, 'on')

			await setBoolean(client, scenario.conditionOn!, false)
			await waitForOutputState(client, scenario, 'off')
		})
	})

	test('uses a real 0.1-minute off delay and its condition grace window', async () => {
		const scenario = SENSOR_SCENARIOS.delay
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await setBoolean(client, scenario.conditionOn!, true)
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')

			await setBoolean(client, scenario.inputs[0], false)
			await settle(1_000)
			expect((await client.getState(scenario.entities.output))?.state).toBe('on')
			await waitForOutputState(client, scenario, 'off', { timeoutMs: 8_000 })

			await setBoolean(client, scenario.conditionOn!, false)
			await setBoolean(client, scenario.inputs[0], true)
			await setBoolean(client, scenario.inputs[0], false)
			await settle(500)
			await setBoolean(client, scenario.conditionOn!, true)
			await waitForOutputState(client, scenario, 'on')
		})
	})

	test('ignores unknown sensors while retaining the all-invalid safety guard', async () => {
		const scenario = SENSOR_SCENARIOS.invalid
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')

			await client.setState(scenario.inputs[0], 'unknown')
			await waitForOutputState(client, scenario, 'off')

			await setBoolean(client, scenario.inputs[0], false)
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')
			await client.setState(scenario.inputs[1], 'unavailable')
			await client.clearEvents()
			await client.setState(scenario.inputs[0], 'unknown')
			await settle()

			expect((await client.getState(scenario.entities.output))?.state).toBe('on')
			await expectNoCalls(client, [{ domain: scenario.outputDomain, entityId: scenario.entities.output, service: 'turn_off' }])
		})
	})

	test('expires only when every valid sensor is older than the maximum duration', async () => {
		const scenario = SENSOR_SCENARIOS.maxDuration
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await client.setState(scenario.inputs[1], 'off', { lastChangedAgeSeconds: 120 })
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')
			await settle()
			expect((await client.getState(scenario.entities.output))?.state).toBe('on')

			await client.setState(scenario.inputs[0], 'on', { lastChangedAgeSeconds: 120 })
			await waitForOutputState(client, scenario, 'off')
		})

		const disabled = SENSOR_SCENARIOS.domainBoolean
		await withScenarioDiagnostics(scenarioEntityIds(disabled), async (client) => {
			await initializeSensorScenario(client, disabled)
			await setBoolean(client, disabled.inputs[0], true)
			await waitForOutputState(client, disabled, 'on')
			await client.clearEvents()
			await client.setState(disabled.inputs[0], 'on', { lastChangedAgeSeconds: 120 })
			await settle()
			expect((await client.getState(disabled.entities.output))?.state).toBe('on')
		})
	})

	test('controls input booleans, lights, and switches through their native services', async () => {
		for (const scenario of [SENSOR_SCENARIOS.domainBoolean, SENSOR_SCENARIOS.domainLight, SENSOR_SCENARIOS.domainSwitch]) {
			await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
				await initializeSensorScenario(client, scenario)
				await setBoolean(client, scenario.inputs[0], true)
				await waitForOutputState(client, scenario, 'on')

				const calls = await client.serviceCalls({ entityId: scenario.entities.output })
				expect(normalizeServiceNames(calls)).toEqual([`${scenario.outputDomain}.turn_on`])
			})
		}
	})

	test('runs custom actions in order without duplicating the state service call', async () => {
		const scenario = SENSOR_SCENARIOS.actions
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')

			const onCalls = (await client.serviceCalls()).filter(
				(call) => callsForEntity([call], scenario.entities.marker).length > 0 || callsForEntity([call], scenario.entities.output).length > 0
			)
			expect(normalizeServiceNames(onCalls)).toEqual(['switch.turn_on', 'input_boolean.turn_on'])

			await client.clearEvents()
			await setBoolean(client, scenario.inputs[0], false)
			await waitForOutputState(client, scenario, 'off')
			const offCalls = (await client.serviceCalls()).filter(
				(call) => callsForEntity([call], scenario.entities.marker).length > 0 || callsForEntity([call], scenario.entities.output).length > 0
			)
			expect(normalizeServiceNames(offCalls)).toEqual(['switch.turn_off', 'input_boolean.turn_off'])
		})
	})

	test('reconciles an input change made while the automation was disabled', async () => {
		const scenario = SENSOR_SCENARIOS.reconcile
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await client.callService('automation', 'turn_off', { entity_id: scenario.entities.automation })
			await setBoolean(client, scenario.inputs[0], true)
			await client.clearEvents()

			await client.callService('automation', 'turn_on', { entity_id: scenario.entities.automation })
			await waitForOutputState(client, scenario, 'on')
		})
	})

	test('suppresses startup-driven turn-off until the configured uptime sensor is old enough', async () => {
		const scenario = SENSOR_SCENARIOS.startup
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeSensorScenario(client, scenario)
			await client.setState('sensor.uptime', new Date().toISOString())
			await setBoolean(client, scenario.inputs[0], true)
			await waitForOutputState(client, scenario, 'on')
			await client.clearEvents()
			await setBoolean(client, scenario.inputs[0], false)
			await settle(1_000)

			expect((await client.getState(scenario.entities.output))?.state).toBe('on')

			await client.setState('sensor.uptime', new Date(Date.now() - 60_000).toISOString())
			await waitForOutputState(client, scenario, 'off')
		})
	})
})
