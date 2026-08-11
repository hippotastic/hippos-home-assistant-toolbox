import { withScenarioDiagnostics, type BlueprintRuntimeClient } from '../../harness/client.ts'
import { callsForEntity, normalizeServiceNames } from '../helpers/assertions.ts'
import { setBoolean as setBooleanEntity } from '../helpers/entities.ts'
import { createEntityStateExpectation, type StateHoldOptions, type StateTransitionOptions } from '../helpers/state-expectations.ts'
import { settle } from '../helpers/timing.ts'
import type { SensorScenario } from './scenarios.ts'

type SensorScenarioFixture<TScenario extends SensorScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	/** Returns the ordered custom-action service names recorded for the marker and output entities */
	customActionServiceNames: () => Promise<string[]>
	/** Waits for the output to reach the expected state within the optional transition timeout */
	expectOutputToBecome: (state: 'off' | 'on', options?: StateTransitionOptions) => Promise<void>
	/** Rejects visible output state changes during the observation period */
	expectNoOutputChanges: (options: StateHoldOptions) => Promise<void>
	/** Rejects output state changes and output service calls during the observation period */
	expectNoOutputUpdates: (options?: StateHoldOptions) => Promise<void>
	/** Sets an input or condition entity through its real `input_boolean` service */
	setBoolean: (entityId: string, value: boolean) => Promise<void>
}

/** Initializes a sensor scenario and runs it with diagnostics and bound test operations */
export async function withSensorScenario<TScenario extends SensorScenario, TResult>(
	scenario: TScenario,
	run: (fixture: SensorScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
		const outputState = createEntityStateExpectation(client, scenario.entities.output, (state) => state.state, {
			updates: [{ domain: scenario.outputDomain, entityId: scenario.entities.output }],
		})
		await initializeSensorScenario(client, scenario, async () => {
			await outputState.expectToBecome('off')
		})

		return run({
			scenario,
			client,
			customActionServiceNames: () => readCustomActionServiceNames(client, scenario),
			expectNoOutputChanges: (options) => outputState.expectNoChanges(options),
			expectNoOutputUpdates: (options = { forMs: 350 }) => outputState.expectNoUpdates(options),
			expectOutputToBecome: async (state, options) => {
				await outputState.expectToBecome(state, options)
			},
			setBoolean: (entityId, value) => setBooleanEntity(client, entityId, value),
		})
	})
}

async function readCustomActionServiceNames(client: BlueprintRuntimeClient, scenario: SensorScenario): Promise<string[]> {
	const relevantEntityIds = [scenario.entities.marker, scenario.entities.output]
	const relevantCalls = (await client.serviceCalls()).filter((call) => relevantEntityIds.some((entityId) => callsForEntity([call], entityId).length > 0))

	return normalizeServiceNames(relevantCalls)
}

async function initializeSensorScenario(client: BlueprintRuntimeClient, scenario: SensorScenario, expectOutputOff: () => Promise<void>): Promise<void> {
	for (const entityId of scenario.inputs) {
		await setBooleanEntity(client, entityId, false)
	}
	if (scenario.conditionOn) {
		await setBooleanEntity(client, scenario.conditionOn, false)
	}
	if (scenario.conditionOff) {
		await setBooleanEntity(client, scenario.conditionOff, false)
	}

	await client.callService(scenario.outputDomain, 'turn_off', {
		entity_id: scenario.entities.output,
	})
	if (scenario.withCustomActions) {
		await client.callService('switch', 'turn_off', { entity_id: scenario.entities.marker })
	}
	await expectOutputOff()

	await settle()
	await client.clearEvents()
}

function scenarioEntityIds(scenario: SensorScenario): string[] {
	return [
		scenario.entities.automation,
		scenario.entities.marker,
		scenario.entities.output,
		...scenario.inputs,
		...(scenario.conditionOn ? [scenario.conditionOn] : []),
		...(scenario.conditionOff ? [scenario.conditionOff] : []),
	]
}
