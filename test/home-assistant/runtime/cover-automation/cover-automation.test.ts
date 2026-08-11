import { describe, expect, test } from 'vitest'
import { settle } from '../helpers/timing.ts'
import { withCoverScenario } from './helpers.ts'
import { COVER_SCENARIOS } from './scenarios.ts'

describe("Hippo's Cover Automation", () => {
	test('applies defaults and a valid external angle override when control is enabled', async () => {
		await withCoverScenario(
			COVER_SCENARIOS.default,
			async ({
				client,
				setAutomaticControl,
				setExternalAngle,
				expectHelperToBecome,
				expectNoHelperChanges,
				expectCoverToBecome,
				expectNoCoverUpdates,
				coverCalls,
				coreLogMessages,
			}) => {
				// If automatic control is disabled, expect input changes not to move the cover
				// or update its helper
				await setExternalAngle(61)
				await Promise.all([expectNoHelperChanges(), expectNoCoverUpdates()])

				// If automatic control is enabled, expect the configured position
				// and latest valid angle override to be applied
				await setExternalAngle(62)
				await settle()
				await client.clearEvents()
				await setAutomaticControl(true)

				await expectHelperToBecome({ angle: 62, modes: [], position: 80 })
				await expectCoverToBecome({ angle: 62, position: 80 })
				expect(await coverCalls()).toEqual([
					{ service: 'set_cover_position', value: 80 },
					{ service: 'set_cover_tilt_position', value: 62 },
				])
				expect(await coreLogMessages()).toContain('Moving to position 80%. Changing angle to 62%.')
			}
		)
	})

	test('falls back to the configured angle for invalid external values', async () => {
		for (const selectedScenario of [COVER_SCENARIOS.invalidAngle, COVER_SCENARIOS.invalidHighAngle]) {
			await withCoverScenario(selectedScenario, async ({ scenario, client, setAutomaticControl, expectHelperToBecome, expectCoverToBecome }) => {
				// If the external angle is below -1 or above 100,
				// expect the configured angle to be applied instead
				if (scenario === COVER_SCENARIOS.invalidHighAngle) {
					// Keep the reported tilt aligned with the invalid high override
					// before automatic control starts
					await client.setState(scenario.commonInputs.default_angle_entity as string, '101')
					await client.setState(scenario.entities.cover, 'open', {
						attributes: { current_position: 65, current_tilt_position: 101 },
					})
					await settle()
					await client.clearEvents()
				}
				await setAutomaticControl(true)

				await expectHelperToBecome({ angle: 35, modes: [], position: 65 })
				await expectCoverToBecome({ angle: 35 }, scenario === COVER_SCENARIOS.invalidHighAngle ? { withinMs: 6000 } : undefined)
			})
		}
	})

	test('handles sun protection across north and leaves it below the elevation limit', async () => {
		await withCoverScenario(COVER_SCENARIOS.sun, async ({ client, setAutomaticControl, setMode, setSun, expectHelperToBecome, expectNoHelperChanges }) => {
			// If the sun is above the elevation limit inside an azimuth range crossing north,
			// expect sun protection to activate
			await setMode('sun', true)
			await setSun({ azimuth: 350, elevation: 30 })
			await settle()
			await client.clearEvents()
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 30, modes: ['sun'], position: 70 })

			// If the sun drops below the elevation limit, expect the cover to return to its default state
			await client.clearEvents()
			await setSun({ azimuth: 350, elevation: 10 })
			await expectHelperToBecome({ angle: 45, modes: [], position: 80 })

			// If the sun leaves the azimuth range while the cover is already at its default,
			// expect no helper state change
			await client.clearEvents()
			await setSun({ azimuth: 180, elevation: 30 })
			await expectNoHelperChanges()
		})

		await withCoverScenario(COVER_SCENARIOS.sunNormal, async ({ client, setAutomaticControl, setMode, setSun, expectHelperToBecome }) => {
			// If the sun is inside a normal non-wrapping azimuth range, expect sun protection to activate
			await setMode('sun', true)
			await setSun({ azimuth: 180, elevation: 30 })
			await settle()
			await client.clearEvents()
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 30, modes: ['sun'], position: 70 })
		})
	})

	test('applies privacy, night, and lockout priorities in order', async () => {
		await withCoverScenario(COVER_SCENARIOS.modes, async ({ client, setAutomaticControl, setMode, expectHelperToBecome, coreLogMessages }) => {
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 45, modes: [], position: 80 })

			// If privacy mode activates, expect its position and angle to override the defaults
			await client.clearEvents()
			await setMode('privacy', true)
			await expectHelperToBecome({ angle: 25, modes: ['privacy'], position: 40 })

			// If night mode also activates, expect it to take priority while preserving both active modes
			await client.clearEvents()
			await setMode('night', true)
			await expectHelperToBecome({ angle: 15, modes: ['privacy', 'night'], position: 10 })

			// If lockout also activates, expect it to take highest priority and explain the safety movement
			await client.clearEvents()
			await setMode('lockout', true)
			await expectHelperToBecome({ angle: 100, modes: ['privacy', 'night', 'lockout'], position: 90 })
			expect(await coreLogMessages()).toContain('Lockout prevention turned on, and cover must be opened. Moving to position 90%. Changing angle to 100%.')
		})
	})

	test('opens for lockout and then prevents closing an already more-open cover', async () => {
		await withCoverScenario(
			COVER_SCENARIOS.lockout,
			async ({ client, setAutomaticControl, setMode, moveCover, expectHelperToBecome, expectCoverToBecome, expectNoCoverUpdates, coreLogMessages }) => {
				// If lockout activates while the cover is less open than required,
				// expect it to open to the lockout position
				await setAutomaticControl(true)
				await expectHelperToBecome({ angle: 50, modes: [], position: 40 })
				await client.clearEvents()
				await setMode('lockout', true)

				await expectHelperToBecome({ angle: 70, modes: ['lockout'], position: 80 })
				await expectCoverToBecome({ angle: 70, position: 80 })

				// If the user opens the cover further, expect a lower-priority mode not to close it again
				await client.clearEvents()
				await moveCover({ position: 95 })
				await expectCoverToBecome({ position: 95 })
				await client.clearEvents()
				await setMode('privacy', true)

				await expectNoCoverUpdates()
				expect((await coreLogMessages()).join(' ')).toContain('Lockout prevention prevents closing the cover further.')
			}
		)
	})

	test('preserves a manual movement until automatic control is re-enabled', async () => {
		await withCoverScenario(
			COVER_SCENARIOS.manual,
			async ({ client, setAutomaticControl, setSun, moveCover, expectHelperToBecome, expectCoverToBecome, expectNoCoverUpdates, coreLogMessages }) => {
				await setAutomaticControl(true)
				await expectHelperToBecome({ angle: 40, modes: [], position: 70 })

				// If the user moves the cover manually, expect a normal trigger to preserve the manual position
				await moveCover({ position: 30 })
				await expectCoverToBecome({ position: 30 })
				await settle()
				await client.clearEvents()
				await setSun({ azimuth: 180, elevation: 30 })

				await expectNoCoverUpdates()
				expect((await coreLogMessages()).join(' ')).toContain('but the user manually moved the cover to 30%')

				// If automatic control is explicitly re-enabled, expect the managed position to be restored
				await client.clearEvents()
				await setAutomaticControl(false)
				await setAutomaticControl(true)
				await expectCoverToBecome({ position: 70 })
			}
		)
	})

	test('honors tolerances and suppresses tilt for a fully open cover', async () => {
		// If changes are within tolerance or tilt is irrelevant while fully open,
		// expect the helper to update without moving the cover
		const cases = [
			{ expected: { angle: 52, modes: [], position: 52 }, scenario: COVER_SCENARIOS.tolerance },
			{ expected: { angle: 40, modes: [], position: 100 }, scenario: COVER_SCENARIOS.fullyOpen },
		] as const

		for (const { expected, scenario } of cases) {
			await withCoverScenario(scenario, async ({ setAutomaticControl, expectHelperToBecome, expectNoCoverUpdates }) => {
				await setAutomaticControl(true)
				await expectHelperToBecome(expected)
				await expectNoCoverUpdates()
			})
		}
	})

	test('uses only the movement services supported by a cover', async () => {
		await withCoverScenario(COVER_SCENARIOS.positionOnly, async ({ setAutomaticControl, expectHelperToBecome, expectCoverToBecome, coverCalls }) => {
			// If a cover supports only position, expect no tilt service call
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 35, modes: [], position: 70 })
			await expectCoverToBecome({ position: 70 })
			expect(await coverCalls()).toEqual([{ service: 'set_cover_position', value: 70 }])
		})

		await withCoverScenario(COVER_SCENARIOS.tiltOnly, async ({ setAutomaticControl, expectHelperToBecome, expectCoverToBecome, coverCalls }) => {
			// If a cover supports only tilt, expect no position service call
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 35, modes: [], position: 100 })
			await expectCoverToBecome({ angle: 35 })
			expect(await coverCalls()).toEqual([{ service: 'set_cover_tilt_position', value: 35 }])
		})
	})

	test('homes intermediate tilt targets and skips homing exclusions', async () => {
		// If homing applies, expect angle 0 before the target
		// Otherwise expect only the applicable target
		const expectations = [
			{ calls: [0, 40], scenario: COVER_SCENARIOS.homing },
			{ calls: [40], scenario: COVER_SCENARIOS.homingDisabled },
			{ calls: [0], scenario: COVER_SCENARIOS.homingExtreme },
		] as const

		for (const { calls, scenario } of expectations) {
			await withCoverScenario(scenario, async ({ setAutomaticControl, expectHelperToBecome, expectCoverToBecome, coverCalls }) => {
				const targetAngle = calls.at(-1)!
				await setAutomaticControl(true)
				await expectHelperToBecome({ angle: targetAngle, modes: [], position: 50 })
				await expectCoverToBecome({ angle: targetAngle }, { withinMs: 6000 })
				expect((await coverCalls()).map((call) => call.value)).toEqual(calls)
			})
		}
	})

	test('blocks unavailable configured entities but accepts omitted optional modes', async () => {
		await withCoverScenario(COVER_SCENARIOS.availability, async ({ scenario, client, setAutomaticControl, expectNoHelperChanges, expectNoCoverUpdates }) => {
			// If a configured optional mode entity is unavailable,
			// expect automatic control to abort without state changes
			await client.setState(scenario.controls.privacy, 'unavailable')
			await client.clearEvents()
			await setAutomaticControl(true)
			await Promise.all([expectNoHelperChanges(), expectNoCoverUpdates()])
		})

		await withCoverScenario(COVER_SCENARIOS.requiredAvailability, async ({ scenario, client, setAutomaticControl, expectNoHelperChanges, expectNoCoverUpdates }) => {
			// If the required cover entity is unknown,
			// expect automatic control to abort without state changes
			await client.setState(scenario.entities.cover, 'unknown')
			await client.clearEvents()
			await setAutomaticControl(true)
			await Promise.all([expectNoHelperChanges(), expectNoCoverUpdates()])
		})

		await withCoverScenario(COVER_SCENARIOS.minimal, async ({ setAutomaticControl, expectHelperToBecome }) => {
			// If optional mode entities are omitted,
			// expect automatic control to apply the default state normally
			await setAutomaticControl(true)
			await expectHelperToBecome({ angle: 35, modes: [], position: 65 })
		})
	})
})
