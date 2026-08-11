import type { BlueprintRuntimeClient, BlueprintServiceCall, ServiceCallMatch } from '../../harness/client.ts'

export function callsForEntity(calls: BlueprintServiceCall[], entityId: string): BlueprintServiceCall[] {
	return calls.filter((call) => serviceCallTargets(call, entityId))
}

export async function expectNoCalls(client: BlueprintRuntimeClient, matches: ServiceCallMatch[], timeoutMs = 350): Promise<void> {
	await Promise.all(matches.map((match) => client.expectNoServiceCall(match, { timeoutMs })))
}

export function normalizeServiceNames(calls: BlueprintServiceCall[]): string[] {
	return calls.map((call) => `${call.domain}.${call.service}`)
}

function serviceCallTargets(call: BlueprintServiceCall, entityId: string): boolean {
	const value = call.target.entity_id ?? call.serviceData.entity_id
	return value === entityId || (Array.isArray(value) && value.includes(entityId))
}
