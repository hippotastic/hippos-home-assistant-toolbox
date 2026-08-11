import { describe, expect, test } from 'vitest'
import { normalizeServiceNames } from '../helpers/assertions.ts'
import { withSensorScenario } from './helpers.ts'
import { SENSOR_SCENARIOS } from './scenarios.ts'

describe("Hippo's Sensor-based State Machine", () => {
	test('turns on for any sensor and off only after all sensors turn off', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.transitions, async ({ scenario, client, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// If any input sensor turns on, expect the output to turn on
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')

			// If one sensor turns off while another remains on, expect the output to remain on
			await client.clearEvents()
			await setBoolean(scenario.inputs[1], true)
			await setBoolean(scenario.inputs[0], false)
			await expectOutputToBecome('on', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 100 })

			// If the final active sensor turns off, expect the output to turn off
			await setBoolean(scenario.inputs[1], false)
			await expectOutputToBecome('off')
		})
	})

	test('enforces required-on and required-off conditions in both directions', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.conditions, async ({ scenario, setBoolean, expectNoOutputUpdates, expectOutputToBecome }) => {
			// If presence is detected while the required-on condition is false,
			// expect the output to remain off
			await setBoolean(scenario.inputs[0], true)
			await expectNoOutputUpdates()

			// If the required-on condition becomes true during presence, expect the output to turn on
			await setBoolean(scenario.conditionOn!, true)
			await expectOutputToBecome('on')

			// If the required-off condition becomes true, expect the active output to turn off
			await setBoolean(scenario.conditionOff!, true)
			await expectOutputToBecome('off')

			// If the required-off condition becomes false again during presence,
			// expect the output to turn on
			await setBoolean(scenario.conditionOff!, false)
			await expectOutputToBecome('on')

			// If the required-on condition becomes false, expect the active output to turn off
			await setBoolean(scenario.conditionOn!, false)
			await expectOutputToBecome('off')
		})
	})

	test('uses a real 0.1-minute off delay and its condition grace window', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.delay, async ({ scenario, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// If presence is detected while all required conditions are met,
			// expect the output to turn on
			await setBoolean(scenario.conditionOn!, true)
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')

			// The scenario configures a 0.1-minute (6000 ms) off delay,
			// so if presence ends, expect the output to remain on for the first 5000 ms
			await setBoolean(scenario.inputs[0], false)
			await expectOutputToBecome('on', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 5000 })

			// After another 1000 ms, the output should turn off (5000 + 1000 = 6000 ms off delay)
			// but we wait up to 3000 ms to reduce test flakiness
			await expectOutputToBecome('off', { withinMs: 3000 })

			// If presence is detected while the required condition is not met,
			// expect the output to remain off
			await setBoolean(scenario.conditionOn!, false)
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('off', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 500 })

			// If presence ends while the required condition is not met,
			// expect the output to still remain off
			await setBoolean(scenario.inputs[0], false)
			await expectOutputToBecome('off', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 500 })

			// If the required condition becomes met briefly after presence ends
			// (while we're in the off-delay window), expect the output to turn on
			await setBoolean(scenario.conditionOn!, true)
			await expectOutputToBecome('on')
		})
	})

	test('ignores unknown sensors while retaining the all-invalid safety guard', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.invalid, async ({ scenario, client, setBoolean, expectNoOutputUpdates, expectOutputToBecome }) => {
			// If the only active sensor becomes unknown while another valid sensor is off,
			// expect the output to turn off
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')

			await client.setState(scenario.inputs[0], 'unknown')
			await expectOutputToBecome('off')

			// If every sensor becomes invalid while the output is active,
			// expect the safety guard to preserve the current output state
			await setBoolean(scenario.inputs[0], false)
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')
			await client.setState(scenario.inputs[1], 'unavailable')
			await client.clearEvents()
			await client.setState(scenario.inputs[0], 'unknown')
			await expectOutputToBecome('on', { withinMs: 0 })
			await expectNoOutputUpdates()
		})
	})

	test('expires only when every valid sensor is older than the maximum duration', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.maxDuration, async ({ scenario, client, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// If at least one active sensor is recent, expect an older valid sensor not to expire the output
			await client.setState(scenario.inputs[1], 'off', { lastChangedAgeSeconds: 120 })
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')
			await expectNoOutputChanges({ forMs: 100 })

			// If every valid sensor is older than the one-minute maximum duration,
			// expect the output to turn off
			await client.setState(scenario.inputs[0], 'on', { lastChangedAgeSeconds: 120 })
			await expectOutputToBecome('off')
		})

		await withSensorScenario(SENSOR_SCENARIOS.domainBoolean, async ({ scenario, client, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// If maximum duration is disabled, expect an old active sensor not to expire the output
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')
			await client.clearEvents()
			await client.setState(scenario.inputs[0], 'on', { lastChangedAgeSeconds: 120 })
			await expectOutputToBecome('on', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 100 })
		})
	})

	test('controls input booleans, lights, and switches through their native services', async () => {
		// If no custom actions are configured,
		// expect each output domain to use its native turn-on service
		for (const selectedScenario of [SENSOR_SCENARIOS.domainBoolean, SENSOR_SCENARIOS.domainLight, SENSOR_SCENARIOS.domainSwitch]) {
			await withSensorScenario(selectedScenario, async ({ scenario, client, setBoolean, expectOutputToBecome }) => {
				await setBoolean(scenario.inputs[0], true)
				await expectOutputToBecome('on')

				const calls = await client.serviceCalls({ entityId: scenario.entities.output })
				expect(normalizeServiceNames(calls)).toEqual([`${scenario.outputDomain}.turn_on`])
			})
		}
	})

	test('runs custom actions in order without duplicating the state service call', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.actions, async ({ scenario, client, customActionServiceNames, setBoolean, expectOutputToBecome }) => {
			// If presence starts, expect custom turn-on actions to run once in their configured order
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')
			expect(await customActionServiceNames()).toEqual(['switch.turn_on', 'input_boolean.turn_on'])

			// If presence ends, expect custom turn-off actions to run once in their configured order
			await client.clearEvents()
			await setBoolean(scenario.inputs[0], false)
			await expectOutputToBecome('off')
			expect(await customActionServiceNames()).toEqual(['switch.turn_off', 'input_boolean.turn_off'])
		})
	})

	test('reconciles an input change made while the automation was disabled', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.reconcile, async ({ scenario, client, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// If presence starts while the automation is disabled, expect no immediate output change
			await client.callService('automation', 'turn_off', { entity_id: scenario.entities.automation })
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('off', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 500 })
			await client.clearEvents()

			// If the automation is re-enabled during presence, expect it to reconcile and turn the output on
			await client.callService('automation', 'turn_on', { entity_id: scenario.entities.automation })
			await expectOutputToBecome('on')
		})
	})

	test('suppresses startup-driven turn-off until the configured uptime sensor is old enough', async () => {
		await withSensorScenario(SENSOR_SCENARIOS.startup, async ({ scenario, client, setBoolean, expectNoOutputChanges, expectOutputToBecome }) => {
			// The blueprint protects the first 30 seconds after startup
			// If presence ends during that period, expect the output to remain on
			await client.setState('sensor.uptime', new Date().toISOString())
			await setBoolean(scenario.inputs[0], true)
			await expectOutputToBecome('on')
			await client.clearEvents()
			await setBoolean(scenario.inputs[0], false)
			await expectOutputToBecome('on', { withinMs: 0 })
			await expectNoOutputChanges({ forMs: 1000 })

			// If Home Assistant has been running for 60 seconds, expect the pending turn-off to proceed
			await client.setState('sensor.uptime', new Date(Date.now() - 60000).toISOString())
			await expectOutputToBecome('off')
		})
	})
})
