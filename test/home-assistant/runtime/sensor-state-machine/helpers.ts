import { withScenarioDiagnostics, type BlueprintRuntimeClient, type ServiceCallMatch } from '../../harness/client.ts'
import { callsForEntity, expectNoCalls as expectNoClientCalls, normalizeServiceNames } from '../helpers/assertions.ts'
import { setBoolean as setBooleanEntity } from '../helpers/entities.ts'
import { settle } from '../helpers/timing.ts'
import type { SensorScenario } from './scenarios.ts'

type OutputStateTransitionOptions = {
	withinMs?: number
}

type OutputStateHoldOptions = {
	forMs: number
}

const DEFAULT_OUTPUT_STATE_TIMEOUT_MS = 500
const OUTPUT_STATE_HOLD_POLL_INTERVAL_MS = 50

type SensorScenarioFixture<TScenario extends SensorScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	customActionServiceNames: () => Promise<string[]>
	expectNoCalls: (matches: ServiceCallMatch[], timeoutMs?: number) => Promise<void>
	expectOutputToBecome: (state: 'off' | 'on', options?: OutputStateTransitionOptions) => Promise<void>
	expectOutputToRemain: (state: 'off' | 'on', options: OutputStateHoldOptions) => Promise<void>
	setBoolean: (entityId: string, value: boolean) => Promise<void>
}

export async function withSensorScenario<TScenario extends SensorScenario, TResult>(
	scenario: TScenario,
	run: (fixture: SensorScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
		await initializeSensorScenario(client, scenario)

		return run({
			scenario,
			client,
			customActionServiceNames: () => readCustomActionServiceNames(client, scenario),
			expectNoCalls: (matches, timeoutMs) => expectNoClientCalls(client, matches, timeoutMs),
			expectOutputToBecome: (state, options) => expectOutputToBecome(client, scenario, state, options),
			expectOutputToRemain: (state, options) => expectOutputToRemain(client, scenario, state, options),
			setBoolean: (entityId, value) => setBooleanEntity(client, entityId, value),
		})
	})
}

async function readCustomActionServiceNames(client: BlueprintRuntimeClient, scenario: SensorScenario): Promise<string[]> {
	const relevantEntityIds = [scenario.entities.marker, scenario.entities.output]
	const relevantCalls = (await client.serviceCalls()).filter((call) => relevantEntityIds.some((entityId) => callsForEntity([call], entityId).length > 0))

	return normalizeServiceNames(relevantCalls)
}

async function initializeSensorScenario(client: BlueprintRuntimeClient, scenario: SensorScenario): Promise<void> {
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
	await expectOutputToBecome(client, scenario, 'off')

	await settle()
	await client.clearEvents()
}

async function expectOutputToBecome(client: BlueprintRuntimeClient, scenario: SensorScenario, state: 'off' | 'on', options: OutputStateTransitionOptions = {}): Promise<void> {
	await client.waitForState(scenario.entities.output, { state }, { timeoutMs: options.withinMs ?? DEFAULT_OUTPUT_STATE_TIMEOUT_MS })
}

async function expectOutputToRemain(client: BlueprintRuntimeClient, scenario: SensorScenario, state: 'off' | 'on', options: OutputStateHoldOptions): Promise<void> {
	const initialState = await client.getState(scenario.entities.output)
	if (initialState?.state !== state) {
		throw new Error(`Expected ${scenario.entities.output} to be ${state} immediately; current=${JSON.stringify(initialState)}`)
	}

	const holdDeadline = Date.now() + options.forMs

	while (Date.now() < holdDeadline) {
		await settle(Math.min(OUTPUT_STATE_HOLD_POLL_INTERVAL_MS, holdDeadline - Date.now()))
		const currentState = await client.getState(scenario.entities.output)
		if (currentState?.state !== state || currentState.last_changed !== initialState.last_changed) {
			throw new Error(`Expected ${scenario.entities.output} to remain ${state} for ${options.forMs} ms; current=${JSON.stringify(currentState)}`)
		}
	}
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
