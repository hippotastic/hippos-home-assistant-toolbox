import type { BlueprintRuntimeClient } from '../../harness/client.ts'
import { settle } from '../helpers/timing.ts'
import { IRRIGATION_VARIANTS, type IrrigationCalculationScenario, type IrrigationSchedulerScenario, type IrrigationVariant } from './scenarios.ts'

export type ZoneStatus = Record<string, unknown> & {
	interval?: number
	last_end?: string
	next_end?: string
	next_start?: string
	runtime?: number
	valve?: string
}

export async function initializeCalculationScenario(
	client: BlueprintRuntimeClient,
	scenario: IrrigationCalculationScenario,
	options: { helperValue?: string; rainfall?: string; temperature?: string } = {}
): Promise<void> {
	await client.setState(scenario.sensors.rainfall, options.rainfall ?? '0')
	await client.setState(scenario.sensors.temperature, options.temperature ?? '20')

	for (const variant of IRRIGATION_VARIANTS) {
		const entities = scenario.variants[variant]
		await setAutomation(client, entities.automation, false)
		await setSwitch(client, entities.valve, false)
		await setHelper(client, entities.helper, options.helperValue ?? '{}')
	}

	await settle()
	await client.clearEvents()
}

export async function initializeSchedulerScenario(
	client: BlueprintRuntimeClient,
	scenario: IrrigationSchedulerScenario,
	statusFor: (variant: IrrigationVariant, zoneIndex: number) => string
): Promise<void> {
	for (const variant of IRRIGATION_VARIANTS) {
		const entities = scenario.variants[variant]
		await setAutomation(client, entities.automation, false)
		await setSwitch(client, entities.pump, false)
		for (const [zoneIndex, valve] of entities.valves.entries()) {
			await setSwitch(client, valve, false)
			await setHelper(client, entities.helpers[zoneIndex], statusFor(variant, zoneIndex))
		}
	}

	await settle()
	await client.clearEvents()
}

export async function setAutomation(client: BlueprintRuntimeClient, entityId: string, enabled: boolean): Promise<void> {
	await client.callService('automation', enabled ? 'turn_on' : 'turn_off', { entity_id: entityId })
}

export async function setHelper(client: BlueprintRuntimeClient, entityId: string, value: string | ZoneStatus): Promise<void> {
	await client.callService('input_text', 'set_value', {
		entity_id: entityId,
		value: typeof value === 'string' ? value : JSON.stringify(value),
	})
}

export async function setSwitch(client: BlueprintRuntimeClient, entityId: string, enabled: boolean): Promise<void> {
	await client.callService('switch', enabled ? 'turn_on' : 'turn_off', { entity_id: entityId })
}

export async function waitForZoneStatus(
	client: BlueprintRuntimeClient,
	entityId: string,
	predicate: (status: ZoneStatus) => boolean,
	options: { timeoutMs?: number } = {}
): Promise<ZoneStatus> {
	const deadline = Date.now() + (options.timeoutMs ?? 5_000)

	while (Date.now() < deadline) {
		const state = await client.getState(entityId)
		if (state) {
			const status = parseZoneStatus(state.state)
			if (status && predicate(status)) {
				return status
			}
		}
		await settle(25)
	}

	const state = await client.getState(entityId)
	throw new Error(`Timed out waiting for zone status ${entityId}; current=${state?.state ?? 'missing'}`)
}

export function calculationScenarioEntityIds(scenario: IrrigationCalculationScenario): string[] {
	return [scenario.sensors.rainfall, scenario.sensors.temperature, ...IRRIGATION_VARIANTS.flatMap((variant) => Object.values(scenario.variants[variant]))]
}

export function schedulerScenarioEntityIds(scenario: IrrigationSchedulerScenario): string[] {
	return IRRIGATION_VARIANTS.flatMap((variant) => {
		const entities = scenario.variants[variant]
		return [entities.automation, entities.pump, ...entities.helpers, ...entities.valves]
	})
}

function parseZoneStatus(value: string): ZoneStatus | null {
	try {
		const parsed: unknown = JSON.parse(value)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ZoneStatus) : null
	} catch {
		return null
	}
}
