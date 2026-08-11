import { describe, expect, test } from 'vitest'
import { commandOutput, runInHomeAssistant } from '../harness/container-command.ts'

describe("Hippo's Home Assistant Toolbox integration", () => {
	test('passes its Python regression tests inside Home Assistant', () => {
		const result = runInHomeAssistant(['python3', '-m', 'unittest', 'discover', '-s', '/repo/test/home-assistant/hippos-toolbox-integration/python', '-p', 'test_*.py'])

		expect(result.status, commandOutput(result)).toBe(0)
	})
})
