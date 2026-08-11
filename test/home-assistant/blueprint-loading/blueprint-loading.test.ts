import { describe, expect, test } from 'vitest'
import { commandOutput, runInHomeAssistant } from '../harness/container-command.ts'

describe('Home Assistant blueprint configuration', () => {
	test('loads every published blueprint without warnings', () => {
		const result = runInHomeAssistant(['hass', '--script', 'check_config', '-c', '/config/validator', '--fail-on-warnings'])

		expect(result.status, commandOutput(result)).toBe(0)
	})
})
