import { isDeepStrictEqual } from 'node:util'
import { withScenarioDiagnostics, type BlueprintRuntimeClient } from '../../harness/client.ts'
import { setBoolean } from '../helpers/entities.ts'
import { createEntityStateExpectation, DEFAULT_STATE_TRANSITION_TIMEOUT_MS, type StateTransitionOptions } from '../helpers/state-expectations.ts'
import { settle } from '../helpers/timing.ts'
import type { CoverScenario } from './scenarios.ts'

type ManagedCoverState = {
	angle: number
	modes: readonly string[]
	position: number
}

type ActualCoverState = {
	angle?: number
	position?: number
}

type CoverMode = 'lockout' | 'night' | 'privacy' | 'sun'

type CoverStateHoldOptions = {
	forMs?: number
}

type NormalizedCoverCall = {
	service: string
	value: number
}

type CoverScenarioFixture<TScenario extends CoverScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	/** Waits for and returns normalized user-facing logbook messages for the cover */
	coreLogMessages: () => Promise<string[]>
	/** Returns recorded position and tilt service calls for the cover in firing order */
	coverCalls: () => Promise<NormalizedCoverCall[]>
	/** Waits for the physical cover to reach every position or angle supplied in `expected` */
	expectCoverToBecome: (expected: ActualCoverState, options?: StateTransitionOptions) => Promise<void>
	/** Rejects physical cover state changes and cover service calls during the observation period */
	expectNoCoverUpdates: (options?: CoverStateHoldOptions) => Promise<void>
	/** Waits for both the helper state and its matching `input_text.set_value` write */
	expectHelperToBecome: (expected: ManagedCoverState, options?: StateTransitionOptions) => Promise<void>
	/** Rejects visible helper state changes during the observation period */
	expectNoHelperChanges: (options?: CoverStateHoldOptions) => Promise<void>
	/** Simulates an external or manual cover movement through the real cover services */
	moveCover: (target: ActualCoverState) => Promise<void>
	/** Enables or disables the scenario's automatic-control input */
	setAutomaticControl: (enabled: boolean) => Promise<void>
	/** Sets the scenario's optional external default-angle entity */
	setExternalAngle: (value: number) => Promise<void>
	/** Enables or disables one of the scenario's cover mode inputs */
	setMode: (mode: CoverMode, enabled: boolean) => Promise<void>
	/** Updates the fixture sun entity with the supplied azimuth and elevation */
	setSun: (position: { azimuth: number; elevation: number }) => Promise<void>
}

const DEFAULT_COVER_STATE_HOLD_MS = 350

/** Initializes a cover scenario and runs it with diagnostics and bound test operations */
export async function withCoverScenario<TScenario extends CoverScenario, TResult>(
	scenario: TScenario,
	run: (fixture: CoverScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
		await initializeCoverScenario(client, scenario)

		const helperState = createEntityStateExpectation(client, scenario.entities.helper, (state) => parseManagedState(state.state), {
			matches: isDeepStrictEqual,
			revision: (state) => state.last_updated,
		})
		const coverState = createEntityStateExpectation(client, scenario.entities.cover, projectCoverState, {
			matches: coverStateMatches,
			revision: (state) => state.last_updated,
			updates: [{ domain: 'cover', entityId: scenario.entities.cover }],
		})

		return run({
			scenario,
			client,
			coreLogMessages: () => readCoreLogMessages(client, scenario.entities.cover),
			coverCalls: () => readCoverCalls(client, scenario.entities.cover),
			expectCoverToBecome: async (expected, options) => {
				await coverState.expectToBecome(expected, options)
			},
			expectNoCoverUpdates: async (options = {}) => {
				const forMs = options.forMs ?? DEFAULT_COVER_STATE_HOLD_MS
				await coverState.expectNoUpdates({ forMs })
			},
			expectHelperToBecome: async (expected, options = {}) => {
				const withinMs = options.withinMs ?? DEFAULT_STATE_TRANSITION_TIMEOUT_MS
				const [call] = await Promise.all([
					client.waitForServiceCall({ domain: 'input_text', entityId: scenario.entities.helper, service: 'set_value' }, { timeoutMs: withinMs }),
					helperState.expectToBecome(expected, options),
				])
				const writtenState = parseManagedState(call.serviceData.value)
				if (!isDeepStrictEqual(writtenState, expected)) {
					throw new Error(`Expected ${scenario.entities.helper} to be written as ${JSON.stringify(expected)}; written=${JSON.stringify(writtenState)}`)
				}
			},
			expectNoHelperChanges: async (options = {}) => {
				const forMs = options.forMs ?? DEFAULT_COVER_STATE_HOLD_MS
				await helperState.expectNoChanges({ forMs })
			},
			moveCover: (target) => moveCover(client, scenario.entities.cover, target),
			setAutomaticControl: (enabled) => setBoolean(client, scenario.controls.automatic, enabled),
			setExternalAngle: (value) => setExternalAngle(client, scenario, value),
			setMode: (mode, enabled) => setBoolean(client, scenario.controls[mode], enabled),
			setSun: ({ azimuth, elevation }) =>
				client.setState(scenario.controls.sunEntity, 'above_horizon', {
					attributes: { azimuth, elevation },
				}),
		})
	})
}

async function initializeCoverScenario(client: BlueprintRuntimeClient, scenario: CoverScenario): Promise<void> {
	const managedState: ManagedCoverState = {
		angle: scenario.initialTilt,
		modes: [],
		position: scenario.initialPosition,
	}

	for (const entityId of [scenario.controls.automatic, scenario.controls.lockout, scenario.controls.night, scenario.controls.privacy, scenario.controls.sun]) {
		await setBoolean(client, entityId, false)
	}

	await client.setState(scenario.controls.sunEntity, 'above_horizon', {
		attributes: { azimuth: 180, elevation: 10 },
	})
	if (scenario.externalAngleInitial !== undefined) {
		await setExternalAngle(client, scenario, scenario.externalAngleInitial)
	}

	if (scenario.supportsPosition) {
		await client.callService('cover', 'set_cover_position', {
			entity_id: scenario.entities.cover,
			position: scenario.initialPosition,
		})
	}
	if (scenario.supportsTilt) {
		await client.callService('cover', 'set_cover_tilt_position', {
			entity_id: scenario.entities.cover,
			tilt_position: scenario.initialTilt,
		})
	}
	await client.callService('input_text', 'set_value', {
		entity_id: scenario.entities.helper,
		value: JSON.stringify(managedState),
	})
	await client.waitForState(scenario.entities.cover, {
		attributes: {
			...(scenario.supportsPosition ? { current_position: scenario.initialPosition } : {}),
			...(scenario.supportsTilt ? { current_tilt_position: scenario.initialTilt } : {}),
		},
	})

	await settle()
	await client.clearEvents()
}

async function setExternalAngle(client: BlueprintRuntimeClient, scenario: CoverScenario, value: number): Promise<void> {
	const entityId = scenario.commonInputs.default_angle_entity
	if (typeof entityId !== 'string') {
		throw new Error(`Cover scenario ${scenario.id} has no external angle entity`)
	}
	await client.callService('input_number', 'set_value', { entity_id: entityId, value })
}

async function moveCover(client: BlueprintRuntimeClient, entityId: string, target: ActualCoverState): Promise<void> {
	if (target.position !== undefined) {
		await client.callService('cover', 'set_cover_position', {
			entity_id: entityId,
			position: target.position,
		})
	}
	if (target.angle !== undefined) {
		await client.callService('cover', 'set_cover_tilt_position', {
			entity_id: entityId,
			tilt_position: target.angle,
		})
	}
}

async function readCoverCalls(client: BlueprintRuntimeClient, entityId: string): Promise<NormalizedCoverCall[]> {
	const calls = await client.serviceCalls({ domain: 'cover', entityId })
	return calls.flatMap((call) => {
		if (call.service === 'set_cover_position' && typeof call.serviceData.position === 'number') {
			return [{ service: call.service, value: call.serviceData.position }]
		}
		if (call.service === 'set_cover_tilt_position' && typeof call.serviceData.tilt_position === 'number') {
			return [{ service: call.service, value: call.serviceData.tilt_position }]
		}
		return []
	})
}

async function readCoreLogMessages(client: BlueprintRuntimeClient, entityId: string): Promise<string[]> {
	await client.waitForServiceCall({ domain: 'logbook', entityId, service: 'log' })
	const calls = await client.serviceCalls({ domain: 'logbook', entityId, service: 'log' })
	return calls
		.map((call) => call.serviceData.message)
		.filter((message): message is string => typeof message === 'string')
		.map((message) => message.replaceAll(/\s+/g, ' ').trim())
}

function projectCoverState(state: { attributes: Record<string, unknown> }): ActualCoverState {
	const angle = state.attributes.current_tilt_position
	const position = state.attributes.current_position
	return {
		...(typeof angle === 'number' ? { angle } : {}),
		...(typeof position === 'number' ? { position } : {}),
	}
}

function coverStateMatches(actual: ActualCoverState, expected: ActualCoverState): boolean {
	return (expected.angle === undefined || actual.angle === expected.angle) && (expected.position === undefined || actual.position === expected.position)
}

function scenarioEntityIds(scenario: CoverScenario): string[] {
	return [scenario.entities.automation, scenario.entities.cover, scenario.entities.helper, ...Object.values(scenario.controls)]
}

function parseManagedState(value: unknown): ManagedCoverState {
	if (typeof value === 'string') {
		return JSON.parse(value) as ManagedCoverState
	}
	if (isRecord(value) && Array.isArray(value.modes)) {
		return value as ManagedCoverState
	}
	throw new Error(`Unexpected managed cover state: ${JSON.stringify(value)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
