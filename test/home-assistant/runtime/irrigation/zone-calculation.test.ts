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
						r: 0,
						runtime: 7,
						valve: entities.valve,
					})
				}

				// If the watering requirement changes, expect the valve log to explain
				// the calculated runtime and its climate inputs
				const log = await waitForValveLog('Calculated 7 minutes of watering demand for the current 1-day cycle')
				expect(String(log.serviceData.message)).toContain('10 minutes base runtime - 3 minutes due to low temperature (20.0 °C)')
				expect(String(log.serviceData.message)).toContain('- 0 minutes of rain')
			}
		)
	})

	test('calculates climate factors across temperature, rain, and rounding boundaries', async () => {
		const cases = [
			{ expectedRain: 0, expectedRuntime: 7, rainfall: '0', temperature: '20' },
			{ expectedRain: 0, expectedRuntime: 0, rainfall: '0', temperature: '11' },
			{ expectedRain: 0, expectedRuntime: 14, rainfall: '0', temperature: '30' },
			{ expectedRain: 0, expectedRuntime: 20, rainfall: '0', temperature: '35' },
			{ expectedRain: 3, expectedRuntime: 4, rainfall: '0.2', temperature: '20' },
			{ expectedRain: 15, expectedRuntime: 0, rainfall: '1', temperature: '20' },
			{ expectedRain: 31, expectedRuntime: 0, rainfall: '2.1', temperature: '35' },
		] as const

		await withCalculationScenario(IRRIGATION_CALCULATION_SCENARIOS.formula, async ({ entities, expectHelperToBecome, setAutomationEnabled, setClimate }) => {
			// If temperature and rainfall cross their calculation boundaries,
			// expect the runtime to follow the configured climate formula
			for (const { expectedRain, expectedRuntime, rainfall, temperature } of cases) {
				await setAutomationEnabled(false)
				await setClimate({ rainfall, temperature })
				await setAutomationEnabled(true)

				await expectHelperToBecome({
					interval: 1,
					r: expectedRain,
					runtime: expectedRuntime,
					valve: entities.valve,
				})
			}
		})
	})

	test('scales detected rain minutes by the zone credit and explains the adjustment', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.rainCredit,
			async ({ entities, expectHelperToBecome, setAutomationEnabled, setClimate, setMoisture, waitForValveLog }) => {
				await setClimate({ rainfall: '1.9', temperature: '41.6' })
				await setMoisture('60')

				// A 30-minute reference demand doubles at the heat limit. The zone credits
				// half of the 28 detected rain minutes because some rain misses its soil.
				await setAutomationEnabled(true)
				await expectHelperToBecome({
					interval: 2,
					r: 14,
					runtime: 46,
					valve: entities.valve,
				})

				const log = await waitForValveLog('Calculated 46 minutes of watering demand for the current 2-day cycle')
				const message = String(log.serviceData.message)
				expect(message).toBe(
					'Calculated 46 minutes of watering demand for the current 2-day cycle: 30 minutes base runtime + 30 minutes due to heat (41.6 °C) + 0 minutes due to soil (current: 60%, target: 50%) - 14 minutes of rain (50% credit).'
				)

				// If the configured share produces half a minute, round the credit down
				// so the zone is never under-watered because of rain-credit rounding.
				await setAutomationEnabled(false)
				await setClimate({ rainfall: '1.7', temperature: '41.6' })
				await setAutomationEnabled(true)
				await expectHelperToBecome({
					interval: 2,
					r: 12,
					runtime: 48,
					valve: entities.valve,
				})
				const roundedLog = await waitForValveLog('Calculated 48 minutes of watering')
				expect(String(roundedLog.serviceData.message)).toContain('- 12 minutes of rain (50% credit)')
			}
		)
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
						r: 0,
						runtime: expectedRuntime,
						valve: entities.valve,
					})
				}

				const log = await waitForValveLog('minutes due to soil')
				expect(String(log.serviceData.message)).toContain('current: 60%, target: 60%')
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
					r: 0,
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
					r: 0,
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
			await setZoneHelper({ interval: 1, r: 0, runtime: 7 })
			await prepareNextAction()

			// If the calculated status is unchanged, expect no helper state change
			await setAutomationEnabled(true)
			await expectNoHelperChanges()
		})
	})

	test('only applies positive rain-credit changes between slots', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.rainCredit,
			async ({ client, expectHelperToBecome, prepareNextAction, requestRainReconciliation, setAutomationEnabled, setClimate, setMoisture, waitForValveLog }) => {
				await setClimate({ rainfall: '1.9', temperature: '41.6' })
				await setMoisture('60')
				await setAutomationEnabled(true)
				await expectHelperToBecome((status) => status.runtime === 46 && status.r === 14)

				// A later slot observes seven additional credited rain minutes. Changes
				// to heat and soil are ignored because their interval snapshot is frozen.
				await setClimate({ rainfall: '2.9', temperature: '11' })
				await setMoisture('0')
				await prepareNextAction()
				await requestRainReconciliation()
				await expectHelperToBecome((status) => status.runtime === 39 && status.r === 21)
				const reducedLog = await waitForValveLog('Additional rain reduced watering demand from 46 to 39 minutes')
				expect(String(reducedLog.serviceData.message)).toContain('Total rain credit: 21 minutes; previously observed: 14 minutes')

				// A falling sliding-window value is stored silently and never increases demand.
				await setClimate({ rainfall: '0.1', temperature: '35' })
				await prepareNextAction()
				await requestRainReconciliation()
				await expectHelperToBecome((status) => status.runtime === 39 && status.r === 1)
				expect(await client.serviceCalls({ domain: 'logbook', service: 'log' })).toEqual([])

				// Comparing with the latest observation lets a later rebound contribute
				// rain even though it stays below the interval's original 14-minute credit.
				await setClimate({ rainfall: '1.1', temperature: '20' })
				await prepareNextAction()
				await requestRainReconciliation()
				await expectHelperToBecome((status) => status.runtime === 32 && status.r === 8)
			}
		)
	})

	test('takes a fresh climate snapshot when a primary slot opens the next interval', async () => {
		await withCalculationScenario(
			IRRIGATION_CALCULATION_SCENARIOS.rainCredit,
			async ({ client, entities, expectHelperToBecome, setAutomationEnabled, setClimate, setMoisture, setZoneHelper }) => {
				await setClimate({ rainfall: '1.9', temperature: '41.6' })
				await setMoisture('60')
				await setAutomationEnabled(true)
				const initial = await expectHelperToBecome((status) => status.runtime === 46 && status.r === 14)
				const nextCycle = new Date(Date.now() + 120_000).toISOString()
				await setZoneHelper({ ...initial, cycle: nextCycle })

				await setClimate({ rainfall: '2.9', temperature: '11' })
				await setMoisture('0')
				await client.fireEvent('hippos_irrigation_slot_preparing', {
					slot: 'primary',
					start: nextCycle,
					zone_status_helper_entities: [entities.helper],
				})

				// Cold weather disables demand completely, proving that interval-start
				// preparation refreshes all inputs rather than applying only rain.
				await expectHelperToBecome((status) => status.runtime === 0 && status.r === 21)
			}
		)
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
