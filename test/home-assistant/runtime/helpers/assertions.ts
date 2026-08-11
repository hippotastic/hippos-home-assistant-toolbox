import type { BlueprintServiceCall } from '../../harness/client.ts'

export function callsForEntity(calls: BlueprintServiceCall[], entityId: string): BlueprintServiceCall[] {
	return calls.filter((call) => serviceCallTargets(call, entityId))
}

export function normalizeServiceNames(calls: BlueprintServiceCall[]): string[] {
	return calls.map((call) => `${call.domain}.${call.service}`)
}

function serviceCallTargets(call: BlueprintServiceCall, entityId: string): boolean {
	const value = call.target.entity_id ?? call.serviceData.entity_id
	return value === entityId || (Array.isArray(value) && value.includes(entityId))
}
