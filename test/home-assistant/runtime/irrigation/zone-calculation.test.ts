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
				const log = await waitForValveLog('Calculated 7 minutes for each 1-day planning cycle')
				expect(String(log.serviceData.message)).toContain('rain duration: 0.0%')
				expect(String(log.serviceData.message)).toContain('maximum temperature: 20.0 °C')
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

	test('adds a bounded proportional soil-moisture increase and publishes the watering limit', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.moisture,
			async ({ entities, expectHelperToBecome, prepareNextAction, setAutomationEnabled, setMoisture, waitForValveLog }) => {
				const cases = [
					{ expectedRuntime: 7, moisture: '60' },
					{ expectedRuntime: 11, moisture: '50' },
					{ expectedRuntime: 14, moisture: '40' },
					{ expectedRuntime: 14, moisture: '0' },
					{ expectedRuntime: 7, moisture: 'unavailable' },
				] as const

				for (const { expectedRuntime, moisture } of cases) {
					await setAutomationEnabled(false)
					await setMoisture(moisture)
					await prepareNextAction()
					await setAutomationEnabled(true)
					await expectHelperToBecome({
						interval: 1,
						max_runtime: 60,
						runtime: expectedRuntime,
						valve: entities.valve,
					})
				}

				const log = await waitForValveLog('Soil moisture:')
				expect(String(log.serviceData.message)).toContain('target:')
				expect(String(log.serviceData.message)).toContain('60%')
			}
		)
	})

	test('repairs invalid input, uses sensor fallbacks, and filters the shared helper schema', async () => {
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
					custom: 'drop me',
					cycle: '2026-01-01T04:37:00+01:00',
					interval: 1,
					next: ['2026-01-01T08:37:00+01:00', 60, 1],
					next_start: 'legacy',
					runtime: 7,
					slot: 1,
					watered: 60,
				})
				await setClimate({ rainfall: '0', temperature: '30' })

				// If a valid helper contains known scheduler state and unknown metadata,
				// expect recalculation to retain only the shared schema while updating runtime
				await setAutomationEnabled(true)
				await expectHelperToBecome({
					cycle: '2026-01-01T04:37:00+01:00',
					interval: 1,
					next: ['2026-01-01T08:37:00+01:00', 60, 1],
					runtime: 14,
					slot: 1,
					valve: entities.valve,
					watered: 60,
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
