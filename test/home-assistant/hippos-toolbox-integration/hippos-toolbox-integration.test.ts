import { describe, expect, inject, test } from 'vitest'
import { commandOutput, runInHomeAssistant } from '../harness/container-command.ts'
import { requestHomeAssistant } from '../harness/client.ts'

type BlueprintSyncResult = {
	configuration_unchanged: boolean
	file_updated: boolean
	reference_before: string
	reference_after: string
	state_before: string
	state_after: string
}

describe("Hippo's Home Assistant Toolbox integration", () => {
	test('passes its Python regression tests inside Home Assistant', () => {
		const result = runInHomeAssistant(['python3', '-m', 'unittest', 'discover', '-s', '/repo/test/home-assistant/hippos-toolbox-integration/python', '-p', 'test_*.py'])

		expect(result.status, commandOutput(result)).toBe(0)
	})

	test('replaces the managed blueprint in place while keeping its automation enabled', () => {
		const result = requestHomeAssistant<BlueprintSyncResult>(inject('haBlueprintContainerName'), 'blueprint_sync_result', {}, 'GET')

		expect(result.file_updated).toBe(true)
		expect(result.configuration_unchanged).toBe(true)
		expect(result.reference_before).toBe('hippotastic/cover_automation.yaml')
		expect(result.reference_after).toBe(result.reference_before)
		expect(result.state_before).toBe('on')
		expect(result.state_after).toBe(result.state_before)
	})
})
