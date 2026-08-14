import { describe, test } from 'vitest'
import { withEmaScenario } from './helpers.ts'
import { EMA_SCENARIO } from './scenarios.ts'

// EMA_SCENARIO starts with input 20, average 10, period length 4,
// precision 1, and its automation disabled

describe("Hippo's Time-Based Exponential Moving Average", () => {
	test('moves the average toward an unchanged input once per minute', async () => {
		await withEmaScenario(EMA_SCENARIO, async ({ expectAverageToBecome, sample, setAutomationEnabled }) => {
			await setAutomationEnabled(true)

			// Given the common scenario start (see above),
			// expect the new input of 20 to move the average to 14:
			// 10 + (2 / (4 + 1)) * (20 - 10) = 14
			await sample()
			await expectAverageToBecome(14)

			// Even though the input sensor has not emitted a new value before the next sample,
			// expect time-based sampling to continue moving the average toward the input of 20
			await sample()
			await expectAverageToBecome(16.4)
		})
	})

	test('rounds upward when the input is higher than the current average', async () => {
		await withEmaScenario(EMA_SCENARIO, async ({ expectAverageToBecome, sample, setAutomationEnabled, setAverage, setInput }) => {
			await setAverage(10.2)
			await setInput('10.26')
			await setAutomationEnabled(true)

			// If input 10.26 is sampled from average 10.2 with period length 4,
			// expect the result to round upward to 10.3 and keep the average moving:
			// 10.2 + (2 / (4 + 1)) * (10.26 - 10.2) = 10.224 -> 10.3
			await sample()
			await expectAverageToBecome(10.3)
		})
	})

	test('rounds downward when the input is lower than the current average', async () => {
		await withEmaScenario(EMA_SCENARIO, async ({ expectAverageToBecome, sample, setAutomationEnabled, setAverage, setInput }) => {
			await setAverage(10.3)
			await setInput('10.24')
			await setAutomationEnabled(true)

			// If input 10.24 is sampled from average 10.3 with period length 4,
			// expect the result to round downward to 10.2 and keep the average moving:
			// 10.3 + (2 / (4 + 1)) * (10.24 - 10.3) = 10.276 -> 10.2
			await sample()
			await expectAverageToBecome(10.2)
		})
	})

	test('does not update for an equal precision value or unavailable input', async () => {
		await withEmaScenario(EMA_SCENARIO, async ({ expectNoAverageUpdates, sample, setAutomationEnabled, setAverage, setInput }) => {
			await setAverage(10.3)
			await setAutomationEnabled(true)

			// If the source and stored average are both 10.3 at precision 1,
			// expect no helper update
			await setInput('10.34')
			await sample()
			await expectNoAverageUpdates()

			// If the source becomes unavailable, expect no helper update
			await setInput('unavailable')
			await sample()
			await expectNoAverageUpdates()
		})
	})
})
