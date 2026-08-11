import { describe, expect, test } from 'vitest'
import { withScenarioDiagnostics } from '../../harness/client.ts'
import { calculationScenarioEntityIds, initializeCalculationScenario, setAutomation, setHelper, waitForZoneStatus } from './helpers.ts'
import { IRRIGATION_CALCULATION_SCENARIOS, IRRIGATION_VARIANTS } from './scenarios.ts'

describe("Hippo's Irrigation Zone Calculation", () => {
	test('initializes empty and non-object helpers and explains the calculation on the valve', async () => {
		const scenario = IRRIGATION_CALCULATION_SCENARIOS.emptyHelper
		await withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
			await initializeCalculationScenario(client, scenario)

			for (const helperValue of ['', '[]', 'null', '"text"']) {
				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await setAutomation(client, entities.automation, false)
					await setHelper(client, entities.helper, helperValue)
					await setAutomation(client, entities.automation, true)
					expect(await waitForZoneStatus(client, entities.helper, (value) => value.runtime === 7)).toEqual({
						interval: 1,
						runtime: 7,
						valve: entities.valve,
					})
				}
			}

			const current = scenario.variants.current
			const log = await client.waitForServiceCall({ domain: 'logbook', entityId: current.valve, service: 'log' })
			expect(String(log.serviceData.message)).toContain('Updated watering requirement to 7 minutes every 1 day')
			expect(String(log.serviceData.message)).toContain('0% rainfall')
			expect(String(log.serviceData.message)).toContain('20.0 degrees Celsius')
		})
	})

	test('calculates climate factors across temperature, rain, and rounding boundaries', async () => {
		const scenario = IRRIGATION_CALCULATION_SCENARIOS.formula
		const cases = [
			{ expectedRuntime: 7, rainfall: '0', temperature: '20' },
			{ expectedRuntime: 0, rainfall: '0', temperature: '11' },
			{ expectedRuntime: 14, rainfall: '0', temperature: '30' },
			{ expectedRuntime: 20, rainfall: '0', temperature: '35' },
			{ expectedRuntime: 4, rainfall: '1', temperature: '20' },
			{ expectedRuntime: 0, rainfall: '2.1', temperature: '35' },
		] as const

		await withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
			await initializeCalculationScenario(client, scenario)

			for (const { expectedRuntime, rainfall, temperature } of cases) {
				for (const variant of IRRIGATION_VARIANTS) {
					await setAutomation(client, scenario.variants[variant].automation, false)
				}
				await client.setState(scenario.sensors.rainfall, rainfall)
				await client.setState(scenario.sensors.temperature, temperature)
				await client.clearEvents()

				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await setAutomation(client, entities.automation, true)
					const status = await waitForZoneStatus(client, entities.helper, (value) => value.runtime === expectedRuntime)
					expect(status).toMatchObject({
						interval: 1,
						runtime: expectedRuntime,
						valve: entities.valve,
					})
				}
			}
		})
	})

	test('repairs invalid input, uses sensor fallbacks, and preserves scheduler metadata', async () => {
		const scenario = IRRIGATION_CALCULATION_SCENARIOS.fallback
		await withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
			await initializeCalculationScenario(client, scenario, {
				helperValue: 'not valid JSON',
				rainfall: 'unavailable',
				temperature: 'unknown',
			})

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.automation, true)
				expect(await waitForZoneStatus(client, entities.helper, (value) => value.runtime === 7)).toEqual({
					interval: 1,
					runtime: 7,
					valve: entities.valve,
				})
			}

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.automation, false)
				await setHelper(client, entities.helper, {
					custom: 'keep me',
					interval: 1,
					last_end: '2026-01-01T04:47:00+01:00',
					next_end: '2026-01-02T05:00:00+01:00',
					next_start: '2026-01-02T04:50:00+01:00',
					runtime: 7,
					valve: entities.valve,
				})
			}
			await client.setState(scenario.sensors.rainfall, '0')
			await client.setState(scenario.sensors.temperature, '30')
			await client.clearEvents()

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.automation, true)
				expect(await waitForZoneStatus(client, entities.helper, (value) => value.runtime === 14)).toEqual({
					custom: 'keep me',
					interval: 1,
					last_end: '2026-01-01T04:47:00+01:00',
					next_end: '2026-01-02T05:00:00+01:00',
					next_start: '2026-01-02T04:50:00+01:00',
					runtime: 14,
					valve: entities.valve,
				})
			}
		})
	})

	test('does not write an unchanged status', async () => {
		const scenario = IRRIGATION_CALCULATION_SCENARIOS.noOp
		await withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
			await initializeCalculationScenario(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setHelper(client, entities.helper, { interval: 1, runtime: 7, valve: entities.valve })
			}
			await client.clearEvents()

			for (const variant of IRRIGATION_VARIANTS) {
				await setAutomation(client, scenario.variants[variant].automation, true)
			}
			await Promise.all(
				IRRIGATION_VARIANTS.map((variant) =>
					client.expectNoServiceCall({ domain: 'input_text', entityId: scenario.variants[variant].helper, service: 'set_value' }, { timeoutMs: 350 })
				)
			)
		})
	})

	test('reconciles climate changes when the automation is re-enabled', async () => {
		const scenario = IRRIGATION_CALCULATION_SCENARIOS.reconcile
		await withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
			await initializeCalculationScenario(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.automation, true)
				await waitForZoneStatus(client, entities.helper, (value) => value.runtime === 7)
				await setAutomation(client, entities.automation, false)
			}

			await client.setState(scenario.sensors.temperature, '35')
			await client.clearEvents()
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.automation, true)
				expect(await waitForZoneStatus(client, entities.helper, (value) => value.runtime === 20)).toMatchObject({ runtime: 20 })
			}
		})
	})
})
