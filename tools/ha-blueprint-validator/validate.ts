#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseDocument } from 'yaml'

type Mode = 'check' | 'syntax' | 'prepare'
type PullPolicy = 'never' | 'missing' | 'always'

type Options = {
	mode: Mode
	image: string
	pullPolicy: PullPolicy
}

const DEFAULT_IMAGE = 'ghcr.io/home-assistant/home-assistant:stable'
const VALID_PULL_POLICIES = new Set(['never', 'missing', 'always'])
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
	tag,
	resolve: (value: string) => value,
}))

function usage(): string {
	return `Usage: pnpm validate [options]

Options:
  --image IMAGE     Home Assistant Docker image to use.
                    Defaults to ${DEFAULT_IMAGE}.
  --pull POLICY     Docker image pull policy: never, missing, always.
                    Defaults to never.
  --syntax-only     Only parse repository and fixture YAML files.
  --prepare-only    Build the temporary Home Assistant config and print its path.
  -h, --help        Show this help.

Environment:
  HA_IMAGE                               Default Docker image override.
  HA_IMAGE_PULL_POLICY                   Default Docker pull policy override.
  KEEP_HA_BLUEPRINT_VALIDATOR_CONFIG=1  Keep the generated config after Docker validation.
`
}

function parseArgs(argv: string[]): Options {
	let mode: Mode = 'check'
	let image = process.env.HA_IMAGE || DEFAULT_IMAGE
	let pullPolicy = process.env.HA_IMAGE_PULL_POLICY || 'never'

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]

		switch (arg) {
			case '--':
				break
			case '--image': {
				const value = argv[index + 1]
				if (!value) {
					throw new Error('Missing value for --image')
				}
				image = value
				index += 1
				break
			}
			case '--pull': {
				const value = argv[index + 1]
				if (!value) {
					throw new Error('Missing value for --pull')
				}
				pullPolicy = value
				index += 1
				break
			}
			case '--syntax-only':
				mode = 'syntax'
				break
			case '--prepare-only':
				mode = 'prepare'
				break
			case '-h':
			case '--help':
				process.stdout.write(usage())
				process.exit(0)
				return {
					mode,
					image,
					pullPolicy: pullPolicy as PullPolicy,
				}
			default:
				throw new Error(`Unknown option: ${arg}`)
		}
	}

	if (!VALID_PULL_POLICIES.has(pullPolicy)) {
		throw new Error(`Invalid --pull policy: ${pullPolicy}\nExpected one of: never, missing, always`)
	}

	return {
		mode,
		image,
		pullPolicy: pullPolicy as PullPolicy,
	}
}

function filterKnownHomeAssistantNoise(output: string): string {
	return output.replace(/^\/usr\/local\/lib\/python3\.\d+\/site-packages\/rich\/segment\.py:547: SyntaxWarning: 'return' in a 'finally' block\n {2}return\n/gm, '')
}

function runDocker(args: string[]): void {
	const result = spawnSync('docker', args, { encoding: 'utf8' })

	if (result.error) {
		throw result.error
	}

	process.stdout.write(filterKnownHomeAssistantNoise(result.stdout))
	process.stderr.write(filterKnownHomeAssistantNoise(result.stderr))

	if (result.status !== 0) {
		process.exit(result.status || 1)
	}
}

function commandExists(command: string): boolean {
	const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
	return !result.error && result.status === 0
}

function yamlFilesIn(directory: string): string[] {
	return readdirSync(directory)
		.filter((file) => file.endsWith('.yaml'))
		.sort()
		.map((file) => join(directory, file))
}

function checkYamlSyntax(files: string[]): void {
	for (const file of files) {
		const source = readFileSync(file, 'utf8')
		const document = parseDocument(source, {
			customTags: HOME_ASSISTANT_YAML_TAGS,
			prettyErrors: true,
		})

		if (document.errors.length > 0) {
			const messages = document.errors.map((error) => error.message).join('\n')
			throw new Error(`YAML ERROR ${file}:\n${messages}`)
		}

		for (const warning of document.warnings) {
			process.stderr.write(`YAML WARNING ${file}: ${warning.message}\n`)
		}

		process.stderr.write(`YAML OK ${file}\n`)
	}
}

function main(): void {
	const options = parseArgs(process.argv.slice(2))
	const toolDir = dirname(fileURLToPath(import.meta.url))
	const repoRoot = join(toolDir, '..', '..')
	const blueprintSourceDir = join(repoRoot, 'blueprints', 'automation')

	if (!existsSync(blueprintSourceDir)) {
		throw new Error(`Blueprint source directory not found: ${blueprintSourceDir}`)
	}

	const syntaxFiles = [...yamlFilesIn(blueprintSourceDir), ...yamlFilesIn(join(toolDir, 'fixtures'))]

	checkYamlSyntax(syntaxFiles)

	if (options.mode === 'syntax') {
		return
	}

	const configDir = mkdtempSync(join(tmpdir(), 'ha-blueprint-validator.'))
	let shouldCleanUp = options.mode !== 'prepare'

	try {
		const targetBlueprintDir = join(configDir, 'blueprints', 'automation', 'hippotastic')

		mkdirSync(targetBlueprintDir, { recursive: true })

		for (const file of yamlFilesIn(blueprintSourceDir)) {
			cpSync(file, join(targetBlueprintDir, basename(file)))
		}

		cpSync(join(toolDir, 'fixtures', 'configuration.yaml'), join(configDir, 'configuration.yaml'))
		cpSync(join(toolDir, 'fixtures', 'automations.yaml'), join(configDir, 'automations.yaml'))

		if (options.mode === 'prepare') {
			shouldCleanUp = false
			process.stdout.write(`${configDir}\n`)
			return
		}

		if (!commandExists('docker')) {
			throw new Error('Docker is required for Home Assistant validation. Install Docker or run with --syntax-only.')
		}

		runDocker([
			'run',
			'--rm',
			'--pull',
			options.pullPolicy,
			'--network',
			'none',
			'-v',
			`${configDir}:/config`,
			options.image,
			'hass',
			'--script',
			'check_config',
			'-c',
			'/config',
			'--fail-on-warnings',
		])
	} finally {
		if (shouldCleanUp && process.env.KEEP_HA_BLUEPRINT_VALIDATOR_CONFIG !== '1') {
			rmSync(configDir, { recursive: true, force: true })
		}
	}
}

try {
	main()
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${message}\n`)
	process.exit(1)
}
