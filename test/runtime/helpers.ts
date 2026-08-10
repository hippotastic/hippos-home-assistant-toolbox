import type { BlueprintRuntimeClient, BlueprintServiceCall, ServiceCallMatch } from '../api.ts'
import type { CoverScenario, SensorScenario } from '../scenarios.ts'

export type ManagedCoverState = {
	angle: number
	modes: string[]
	position: number
}

export type NormalizedCoverCall = {
	service: string
	value: number
}

export async function initializeCoverScenario(
	client: BlueprintRuntimeClient,
	scenario: CoverScenario,
	managedState: ManagedCoverState = {
		angle: scenario.initialTilt,
		modes: [],
		position: scenario.initialPosition,
	}
): Promise<void> {
	for (const entityId of [scenario.controls.automatic, scenario.controls.lockout, scenario.controls.night, scenario.controls.privacy, scenario.controls.sun]) {
		await setBoolean(client, entityId, false)
	}

	await client.setState(scenario.controls.sunEntity, 'above_horizon', {
		attributes: { azimuth: 180, elevation: 10 },
	})
	if (scenario.externalAngleInitial !== undefined) {
		await client.callService('input_number', 'set_value', {
			entity_id: scenario.commonInputs.default_angle_entity,
			value: scenario.externalAngleInitial,
		})
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

export async function initializeSensorScenario(client: BlueprintRuntimeClient, scenario: SensorScenario): Promise<void> {
	for (const entityId of scenario.inputs) {
		await setBoolean(client, entityId, false)
	}
	if (scenario.conditionOn) {
		await setBoolean(client, scenario.conditionOn, false)
	}
	if (scenario.conditionOff) {
		await setBoolean(client, scenario.conditionOff, false)
	}

	await client.callService(scenario.outputDomain, 'turn_off', {
		entity_id: scenario.entities.output,
	})
	if (scenario.withCustomActions) {
		await client.callService('switch', 'turn_off', { entity_id: scenario.entities.marker })
	}
	await client.waitForState(scenario.entities.output, { state: 'off' })

	await settle()
	await client.clearEvents()
}

export async function setBoolean(client: BlueprintRuntimeClient, entityId: string, value: boolean): Promise<void> {
	await client.callService('input_boolean', value ? 'turn_on' : 'turn_off', {
		entity_id: entityId,
	})
}

export async function waitForOutputState(client: BlueprintRuntimeClient, scenario: SensorScenario, state: 'off' | 'on', options?: { timeoutMs?: number }): Promise<void> {
	await client.waitForState(scenario.entities.output, { state }, options)
}

export async function waitForManagedState(client: BlueprintRuntimeClient, scenario: CoverScenario): Promise<ManagedCoverState> {
	const call = await client.waitForServiceCall({
		domain: 'input_text',
		entityId: scenario.entities.helper,
		service: 'set_value',
	})
	return parseManagedState(call.serviceData.value)
}

export async function coverCalls(client: BlueprintRuntimeClient, entityId: string): Promise<NormalizedCoverCall[]> {
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

export async function waitForCoreLogMessages(client: BlueprintRuntimeClient, entityId: string): Promise<string[]> {
	await client.waitForServiceCall({ domain: 'logbook', entityId, service: 'log' })
	return coreLogMessages(client, entityId)
}

async function coreLogMessages(client: BlueprintRuntimeClient, entityId: string): Promise<string[]> {
	const calls = await client.serviceCalls({ domain: 'logbook', entityId, service: 'log' })
	return calls
		.map((call) => call.serviceData.message)
		.filter((message): message is string => typeof message === 'string')
		.map((message) => message.replaceAll(/\s+/g, ' ').trim())
}

export function scenarioEntityIds(scenario: CoverScenario | SensorScenario): string[] {
	const scenarioEntities =
		'cover' in scenario.entities
			? [scenario.entities.automation, scenario.entities.cover, scenario.entities.helper]
			: [scenario.entities.automation, scenario.entities.marker, scenario.entities.output]
	return 'controls' in scenario
		? [...scenarioEntities, ...Object.values(scenario.controls)]
		: [...scenarioEntities, ...scenario.inputs, ...(scenario.conditionOn ? [scenario.conditionOn] : []), ...(scenario.conditionOff ? [scenario.conditionOff] : [])]
}

export function callsForEntity(calls: BlueprintServiceCall[], entityId: string): BlueprintServiceCall[] {
	return calls.filter((call) => serviceCallTargets(call, entityId))
}

export async function expectNoCalls(client: BlueprintRuntimeClient, matches: ServiceCallMatch[], timeoutMs = 350): Promise<void> {
	await Promise.all(matches.map((match) => client.expectNoServiceCall(match, { timeoutMs })))
}

export function normalizeServiceNames(calls: BlueprintServiceCall[]): string[] {
	return calls.map((call) => `${call.domain}.${call.service}`)
}

export function settle(milliseconds = 100): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
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

function serviceCallTargets(call: BlueprintServiceCall, entityId: string): boolean {
	const value = call.target.entity_id ?? call.serviceData.entity_id
	return value === entityId || (Array.isArray(value) && value.includes(entityId))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
