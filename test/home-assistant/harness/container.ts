import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { requestHomeAssistant, type BlueprintRuntimeDiagnostics } from './client.ts'
import { applyBlueprintTestValueOverrides } from './blueprint-test-overrides.ts'
import { expectedAutomationStates, expectedFixtureStateEntityIds, generatedFixtureFiles } from './generated-config.ts'
import { formatHomeAssistantLogIssues, unexpectedHomeAssistantLogIssues } from './log-validation.ts'

type HarnessOptions = {
	image: string
	pullPolicy: PullPolicy
}

type PullPolicy = 'never' | 'missing' | 'always'

type RuntimeFixture = {
	configDir: string
	containerName: string
	logs: string[]
	process: ChildProcessWithoutNullStreams
	runtimeLogStart: number
}

const DEFAULT_IMAGE = 'ghcr.io/home-assistant/home-assistant:stable'
const VALID_PULL_POLICIES = new Set(['never', 'missing', 'always'])
const STARTUP_TIMEOUT_MS = 120_000

export async function setupRuntimeFixture(project: TestProject, repoRoot: string): Promise<() => Promise<void>> {
	if (!commandExists('docker')) {
		throw new Error('Docker is required for Home Assistant blueprint runtime tests.')
	}

	const options = harnessOptions()
	const configDir = prepareConfig(repoRoot)
	const containerName = `ha-blueprint-runtime-${process.pid}-${Date.now()}`
	const logs: string[] = []
	const processHandle = startHomeAssistant(configDir, options, containerName, repoRoot)
	const fixture: RuntimeFixture = { configDir, containerName, logs, process: processHandle, runtimeLogStart: 0 }

	processHandle.stdout.on('data', (chunk: Buffer) => recordLog(logs, chunk))
	processHandle.stderr.on('data', (chunk: Buffer) => recordLog(logs, chunk))

	try {
		await waitForFixture(fixture)
		requestHomeAssistant(containerName, 'run_blueprint_adoption', {}, 'POST')
		requestHomeAssistant(containerName, 'clear_events', {}, 'POST')
		fixture.runtimeLogStart = completeLogs(fixture).length
		project.provide('haBlueprintContainerName', containerName)
	} catch (error) {
		await stopFixture(fixture)
		throw error
	}

	return async () => teardownRuntimeFixture(fixture)
}

function harnessOptions(): HarnessOptions {
	const image = process.env.HA_IMAGE || DEFAULT_IMAGE
	const pullPolicy = process.env.HA_IMAGE_PULL_POLICY || 'never'

	if (!VALID_PULL_POLICIES.has(pullPolicy)) {
		throw new Error(`Invalid HA_IMAGE_PULL_POLICY: ${pullPolicy}\nExpected one of: never, missing, always`)
	}

	return { image, pullPolicy: pullPolicy as PullPolicy }
}

function commandExists(command: string): boolean {
	const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
	return !result.error && result.status === 0
}

function prepareConfig(repoRoot: string): string {
	const configDir = mkdtempSync(join(tmpdir(), 'ha-blueprint-runtime-test.'))
	const runtimeFixtureDir = join(repoRoot, 'test', 'home-assistant', 'runtime', 'fixtures')
	const targetBlueprintDir = join(configDir, 'blueprints', 'automation', 'hippotastic')
	const targetLegacyBlueprintDir = join(configDir, 'blueprints', 'automation', 'hippo')
	const targetTestIntegrationDir = join(configDir, 'custom_components', 'blueprint_test')
	const targetToolboxIntegrationDir = join(configDir, 'custom_components', 'hippos_toolbox')

	mkdirSync(targetBlueprintDir, { recursive: true })
	mkdirSync(targetLegacyBlueprintDir, { recursive: true })
	cpSync(join(runtimeFixtureDir, 'configuration.yaml'), join(configDir, 'configuration.yaml'))
	cpSync(join(runtimeFixtureDir, 'custom_components', 'blueprint_test'), targetTestIntegrationDir, { recursive: true })
	cpSync(join(repoRoot, 'custom_components', 'hippos_toolbox'), targetToolboxIntegrationDir, {
		filter: (source) => basename(source) !== '__pycache__',
		recursive: true,
	})
	renameSync(join(targetTestIntegrationDir, 'manifest.fixture.json'), join(targetTestIntegrationDir, 'manifest.json'))

	for (const file of readdirSync(join(repoRoot, 'blueprints', 'automation'))
		.filter((name) => name.endsWith('.yaml'))
		.sort()) {
		copyRuntimeBlueprint(join(repoRoot, 'blueprints', 'automation', file), join(targetBlueprintDir, basename(file)))
	}
	const legacyCoverSourcePath = join(repoRoot, 'blueprints', 'automation', 'cover_automation.yaml')
	const legacyCoverSource = applyBlueprintTestValueOverrides(readFileSync(legacyCoverSourcePath, 'utf8'), legacyCoverSourcePath)
	writeFileSync(join(targetLegacyBlueprintDir, 'cover_automation.yaml'), `${legacyCoverSource.trimEnd()}\n\n# Local pre-integration version\n`, 'utf8')
	for (const [file, source] of Object.entries(generatedFixtureFiles())) {
		writeFileSync(join(configDir, file), source, 'utf8')
	}
	prepareValidatorConfig(repoRoot, configDir)

	return configDir
}

function copyRuntimeBlueprint(sourcePath: string, targetPath: string): void {
	const source = readFileSync(sourcePath, 'utf8')
	writeFileSync(targetPath, applyBlueprintTestValueOverrides(source, sourcePath), 'utf8')
}

function prepareValidatorConfig(repoRoot: string, configDir: string): void {
	const validatorDir = join(configDir, 'validator')
	const validatorBlueprintDir = join(validatorDir, 'blueprints', 'automation', 'hippotastic')
	const validatorFixtureDir = join(repoRoot, 'test', 'home-assistant', 'blueprint-loading', 'fixtures')

	mkdirSync(validatorBlueprintDir, { recursive: true })
	cpSync(join(validatorFixtureDir, 'configuration.yaml'), join(validatorDir, 'configuration.yaml'))
	cpSync(join(validatorFixtureDir, 'automations.yaml'), join(validatorDir, 'automations.yaml'))

	for (const file of readdirSync(join(repoRoot, 'blueprints', 'automation'))
		.filter((name) => name.endsWith('.yaml'))
		.sort()) {
		cpSync(join(repoRoot, 'blueprints', 'automation', file), join(validatorBlueprintDir, basename(file)))
	}
}

function startHomeAssistant(configDir: string, options: HarnessOptions, name: string, repoRoot: string): ChildProcessWithoutNullStreams {
	return spawn(
		'docker',
		[
			'run',
			'--rm',
			'--name',
			name,
			'--pull',
			options.pullPolicy,
			'--network',
			'none',
			'-v',
			`${configDir}:/config`,
			'-v',
			`${repoRoot}:/repo:ro`,
			options.image,
			'hass',
			'-c',
			'/config',
		],
		{
			stdio: 'pipe',
		}
	)
}

async function waitForFixture(fixture: RuntimeFixture): Promise<void> {
	const expectedAutomations = expectedAutomationStates()
	const expectedFixtureStates = expectedFixtureStateEntityIds()
	const deadline = Date.now() + STARTUP_TIMEOUT_MS

	while (Date.now() < deadline) {
		if (fixture.process.exitCode !== null) {
			throw new Error(`Home Assistant exited before becoming ready.\n${lastLogLines(fixture.logs)}`)
		}

		try {
			const diagnostics = requestHomeAssistant<BlueprintRuntimeDiagnostics>(fixture.containerName, 'diagnostics', {}, 'GET')
			const states = new Map(diagnostics.states.map((state) => [state.entity_id, state.state]))
			if (expectedAutomations.every(({ entityId, state }) => states.get(entityId) === state) && expectedFixtureStates.every((entityId) => states.has(entityId))) {
				await delay(250)
				return
			}
		} catch {
			// Home Assistant is still starting.
		}

		await delay(500)
	}

	throw new Error(`Timed out waiting for Home Assistant fixture.\n${lastLogLines(fixture.logs)}`)
}

async function stopFixture(fixture: RuntimeFixture): Promise<void> {
	if (fixture.process.exitCode === null) {
		fixture.process.kill('SIGTERM')
		await new Promise<void>((resolveStop) => {
			const timeout = setTimeout(() => {
				fixture.process.kill('SIGKILL')
				resolveStop()
			}, 10_000)

			fixture.process.once('exit', () => {
				clearTimeout(timeout)
				resolveStop()
			})
		})
	}

	if (process.env.KEEP_HA_BLUEPRINT_RUNTIME_TEST_CONFIG === '1') {
		process.stdout.write(`blueprint-runtime-test: kept config ${fixture.configDir}\n`)
		return
	}

	if (existsSync(fixture.configDir)) {
		rmSync(fixture.configDir, { force: true, recursive: true })
	}
}

async function teardownRuntimeFixture(fixture: RuntimeFixture): Promise<void> {
	let logError: Error | undefined
	try {
		// Let Home Assistant flush warnings caused by the final awaited action.
		await delay(100)
		const issues = unexpectedHomeAssistantLogIssues(completeLogs(fixture).slice(fixture.runtimeLogStart))
		if (issues.length > 0) {
			logError = new Error(`Home Assistant emitted unexpected runtime log entries:\n\n${formatHomeAssistantLogIssues(issues)}`)
		}
	} finally {
		await stopFixture(fixture)
	}

	if (logError) {
		process.exitCode = 1
		throw logError
	}
}

function completeLogs(fixture: RuntimeFixture): string {
	return fixture.logs.join('')
}

function lastLogLines(logs: string[]): string {
	return logs.join('').split('\n').slice(-100).join('\n')
}

function recordLog(logs: string[], chunk: Buffer): void {
	const value = chunk.toString('utf8')
	logs.push(value)
	if (process.env.HA_BLUEPRINT_RUNTIME_LOGS === '1') {
		process.stderr.write(value)
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
