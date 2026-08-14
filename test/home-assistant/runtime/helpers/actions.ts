import type { BlueprintRuntimeClient, ServiceCallMatch } from '../../harness/client.ts'
import type { StateHoldOptions } from './state-expectations.ts'
import { settle } from './timing.ts'

/** Waits for the previous scenario action to finish and starts a fresh local event window */
export async function prepareNextAction(client: BlueprintRuntimeClient, automationEntityIds: string[]): Promise<void> {
	await client.waitForActionToSettle(automationEntityIds)
	await client.startEventWindow()
}

/** Waits for the scenario action to finish and rejects matching service calls in its event window */
export async function expectNoServiceCallsAfterAction(
	client: BlueprintRuntimeClient,
	automationEntityIds: string[],
	match: ServiceCallMatch,
	options: StateHoldOptions = {}
): Promise<void> {
	if (options.forMs === undefined) {
		await client.waitForActionToSettle(automationEntityIds)
	} else {
		await settle(options.forMs)
	}
	const calls = await client.serviceCalls(match)
	if (calls.length > 0) {
		throw new Error(`Unexpected service call: ${JSON.stringify(calls[0])}`)
	}
}
