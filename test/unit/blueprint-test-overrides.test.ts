import { describe, expect, test } from 'vitest'
import { applyBlueprintTestValueOverrides } from '../home-assistant/harness/blueprint-test-overrides.ts'

describe('applyBlueprintTestValueOverrides', () => {
	test('replaces only annotated scalar source ranges', () => {
		const source = ['trigger_variables:', '  settle_seconds: 5 # @blueprint-test-value 0.1', '  ordinary_value: 10', 'input: !input example', ''].join('\n')

		expect(applyBlueprintTestValueOverrides(source)).toBe(
			['trigger_variables:', '  settle_seconds: 0.1 # @blueprint-test-value 0.1', '  ordinary_value: 10', 'input: !input example', ''].join('\n')
		)
	})

	test('returns unmarked source byte for byte', () => {
		const source = 'value: 5\r\ntext: >-\r\n  keep formatting\r\n'
		expect(applyBlueprintTestValueOverrides(source)).toBe(source)
	})

	test('rejects directives without a replacement value', () => {
		expect(() => applyBlueprintTestValueOverrides('value: 5 # @blueprint-test-value\n')).toThrow('invalid @blueprint-test-value directive')
	})

	test('rejects collection replacements', () => {
		expect(() => applyBlueprintTestValueOverrides('value: 5 # @blueprint-test-value [0.1]\n')).toThrow('must contain one YAML scalar')
	})

	test('rejects directives that do not annotate a scalar', () => {
		expect(() => applyBlueprintTestValueOverrides('mapping: # @blueprint-test-value 0.1\n  value: 5\n')).toThrow('must annotate a YAML scalar')
	})
})
