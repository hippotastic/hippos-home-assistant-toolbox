import { describe, expect, test } from 'vitest'
import { withCalculationScenario } from './helpers.ts'
import { IRRIGATION_CALCULATION_SCENARIOS } from './scenarios.ts'

describe("Hippo's Irrigation Zone Calculation", () => {
	test('initializes empty and non-object helpers and explains the calculation on the valve', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.emptyHelper,
			async ({ entities, expectHelperToBecome, setAutomationEnabled, setRawZoneHelper, waitForValveLog }) => {
				// If the helper is empty or does not contain an object,
				// expect the calculated zone status to replace it
				for (const helperValue of ['', '[]', 'null', '"text"']) {
					await setAutomationEnabled(false)
					await setRawZoneHelper(helperValue)
					await setAutomationEnabled(true)

					await expectHelperToBecome({
						interval: 1,
						runtime: 7,
						valve: entities.valve,
					})
				}

				// If the watering requirement changes, expect the valve log to explain
				// the calculated runtime and its climate inputs
				const log = await waitForValveLog('Updated watering requirement to 7 minutes every 1 day')
				expect(String(log.serviceData.message)).toContain('0% rainfall')
				expect(String(log.serviceData.message)).toContain('20.0 degrees Celsius')
			}
		)
	})

	test('calculates climate factors across temperature, rain, and rounding boundaries', async () => {
		const cases = [
			{ expectedRuntime: 7, rainfall: '0', temperature: '20' },
			{ expectedRuntime: 0, rainfall: '0', temperature: '11' },
			{ expectedRuntime: 14, rainfall: '0', temperature: '30' },
			{ expectedRuntime: 20, rainfall: '0', temperature: '35' },
			{ expectedRuntime: 4, rainfall: '1', temperature: '20' },
			{ expectedRuntime: 0, rainfall: '2.1', temperature: '35' },
		] as const

		await withCalculationScenario(IRRIGATION_CALCULATION_SCENARIOS.formula, async ({ entities, expectHelperToBecome, setAutomationEnabled, setClimate }) => {
			// If temperature and rainfall cross their calculation boundaries,
			// expect the runtime to follow the configured climate formula
			for (const { expectedRuntime, rainfall, temperature } of cases) {
				await setAutomationEnabled(false)
				await setClimate({ rainfall, temperature })
				await setAutomationEnabled(true)

				await expectHelperToBecome({
					interval: 1,
					runtime: expectedRuntime,
					valve: entities.valve,
				})
			}
		})
	})

	test('repairs invalid input, uses sensor fallbacks, and preserves scheduler metadata', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.fallback,
			async ({ entities, expectHelperToBecome, setAutomationEnabled, setClimate, setRawZoneHelper, setZoneHelper }) => {
				await setRawZoneHelper('not valid JSON')
				await setClimate({ rainfall: 'unavailable', temperature: 'unknown' })

				// If the helper contains invalid JSON and both climate sensors are unavailable,
				// expect a fresh status calculated from the configured fallback values
				await setAutomationEnabled(true)
				await expectHelperToBecome({
					interval: 1,
					runtime: 7,
					valve: entities.valve,
				})

				await setAutomationEnabled(false)
				await setZoneHelper({
					custom: 'keep me',
					interval: 1,
					last_end: '2026-01-01T04:47:00+01:00',
					next_start: '2026-01-02T04:50:00+01:00',
					next_end: '2026-01-02T05:00:00+01:00',
					runtime: 7,
				})
				await setClimate({ rainfall: '0', temperature: '30' })

				// If a valid helper already contains scheduler metadata,
				// expect recalculation to preserve it while updating the runtime
				await setAutomationEnabled(true)
				await expectHelperToBecome({
					custom: 'keep me',
					interval: 1,
					last_end: '2026-01-01T04:47:00+01:00',
					next_start: '2026-01-02T04:50:00+01:00',
					next_end: '2026-01-02T05:00:00+01:00',
					runtime: 14,
					valve: entities.valve,
				})
			}
		)
	})

	test('keeps an already-current status unchanged', async () => {
		await withCalculationScenario(IRRIGATION_CALCULATION_SCENARIOS.noOp, async ({ expectNoHelperChanges, prepareNextAction, setAutomationEnabled, setZoneHelper }) => {
			await setZoneHelper({ interval: 1, runtime: 7 })
			await prepareNextAction()

			// If the calculated status is unchanged, expect no helper state change
			await setAutomationEnabled(true)
			await expectNoHelperChanges()
		})
	})

	test('reconciles climate changes when the automation is re-enabled', async () => {
		await withCalculationScenario(IRRIGATION_CALCULATION_SCENARIOS.reconcile, async ({ expectHelperToBecome, setAutomationEnabled, setClimate }) => {
			// Briefly enable the automation to establish its 7-minute default runtime,
			// then disable it again
			await setAutomationEnabled(true)
			await expectHelperToBecome((value) => value.runtime === 7)
			await setAutomationEnabled(false)

			// While the automation is disabled, raise the temperature to require more watering
			await setClimate({ rainfall: '0', temperature: '35' })

			// If we re-enable the automation now, expect the helper to contain a longer runtime
			await setAutomationEnabled(true)
			await expectHelperToBecome((value) => value.runtime === 20)
		})
	})
})
