import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseDocument } from 'yaml'

const HOME_ASSISTANT_YAML_TAGS = [
	'!env_var',
	'!include',
	'!include_dir_list',
	'!include_dir_merge_list',
	'!include_dir_merge_named',
	'!include_dir_named',
	'!input',
	'!secret',
].map((tag) => ({
	resolve: (value: string) => value,
	tag,
}))

describe('Blueprint YAML', () => {
	test('parses every published blueprint and validation fixture', () => {
		for (const file of validationYamlFiles()) {
			const document = parseDocument(readFileSync(file, 'utf8'), {
				customTags: HOME_ASSISTANT_YAML_TAGS,
				prettyErrors: true,
			})

			expect(document.errors, `${file} contains YAML errors`).toEqual([])
			expect(document.warnings, `${file} contains YAML warnings`).toEqual([])
		}
	})

	test('defines the intended music controller defaults', () => {
		const document = parseDocument(readFileSync(join(process.cwd(), 'blueprints', 'automation', 'push_button_music_controller.yaml'), 'utf8'), {
			customTags: HOME_ASSISTANT_YAML_TAGS,
		})

		expect(document.getIn(['blueprint', 'input', 'volume_section', 'input', 'start_volume', 'default'])).toBe(50)
		expect(document.getIn(['blueprint', 'input', 'volume_section', 'input', 'minimum_volume', 'default'])).toBe(25)
		expect(document.getIn(['blueprint', 'input', 'volume_section', 'input', 'maximum_volume', 'default'])).toBe(75)
		expect(document.getIn(['blueprint', 'input', 'favorites_section', 'input', 'shuffle_mode', 'default'])).toBe('off')
	})
})

function validationYamlFiles(): string[] {
	const repoRoot = process.cwd()
	return [join(repoRoot, 'blueprints', 'automation'), join(repoRoot, 'test', 'home-assistant', 'blueprint-loading', 'fixtures')].flatMap((directory) =>
		readdirSync(directory)
			.filter((file) => file.endsWith('.yaml'))
			.sort()
			.map((file) => join(directory, file))
	)
}
