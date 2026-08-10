import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, inject, test } from 'vitest'
import { parseDocument } from 'yaml'

const HOME_ASSISTANT_YAML_TAG_NAMES = [
	'!env_var',
	'!include',
	'!include_dir_list',
	'!include_dir_merge_list',
	'!include_dir_merge_named',
	'!include_dir_named',
	'!input',
	'!secret',
]
const HOME_ASSISTANT_YAML_TAGS = HOME_ASSISTANT_YAML_TAG_NAMES.map((tag) => ({
	resolve: (value: string) => value,
	tag,
}))

describe('Home Assistant repository validation', () => {
	test('parses all blueprint and validator YAML', () => {
		for (const file of validationYamlFiles()) {
			const document = parseDocument(readFileSync(file, 'utf8'), {
				customTags: HOME_ASSISTANT_YAML_TAGS,
				prettyErrors: true,
			})

			expect(document.errors, `${file} contains YAML errors`).toEqual([])
			expect(document.warnings, `${file} contains YAML warnings`).toEqual([])
		}
	})

	test('passes the Python integration regression tests inside Home Assistant', () => {
		const result = runInHomeAssistant(['python3', '-m', 'unittest', 'discover', '-s', '/repo/test/config', '-p', 'test_*.py'])

		expect(result.status, commandOutput(result)).toBe(0)
	})

	test('passes Home Assistant check_config without warnings', () => {
		const result = runInHomeAssistant(['hass', '--script', 'check_config', '-c', '/config/validator', '--fail-on-warnings'])

		expect(result.status, commandOutput(result)).toBe(0)
	})
})

function validationYamlFiles(): string[] {
	const repoRoot = process.cwd()
	return [join(repoRoot, 'blueprints', 'automation'), join(repoRoot, 'tools', 'ha-blueprint-validator', 'fixtures')].flatMap((directory) =>
		readdirSync(directory)
			.filter((file) => file.endsWith('.yaml'))
			.sort()
			.map((file) => join(directory, file))
	)
}

function runInHomeAssistant(command: string[]) {
	return spawnSync('docker', ['exec', '-w', '/repo', inject('haBlueprintContainerName'), ...command], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	})
}

function commandOutput(result: ReturnType<typeof runInHomeAssistant>): string {
	return filterKnownHomeAssistantNoise(`${result.stdout}${result.stderr}`)
}

function filterKnownHomeAssistantNoise(output: string): string {
	return output.replace(/^\/usr\/local\/lib\/python3\.\d+\/site-packages\/rich\/segment\.py:547: SyntaxWarning: 'return' in a 'finally' block\n {2}return\n/gm, '')
}
