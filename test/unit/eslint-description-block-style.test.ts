import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

const BLUEPRINT_FILE = join(process.cwd(), 'blueprints', 'automation', 'description-style-test.yaml')
const RULE_ID = 'hippos/description-block-style'

describe('Blueprint description block style ESLint rule', () => {
	test.each([
		['plain scalar', 'description: Plain prose.\n'],
		['folded block scalar', 'description: >-\n  Prose wrapped across\n  source lines.\n'],
		['single-line literal description', 'description: |\n  One line of prose.\n'],
		['single-line stripped literal description', 'description: |-\n  One line of prose.\n'],
		['unrelated literal scalar', 'message: |-\n  Hard line one.\n  Hard line two.\n'],
	])('accepts %s', async (_description, source) => {
		const [result] = await lint(source)

		expect(ruleMessages(result)).toEqual([])
	})

	test('reports literal description scalars', async () => {
		const [result] = await lint('description: |-\n  Prose wrapped across\n  source lines.\n')

		expect(ruleMessages(result)).toMatchObject([
			{
				line: 1,
				column: 14,
				ruleId: RULE_ID,
				severity: 1,
			},
		])
	})

	test('fixes the scalar style without changing its chomping indicator or contents', async () => {
		const [result] = await lint('description: |-\n  Prose wrapped across\n  source lines.\n', true)

		expect(result.output).toBe('description: >-\n  Prose wrapped across\n  source lines.\n')
		expect(ruleMessages(result)).toEqual([])
	})

	test('allows intentional hard line breaks through a standard ESLint directive', async () => {
		const source = [
			'# eslint-disable-next-line hippos/description-block-style -- Hard breaks are required for this layout.',
			'description: |-',
			'  First line.',
			'  Second line.',
			'',
		].join('\n')
		const [result] = await lint(source)

		expect(ruleMessages(result)).toEqual([])
	})
})

async function lint(source: string, fix = false): Promise<ESLint.LintResult[]> {
	const eslint = new ESLint({ cwd: process.cwd(), fix })
	return eslint.lintText(source, { filePath: BLUEPRINT_FILE })
}

function ruleMessages(result: ESLint.LintResult): ESLint.LintResult['messages'] {
	return result.messages.filter((message) => message.ruleId === RULE_ID)
}
