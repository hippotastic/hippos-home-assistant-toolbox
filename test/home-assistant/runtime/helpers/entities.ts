import type { BlueprintRuntimeClient } from '../../harness/client.ts'

export async function setBoolean(client: BlueprintRuntimeClient, entityId: string, value: boolean): Promise<void> {
	await client.callService('input_boolean', value ? 'turn_on' : 'turn_off', {
		entity_id: entityId,
	})
}
