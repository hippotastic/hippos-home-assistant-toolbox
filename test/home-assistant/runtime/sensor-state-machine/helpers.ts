import type { BlueprintRuntimeClient } from '../../harness/client.ts'
import { setBoolean } from '../helpers/entities.ts'
import { settle } from '../helpers/timing.ts'
import type { SensorScenario } from './scenarios.ts'

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

export async function waitForOutputState(client: BlueprintRuntimeClient, scenario: SensorScenario, state: 'off' | 'on', options?: { timeoutMs?: number }): Promise<void> {
	await client.waitForState(scenario.entities.output, { state }, options)
}

export function scenarioEntityIds(scenario: SensorScenario): string[] {
	return [
		scenario.entities.automation,
		scenario.entities.marker,
		scenario.entities.output,
		...scenario.inputs,
		...(scenario.conditionOn ? [scenario.conditionOn] : []),
		...(scenario.conditionOff ? [scenario.conditionOff] : []),
	]
}
