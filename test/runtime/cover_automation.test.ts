import { describe, expect, test } from 'vitest'
import { withScenarioDiagnostics } from '../api.ts'
import { COVER_SCENARIOS } from '../scenarios.ts'
import { coverCalls, expectNoCalls, initializeCoverScenario, scenarioEntityIds, setBoolean, settle, waitForCoreLogMessages, waitForManagedState } from './helpers.ts'

describe("Hippo's Cover Automation", () => {
	test('applies defaults and a valid external angle override when control is enabled', async () => {
		const scenario = COVER_SCENARIOS.default
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeCoverScenario(client, scenario)
			await client.callService('input_number', 'set_value', {
				entity_id: scenario.commonInputs.default_angle_entity,
				value: 61,
			})
			await expectNoCalls(client, [
				{ domain: 'cover', entityId: scenario.entities.cover },
				{ domain: 'input_text', entityId: scenario.entities.helper, service: 'set_value' },
			])
			await client.callService('input_number', 'set_value', {
				entity_id: scenario.commonInputs.default_angle_entity,
				value: 62,
			})
			await settle()
			await client.clearEvents()
			await setBoolean(client, scenario.controls.automatic, true)

			expect(await waitForManagedState(client, scenario)).toEqual({
				angle: 62,
				modes: [],
				position: 80,
			})
			await client.waitForState(scenario.entities.cover, {
				attributes: { current_position: 80, current_tilt_position: 62 },
			})
			expect(await coverCalls(client, scenario.entities.cover)).toEqual([
				{ service: 'set_cover_position', value: 80 },
				{ service: 'set_cover_tilt_position', value: 62 },
			])
			expect(await waitForCoreLogMessages(client, scenario.entities.cover)).toContain('Moving to position 80%. Changing angle to 62%.')
		})
	})

	test('falls back to the configured angle for invalid external values', async () => {
		for (const scenario of [COVER_SCENARIOS.invalidAngle, COVER_SCENARIOS.invalidHighAngle]) {
			await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
				await initializeCoverScenario(client, scenario)
				if (scenario === COVER_SCENARIOS.invalidHighAngle) {
					await client.setState(scenario.commonInputs.default_angle_entity as string, '101')
					await client.setState(scenario.entities.cover, 'open', {
						attributes: { current_position: 65, current_tilt_position: 101 },
					})
					await settle()
					await client.clearEvents()
				}
				await setBoolean(client, scenario.controls.automatic, true)

				expect(await waitForManagedState(client, scenario)).toEqual({
					angle: 35,
					modes: [],
					position: 65,
				})
				await client.waitForState(scenario.entities.cover, {
					attributes: { current_tilt_position: 35 },
				})
			})
		}
	})

	test('handles sun protection across north and leaves it below the elevation limit', async () => {
		const scenario = COVER_SCENARIOS.sun
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeCoverScenario(client, scenario)
			await setBoolean(client, scenario.controls.sun, true)
			await client.setState(scenario.controls.sunEntity, 'above_horizon', {
				attributes: { azimuth: 350, elevation: 30 },
			})
			await settle()
			await client.clearEvents()
			await setBoolean(client, scenario.controls.automatic, true)

			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 30, modes: ['sun'], position: 70 })

			await client.clearEvents()
			await client.setState(scenario.controls.sunEntity, 'above_horizon', {
				attributes: { azimuth: 350, elevation: 10 },
			})
			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 45, modes: [], position: 80 })

			await client.clearEvents()
			await client.setState(scenario.controls.sunEntity, 'above_horizon', {
				attributes: { azimuth: 180, elevation: 30 },
			})
			await expectNoCalls(client, [{ domain: 'input_text', entityId: scenario.entities.helper, service: 'set_value' }])
		})

		const normal = COVER_SCENARIOS.sunNormal
		await withScenarioDiagnostics(scenarioEntityIds(normal), async (client) => {
			await initializeCoverScenario(client, normal)
			await setBoolean(client, normal.controls.sun, true)
			await client.setState(normal.controls.sunEntity, 'above_horizon', {
				attributes: { azimuth: 180, elevation: 30 },
			})
			await settle()
			await client.clearEvents()
			await setBoolean(client, normal.controls.automatic, true)
			expect(await waitForManagedState(client, normal)).toEqual({ angle: 30, modes: ['sun'], position: 70 })
		})
	})

	test('applies privacy, night, and lockout priorities in order', async () => {
		const scenario = COVER_SCENARIOS.modes
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeCoverScenario(client, scenario)
			await setBoolean(client, scenario.controls.automatic, true)
			await waitForManagedState(client, scenario)

			await client.clearEvents()
			await setBoolean(client, scenario.controls.privacy, true)
			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 25, modes: ['privacy'], position: 40 })

			await client.clearEvents()
			await setBoolean(client, scenario.controls.night, true)
			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 15, modes: ['privacy', 'night'], position: 10 })

			await client.clearEvents()
			await setBoolean(client, scenario.controls.lockout, true)
			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 100, modes: ['privacy', 'night', 'lockout'], position: 90 })
			expect(await waitForCoreLogMessages(client, scenario.entities.cover)).toContain(
				'Lockout prevention turned on, and cover must be opened. Moving to position 90%. Changing angle to 100%.'
			)
		})
	})

	test('opens for lockout and then prevents closing an already more-open cover', async () => {
		const scenario = COVER_SCENARIOS.lockout
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeCoverScenario(client, scenario)
			await setBoolean(client, scenario.controls.automatic, true)
			await waitForManagedState(client, scenario)
			await client.clearEvents()
			await setBoolean(client, scenario.controls.lockout, true)

			expect(await waitForManagedState(client, scenario)).toEqual({ angle: 70, modes: ['lockout'], position: 80 })
			await client.waitForState(scenario.entities.cover, {
				attributes: { current_position: 80, current_tilt_position: 70 },
			})

			await client.clearEvents()
			await client.callService('cover', 'set_cover_position', {
				entity_id: scenario.entities.cover,
				position: 95,
			})
			await client.clearEvents()
			await setBoolean(client, scenario.controls.privacy, true)

			const logMessages = await waitForCoreLogMessages(client, scenario.entities.cover)
			expect(await coverCalls(client, scenario.entities.cover)).toEqual([])
			expect(logMessages.join(' ')).toContain('Lockout prevention prevents closing the cover further.')
		})
	})

	test('preserves a manual movement until automatic control is re-enabled', async () => {
		const scenario = COVER_SCENARIOS.manual
		await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
			await initializeCoverScenario(client, scenario)
			await setBoolean(client, scenario.controls.automatic, true)
			await waitForManagedState(client, scenario)

			await client.callService('cover', 'set_cover_position', {
				entity_id: scenario.entities.cover,
				position: 30,
			})
			await client.clearEvents()
			await client.setState(scenario.controls.sunEntity, 'above_horizon', {
				attributes: { azimuth: 180, elevation: 30 },
			})

			const logMessages = await waitForCoreLogMessages(client, scenario.entities.cover)
			expect(await coverCalls(client, scenario.entities.cover)).toEqual([])
			expect(logMessages.join(' ')).toContain('but the user manually moved the cover to 30%')

			await client.clearEvents()
			await setBoolean(client, scenario.controls.automatic, false)
			await setBoolean(client, scenario.controls.automatic, true)
			await client.waitForState(scenario.entities.cover, { attributes: { current_position: 70 } })
		})
	})

	test('honors tolerances and suppresses tilt for a fully open cover', async () => {
		for (const scenario of [COVER_SCENARIOS.tolerance, COVER_SCENARIOS.fullyOpen]) {
			await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
				await initializeCoverScenario(client, scenario)
				await setBoolean(client, scenario.controls.automatic, true)
				await waitForManagedState(client, scenario)
				expect(await coverCalls(client, scenario.entities.cover)).toEqual([])
			})
		}
	})

	test('uses only the movement services supported by a cover', async () => {
		const positionOnly = COVER_SCENARIOS.positionOnly
		await withScenarioDiagnostics(scenarioEntityIds(positionOnly), async (client) => {
			await initializeCoverScenario(client, positionOnly)
			await setBoolean(client, positionOnly.controls.automatic, true)
			expect(await waitForManagedState(client, positionOnly)).toEqual({ angle: 35, modes: [], position: 70 })
			expect(await coverCalls(client, positionOnly.entities.cover)).toEqual([{ service: 'set_cover_position', value: 70 }])
		})

		const tiltOnly = COVER_SCENARIOS.tiltOnly
		await withScenarioDiagnostics(scenarioEntityIds(tiltOnly), async (client) => {
			await initializeCoverScenario(client, tiltOnly)
			await setBoolean(client, tiltOnly.controls.automatic, true)
			expect(await waitForManagedState(client, tiltOnly)).toEqual({ angle: 35, modes: [], position: 100 })
			await client.waitForState(tiltOnly.entities.cover, { attributes: { current_tilt_position: 35 } })
			expect(await coverCalls(client, tiltOnly.entities.cover)).toEqual([{ service: 'set_cover_tilt_position', value: 35 }])
		})
	})

	test('homes intermediate tilt targets and skips homing exclusions', async () => {
		const expectations = [
			{ calls: [0, 40], scenario: COVER_SCENARIOS.homing },
			{ calls: [40], scenario: COVER_SCENARIOS.homingDisabled },
			{ calls: [0], scenario: COVER_SCENARIOS.homingExtreme },
		] as const

		for (const { calls, scenario } of expectations) {
			await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
				await initializeCoverScenario(client, scenario)
				await setBoolean(client, scenario.controls.automatic, true)
				await waitForManagedState(client, scenario)
				await client.waitForState(scenario.entities.cover, { attributes: { current_tilt_position: calls.at(-1) } }, { timeoutMs: 6_000 })
				expect((await coverCalls(client, scenario.entities.cover)).map((call) => call.value)).toEqual(calls)
			})
		}
	})

	test('blocks unavailable configured entities but accepts omitted optional modes', async () => {
		const unavailable = COVER_SCENARIOS.availability
		await withScenarioDiagnostics(scenarioEntityIds(unavailable), async (client) => {
			await initializeCoverScenario(client, unavailable)
			await client.setState(unavailable.controls.privacy, 'unavailable')
			await client.clearEvents()
			await setBoolean(client, unavailable.controls.automatic, true)
			await expectNoCalls(client, [
				{ domain: 'cover', entityId: unavailable.entities.cover },
				{ domain: 'input_text', entityId: unavailable.entities.helper },
			])
		})

		const required = COVER_SCENARIOS.requiredAvailability
		await withScenarioDiagnostics(scenarioEntityIds(required), async (client) => {
			await initializeCoverScenario(client, required)
			await client.setState(required.entities.cover, 'unknown')
			await client.clearEvents()
			await setBoolean(client, required.controls.automatic, true)
			await expectNoCalls(client, [
				{ domain: 'cover', entityId: required.entities.cover },
				{ domain: 'input_text', entityId: required.entities.helper },
			])
		})

		const minimal = COVER_SCENARIOS.minimal
		await withScenarioDiagnostics(scenarioEntityIds(minimal), async (client) => {
			await initializeCoverScenario(client, minimal)
			await setBoolean(client, minimal.controls.automatic, true)
			expect(await waitForManagedState(client, minimal)).toEqual({ angle: 35, modes: [], position: 65 })
		})
	})
})
