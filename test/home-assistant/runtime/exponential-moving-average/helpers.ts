import { withScenarioDiagnostics, type BlueprintRuntimeClient } from '../../harness/client.ts'
import { prepareNextAction } from '../helpers/actions.ts'
import { createEntityStateExpectation, type StateHoldOptions, type StateTransitionOptions } from '../helpers/state-expectations.ts'
import type { EmaScenario } from './scenarios.ts'

type EmaScenarioFixture<TScenario extends EmaScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	/** Waits for the stored average to reach the expected numeric value */
	expectAverageToBecome: (value: number, options?: StateTransitionOptions) => Promise<void>
	/** Rejects average state changes and `input_number.set_value` calls from the preceding sample */
	expectNoAverageUpdates: (options?: StateHoldOptions) => Promise<void>
	/** Runs one sampling cycle through the automation while honoring its conditions */
	sample: () => Promise<void>
	/** Enables or disables the EMA automation */
	setAutomationEnabled: (enabled: boolean) => Promise<void>
	/** Sets the stored average through the real `input_number` service */
	setAverage: (value: number) => Promise<void>
	/** Sets the raw state exposed by the input sensor */
	setInput: (value: string) => Promise<void>
}

/** Initializes an EMA scenario and runs it with diagnostics and bound test operations */
export async function withEmaScenario<TScenario extends EmaScenario, TResult>(
	scenario: TScenario,
	run: (fixture: EmaScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(Object.values(scenario.entities), async (client) => {
		const { entities } = scenario
		const averageState = createEntityStateExpectation(client, entities.average, (state) => Number.parseFloat(state.state), {
			automationEntityIds: [entities.automation],
			updates: [{ domain: 'input_number', entityId: entities.average, service: 'set_value' }],
		})

		await setAutomationEnabled(client, entities.automation, scenario.initial.automationEnabled)
		await client.setState(entities.input, scenario.initial.input)
		await setAverage(client, entities.average, scenario.initial.average)
		await prepareNextAction(client, [entities.automation])

		try {
			return await run({
				scenario,
				client,
				expectAverageToBecome: async (value, options) => {
					await averageState.expectToBecome(value, options)
				},
				expectNoAverageUpdates: (options) => averageState.expectNoUpdates(options),
				sample: async () => {
					await prepareNextAction(client, [entities.automation])
					await client.callService('automation', 'trigger', {
						entity_id: entities.automation,
						skip_condition: false,
					})
				},
				setAutomationEnabled: (enabled) => setAutomationEnabled(client, entities.automation, enabled),
				setAverage: (value) => setAverage(client, entities.average, value),
				setInput: (value) => client.setState(entities.input, value),
			})
		} finally {
			await setAutomationEnabled(client, entities.automation, false)
		}
	})
}

async function setAutomationEnabled(client: BlueprintRuntimeClient, entityId: string, enabled: boolean): Promise<void> {
	await client.callService('automation', enabled ? 'turn_on' : 'turn_off', { entity_id: entityId })
}

async function setAverage(client: BlueprintRuntimeClient, entityId: string, value: number): Promise<void> {
	await client.callService('input_number', 'set_value', { entity_id: entityId, value })
}
