import type { BlueprintRuntimeClient } from '../../harness/client.ts'
import { setBoolean } from '../helpers/entities.ts'
import { settle } from '../helpers/timing.ts'
import type { CoverScenario } from './scenarios.ts'

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
	const calls = await client.serviceCalls({ domain: 'logbook', entityId, service: 'log' })
	return calls
		.map((call) => call.serviceData.message)
		.filter((message): message is string => typeof message === 'string')
		.map((message) => message.replaceAll(/\s+/g, ' ').trim())
}

export function scenarioEntityIds(scenario: CoverScenario): string[] {
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
