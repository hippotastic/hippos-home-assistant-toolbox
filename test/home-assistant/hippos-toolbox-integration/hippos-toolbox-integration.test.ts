import { describe, expect, inject, test } from 'vitest'
import { commandOutput, runInHomeAssistant } from '../harness/container-command.ts'
import { requestHomeAssistant } from '../harness/client.ts'

type AdoptionState = {
	automation_states: string[]
	legacy_in_use: number
	managed_in_use: number
	references: Array<string | null>
}

type AdoptionResult = {
	after: AdoptionState
	automations_use_legacy_path: boolean
	automations_use_managed_path: boolean
	before: AdoptionState
	legacy_file_exists: boolean
	managed_file_exists: boolean
	restored: boolean
}

describe("Hippo's Home Assistant Toolbox integration", () => {
	test('passes its Python regression tests inside Home Assistant', () => {
		const result = runInHomeAssistant(['python3', '-m', 'unittest', 'discover', '-s', '/repo/test/home-assistant/hippos-toolbox-integration/python', '-p', 'test_*.py'])

		expect(result.status, commandOutput(result)).toBe(0)
	})

	test('migrates existing automations from hippo to the managed blueprint path', () => {
		const result = requestHomeAssistant<AdoptionResult>(inject('haBlueprintContainerName'), 'blueprint_adoption_result', {}, 'GET')

		expect(result.before.references).toEqual(['hippo/cover_automation.yaml', 'hippo/cover_automation.yaml'])
		expect(result.before.legacy_in_use).toBe(2)
		expect(result.after.references).toEqual(['hippotastic/cover_automation.yaml', 'hippotastic/cover_automation.yaml'])
		expect(result.after.legacy_in_use).toBe(0)
		expect(result.after.managed_in_use).toBe(result.before.managed_in_use + 2)
		expect(result.after.automation_states).toEqual(result.before.automation_states)
		expect(result.automations_use_legacy_path).toBe(false)
		expect(result.automations_use_managed_path).toBe(true)
		expect(result.legacy_file_exists).toBe(false)
		expect(result.managed_file_exists).toBe(true)
		expect(result.restored).toBe(true)
	})
})
