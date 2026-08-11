import { describe, expect, test } from 'vitest'
import { formatHomeAssistantLogIssues, isKnownReferenceBlueprintWarning, unexpectedHomeAssistantLogIssues } from '../home-assistant/harness/log-validation.ts'

describe('unexpectedHomeAssistantLogIssues', () => {
	test('extracts warning and error entries including continuation lines', () => {
		const output = [
			'2026-08-11 08:00:00.000 INFO (MainThread) [homeassistant.core] Running',
			'\u001b[33m2026-08-11 08:00:01.000 WARNING (MainThread) [homeassistant.helpers.template] Invalid template\u001b[0m',
			'additional context',
			'\u001b[31m2026-08-11 08:00:02.000 ERROR (MainThread) [homeassistant.components.automation] Action failed\u001b[0m',
		].join('\n')

		expect(unexpectedHomeAssistantLogIssues(output)).toEqual([
			{
				level: 'WARNING',
				logger: 'homeassistant.helpers.template',
				message: 'Invalid template\nadditional context',
				timestamp: '2026-08-11 08:00:01.000',
			},
			{
				level: 'ERROR',
				logger: 'homeassistant.components.automation',
				message: 'Action failed',
				timestamp: '2026-08-11 08:00:02.000',
			},
		])
	})

	test('formats issues for a compact test failure', () => {
		const issues = unexpectedHomeAssistantLogIssues('2026-08-11 08:00:01.000 WARNING (MainThread) [homeassistant.helpers.template] Invalid template')

		expect(formatHomeAssistantLogIssues(issues)).toBe('2026-08-11 08:00:01.000 WARNING [homeassistant.helpers.template] Invalid template')
	})

	test('groups repeated issues', () => {
		const warning = '2026-08-11 08:00:01.000 WARNING (MainThread) [homeassistant.helpers.template] Invalid template'
		const issues = unexpectedHomeAssistantLogIssues(`${warning}\n${warning}`)

		expect(formatHomeAssistantLogIssues(issues)).toContain('(repeated 2 times)')
	})

	test('allows only recognizable warnings from frozen reference templates', () => {
		const reference =
			"2026-08-11 08:00:01.000 WARNING (MainThread) [homeassistant.helpers.template] Template variable warning: 'dict object' has no attribute 'next_start' when rendering '{%- if zone.next_start                                             %}'"
		const unsafeReference =
			"2026-08-11 08:00:01.000 WARNING (MainThread) [homeassistant.helpers.template] Template variable warning: 'dict object' has no attribute 'last_end' when rendering '{{ (not repeat.item.last_end) or repeat.item.next_start | as_datetime }}'"
		const current =
			"2026-08-11 08:00:02.000 WARNING (MainThread) [homeassistant.helpers.template] Template variable warning: 'dict object' has no attribute 'next_start' when rendering '{%- if zone.next_start %}'"

		expect(unexpectedHomeAssistantLogIssues(`${reference}\n${unsafeReference}\n${current}`, isKnownReferenceBlueprintWarning)).toHaveLength(1)
	})
})
