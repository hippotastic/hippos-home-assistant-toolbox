import { isDeepStrictEqual } from 'node:util'
import type { BlueprintRuntimeClient, BlueprintServiceCall } from '../../harness/client.ts'
import { withScenarioDiagnostics } from '../../harness/client.ts'
import { settle } from '../helpers/timing.ts'
import type { MusicControllerState, MusicScenario } from './scenarios.ts'

type PlayerConfiguration = {
	pause_fails?: boolean
	resume_fails?: boolean
	shuffle?: boolean
	state?: string
	volume_level?: number
	volume_set_fails?: boolean
}

type ScenarioContext = ReturnType<typeof scenarioContext>

export async function withMusicScenario(scenario: MusicScenario, run: (context: ScenarioContext) => Promise<void>): Promise<void> {
	await withScenarioDiagnostics(scenarioEntityIds(scenario), async (client) => {
		await initializeScenario(client, scenario)
		await run(scenarioContext(client, scenario))
	})
}

function scenarioContext(client: BlueprintRuntimeClient, scenario: MusicScenario) {
	return {
		client,
		scenario,
		configurePlayer: (configuration: PlayerConfiguration) => configurePlayer(client, scenario, configuration),
		doubleTap: (buttonEntity?: string) => doubleTap(client, scenario, buttonEntity),
		expectHelper: (expected: Partial<MusicControllerState>) => expectHelper(client, scenario, expected),
		holdFor: (milliseconds: number, buttonEntity?: string) => holdFor(client, scenario, milliseconds, buttonEntity),
		logMessages: () => logMessages(client, scenario),
		mediaCalls: () => mediaCalls(client, scenario),
		prepareNextAction: () => prepareNextAction(client, scenario),
		setHelper: (value: MusicControllerState | string) => setHelper(client, scenario, value),
		singleTap: (buttonEntity?: string) => singleTap(client, scenario, buttonEntity),
		tripleTap: (buttonEntity?: string) => tripleTap(client, scenario, buttonEntity),
	}
}

async function initializeScenario(client: BlueprintRuntimeClient, scenario: MusicScenario): Promise<void> {
	await client.callService('automation', 'turn_off', { entity_id: scenario.entities.automation })
	for (const buttonEntity of new Set([scenario.entities.button, scenario.entities.secondButton].filter((entityId): entityId is string => entityId !== undefined))) {
		await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	}
	if (scenario.entities.seeking) {
		await client.callService('homeassistant', 'turn_off', { entity_id: scenario.entities.seeking })
	}
	if (scenario.entities.playing) {
		await client.callService('homeassistant', 'turn_off', { entity_id: scenario.entities.playing })
	}
	await configurePlayer(client, scenario, {
		pause_fails: false,
		resume_fails: false,
		shuffle: false,
		state: scenario.initial.playerState,
		volume_level: scenario.initial.volume,
		volume_set_fails: scenario.initial.volumeSetFails,
	})
	await setHelper(client, scenario, scenario.initial.helper)
	await client.callService('automation', 'turn_on', { entity_id: scenario.entities.automation })
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
	await client.startEventWindow()
}

async function configurePlayer(client: BlueprintRuntimeClient, scenario: MusicScenario, configuration: PlayerConfiguration): Promise<void> {
	await client.callService('blueprint_test', 'configure_media_player', {
		entity_id: scenario.entities.player,
		...configuration,
	})
}

async function setHelper(client: BlueprintRuntimeClient, scenario: MusicScenario, value: MusicControllerState | string): Promise<void> {
	await client.callService('input_text', 'set_value', {
		entity_id: scenario.entities.helper,
		value: typeof value === 'string' ? value : JSON.stringify(value),
	})
}

async function singleTap(client: BlueprintRuntimeClient, scenario: MusicScenario, buttonEntity = scenario.entities.button): Promise<void> {
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
}

async function doubleTap(client: BlueprintRuntimeClient, scenario: MusicScenario, buttonEntity = scenario.entities.button): Promise<void> {
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await settle(20)
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
}

async function tripleTap(client: BlueprintRuntimeClient, scenario: MusicScenario, buttonEntity = scenario.entities.button): Promise<void> {
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await settle(20)
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await settle(20)
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
}

async function holdFor(client: BlueprintRuntimeClient, scenario: MusicScenario, milliseconds: number, buttonEntity = scenario.entities.button): Promise<void> {
	await client.callService('input_boolean', 'turn_on', { entity_id: buttonEntity })
	await settle(milliseconds)
	await client.callService('input_boolean', 'turn_off', { entity_id: buttonEntity })
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
}

async function prepareNextAction(client: BlueprintRuntimeClient, scenario: MusicScenario): Promise<void> {
	await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
	await client.startEventWindow()
}

async function expectHelper(client: BlueprintRuntimeClient, scenario: MusicScenario, expected: Partial<MusicControllerState>): Promise<MusicControllerState> {
	const deadline = Date.now() + 3_000
	let actual: MusicControllerState | undefined

	while (Date.now() < deadline) {
		const state = await client.getState(scenario.entities.helper)
		actual = state ? parseControllerState(state.state) : undefined
		if (actual && partialMatches(actual, expected)) {
			return actual
		}
		await settle(25)
	}

	throw new Error(`Expected helper to include ${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`)
}

async function mediaCalls(client: BlueprintRuntimeClient, scenario: MusicScenario): Promise<BlueprintServiceCall[]> {
	return (await client.serviceCalls()).filter((call) => call.domain === 'media_player' && targetsEntity(call, scenario.entities.player))
}

async function logMessages(client: BlueprintRuntimeClient, scenario: MusicScenario): Promise<string[]> {
	return (await client.serviceCalls({ domain: 'logbook', entityId: scenario.entities.player, service: 'log' }))
		.map((call) => call.serviceData.message)
		.filter((message): message is string => typeof message === 'string')
		.map((message) => message.replaceAll(/\s+/g, ' ').trim())
}

function parseControllerState(value: string): MusicControllerState {
	return JSON.parse(value) as MusicControllerState
}

function partialMatches(actual: MusicControllerState, expected: Partial<MusicControllerState>): boolean {
	return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual[key as keyof MusicControllerState], value))
}

function targetsEntity(call: BlueprintServiceCall, entityId: string): boolean {
	const selected = call.target.entity_id ?? call.serviceData.entity_id
	return selected === entityId || (Array.isArray(selected) && selected.includes(entityId))
}

function scenarioEntityIds(scenario: MusicScenario): string[] {
	return [
		scenario.entities.automation,
		scenario.entities.button,
		...(scenario.entities.secondButton ? [scenario.entities.secondButton] : []),
		scenario.entities.helper,
		scenario.entities.player,
		...(scenario.entities.playing ? [scenario.entities.playing] : []),
		...(scenario.entities.seeking ? [scenario.entities.seeking] : []),
	]
}
