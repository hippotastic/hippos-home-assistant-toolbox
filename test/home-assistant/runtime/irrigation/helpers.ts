import { isDeepStrictEqual } from 'node:util'
import { withScenarioDiagnostics, type BlueprintRuntimeClient, type BlueprintServiceCall } from '../../harness/client.ts'
import { callsForEntity } from '../helpers/assertions.ts'
import { prepareNextAction } from '../helpers/actions.ts'
import { createEntityStateExpectation, type StateExpectation, type StateHoldOptions, type StatePredicate, type StateTransitionOptions } from '../helpers/state-expectations.ts'
import { settle } from '../helpers/timing.ts'
import type { IrrigationCalculationScenario, IrrigationSchedulerScenario } from './scenarios.ts'

export type ZoneStatus = Record<string, unknown> & {
	interval?: number
	last_end?: string
	max_runtime?: number
	next?: [string, number, number]
	next_start?: string
	next_end?: string
	r?: number
	runtime?: number
	cycle?: string
	slot?: number
	watered?: number
	valve?: string
}

type RelativeTimeOffset = {
	milliseconds?: number
	minutes?: number
}

type IrrigationCall = {
	service: string
	target: 'pump' | `valve:${number}`
}

type ZoneStatusExpectation = StateExpectation<ZoneStatus>

type CalculationScenarioFixture<TScenario extends IrrigationCalculationScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	entities: TScenario['entities']
	/** Waits until the parsed zone helper equals the expected status or satisfies the supplied predicate */
	expectHelperToBecome: (expected: ZoneStatusExpectation, options?: StateTransitionOptions) => Promise<ZoneStatus>
	/** Rejects visible helper state changes during the observation period */
	expectNoHelperChanges: (options?: { forMs?: number }) => Promise<void>
	/** Finishes the previous automation run and starts a fresh event window for the next action */
	prepareNextAction: () => Promise<void>
	/** Requests the scheduler-driven rain reconciliation for a later irrigation slot */
	requestRainReconciliation: () => Promise<void>
	/** Immediately enables or disables the calculation automation without clearing recorded events */
	setAutomationEnabled: (enabled: boolean) => Promise<void>
	/** Updates both climate sensor states used by the calculation */
	setClimate: (climate: { rainfall: string; temperature: string }) => Promise<void>
	/** Updates the optional soil-moisture sensor state */
	setMoisture: (moisture: string) => Promise<void>
	/** Writes an exact helper value without adding the scenario valve, including deliberately invalid data */
	setRawZoneHelper: (value: string | ZoneStatus) => Promise<void>
	/** Writes a JSON zone status and automatically supplies the scenario valve */
	setZoneHelper: (status: ZoneStatus) => Promise<void>
	/** Waits for a valve logbook message containing the supplied text */
	waitForValveLog: (text: string) => Promise<BlueprintServiceCall>
}

type SchedulerScenarioFixture<TScenario extends IrrigationSchedulerScenario> = {
	scenario: TScenario
	client: BlueprintRuntimeClient
	entities: TScenario['entities']
	/** Waits for the pump to reach the expected state within the optional transition timeout */
	expectPumpToBecome: (state: 'off' | 'on', options?: StateTransitionOptions) => Promise<void>
	/** Waits for a zone valve to reach the expected state within the optional transition timeout */
	expectValveToBecome: (zoneIndex: number, state: 'off' | 'on', options?: StateTransitionOptions) => Promise<void>
	/** Rejects visible zone valve state changes during the observation period */
	expectNoValveChanges: (zoneIndex: number, options?: StateHoldOptions) => Promise<void>
	/** Rejects a scheduling run caused by the preceding scenario action */
	expectNoSchedulingUpdates: (options?: StateHoldOptions) => Promise<void>
	/** Fires the configured daily time and returns the number of matching automations triggered */
	fireScheduledTime: () => Promise<number>
	/** Returns pump and valve switch calls in Home Assistant firing order */
	irrigationCalls: () => Promise<IrrigationCall[]>
	/** Returns an ISO timestamp offset from the scenario's fixed creation-time anchor */
	relativeTime: (offset: RelativeTimeOffset) => string
	/** Finishes the previous automation run and starts a fresh event window for the next action */
	prepareNextAction: () => Promise<void>
	/** Sets the physical pump state through its real switch service */
	setPump: (enabled: boolean) => Promise<void>
	/** Writes an exact zone helper value without adding its valve, including deliberately invalid data */
	setRawZoneHelper: (zoneIndex: number, value: string | ZoneStatus) => Promise<void>
	/** Sets a physical zone valve through its real switch service */
	setValve: (zoneIndex: number, enabled: boolean) => Promise<void>
	/** Writes a JSON zone status and automatically supplies the matching zone valve */
	setZoneHelper: (zoneIndex: number, status: ZoneStatus) => Promise<void>
	/** Stabilizes setup, clears recorded events, enables the scheduler, and returns its start timestamp */
	startSchedulers: () => Promise<number>
	/** Waits for a triggered scheduling action to finish */
	waitForSchedulingFinished: () => Promise<void>
	/** Waits for the scheduler automation to be triggered */
	waitForSchedulingStarted: () => Promise<void>
	/** Waits for a zone valve logbook message containing the supplied text */
	waitForValveLog: (zoneIndex: number, text: string) => Promise<BlueprintServiceCall>
	/** Waits until a parsed zone helper satisfies the supplied predicate */
	waitForZoneHelper: (zoneIndex: number, predicate: (status: ZoneStatus) => boolean, options?: { timeoutMs?: number }) => Promise<ZoneStatus>
}

/** Initializes a calculation scenario and runs it with diagnostics, cleanup, and bound test operations */
export async function withCalculationScenario<TScenario extends IrrigationCalculationScenario, TResult>(
	scenario: TScenario,
	run: (fixture: CalculationScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(calculationScenarioEntityIds(scenario), async (client) => {
		const { entities } = scenario
		await initializeCalculationScenario(client, scenario)
		const helperState = createEntityStateExpectation(client, entities.helper, (state) => parseZoneStatus(state.state), {
			automationEntityIds: [entities.automation],
			matches: isDeepStrictEqual,
			revision: (state) => state.last_updated,
		})

		try {
			return await run({
				scenario,
				client,
				entities,
				expectHelperToBecome: async (expected, options) => {
					const status = await helperState.expectToBecome(zoneStatusPredicate(expected), options)
					if (!status) throw new Error(`Expected ${entities.helper} to contain a zone status`)
					return status
				},
				expectNoHelperChanges: (options) => helperState.expectNoChanges(options),
				prepareNextAction: () => prepareNextAction(client, [entities.automation]),
				requestRainReconciliation: () =>
					client.fireEvent('hippos_irrigation_slot_preparing', {
						slot: 'secondary',
						start: new Date(Date.now() + 120_000).toISOString(),
						zone_status_helper_entities: [entities.helper],
					}),
				setAutomationEnabled: (enabled) => setAutomation(client, entities.automation, enabled),
				setClimate: async ({ rainfall, temperature }) => {
					await client.setState(scenario.sensors.rainfall, rainfall)
					await client.setState(scenario.sensors.temperature, temperature)
				},
				setMoisture: (moisture) => client.setState(scenario.sensors.moisture, moisture),
				setRawZoneHelper: (value) => setHelper(client, entities.helper, value),
				setZoneHelper: (status) => setHelper(client, entities.helper, { ...status, valve: entities.valve }),
				waitForValveLog: (text) => waitForLogMessage(client, entities.valve, text),
			})
		} finally {
			await setAutomation(client, entities.automation, false)
			await setSwitch(client, entities.valve, false)
		}
	})
}

/** Initializes a scheduler scenario and runs it with diagnostics, cleanup, and bound test operations */
export async function withSchedulerScenario<TScenario extends IrrigationSchedulerScenario, TResult>(
	scenario: TScenario,
	run: (fixture: SchedulerScenarioFixture<TScenario>) => Promise<TResult>
): Promise<TResult> {
	return withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
		const { entities } = scenario
		await initializeSchedulerScenario(client, scenario)
		let anchorTime = Date.now()
		const expectationOptions = { automationEntityIds: [entities.automation] }
		const pumpState = createEntityStateExpectation(client, entities.pump, (state) => state.state, expectationOptions)
		const valveStates = entities.valves.map((valve) => createEntityStateExpectation(client, valve, (state) => state.state, expectationOptions))

		try {
			return await run({
				scenario,
				client,
				entities,
				expectPumpToBecome: async (state, options) => {
					await pumpState.expectToBecome(state, options)
				},
				expectValveToBecome: async (zoneIndex, state, options) => {
					await zoneEntity(valveStates, zoneIndex).expectToBecome(state, options)
				},
				expectNoValveChanges: (zoneIndex, options) => zoneEntity(valveStates, zoneIndex).expectNoChanges(options),
				expectNoSchedulingUpdates: (options) => expectNoAutomationTriggers(client, entities.automation, options),
				fireScheduledTime: () => client.fireScheduledTime(scenario.startTime),
				irrigationCalls: () => readIrrigationCalls(client, entities),
				prepareNextAction: () => prepareNextAction(client, [entities.automation]),
				relativeTime: (offset) => relativeTime(anchorTime, offset),
				setPump: (enabled) => setSwitch(client, entities.pump, enabled),
				setRawZoneHelper: (zoneIndex, value) => setHelper(client, zoneEntity(entities.helpers, zoneIndex), value),
				setValve: (zoneIndex, enabled) => setSwitch(client, zoneEntity(entities.valves, zoneIndex), enabled),
				setZoneHelper: (zoneIndex, status) =>
					setHelper(client, zoneEntity(entities.helpers, zoneIndex), {
						...status,
						valve: zoneEntity(entities.valves, zoneIndex),
					}),
				startSchedulers: async () => {
					await prepareNextAction(client, [entities.automation])
					anchorTime = Date.now()
					const startedAt = Date.now()
					await setAutomation(client, entities.automation, true)
					return startedAt
				},
				waitForSchedulingFinished: () => waitForAutomationToFinish(client, entities.automation),
				waitForSchedulingStarted: () => waitForAutomationTrigger(client, entities.automation),
				waitForValveLog: (zoneIndex, text) => waitForLogMessage(client, zoneEntity(entities.valves, zoneIndex), text),
				waitForZoneHelper: (zoneIndex, predicate, options) => waitForZoneHelper(client, zoneEntity(entities.helpers, zoneIndex), predicate, options),
			})
		} finally {
			await setAutomation(client, entities.automation, false)
			await setSwitch(client, entities.pump, false)
			for (const valve of entities.valves) {
				await setSwitch(client, valve, false)
			}
		}
	})
}

async function initializeCalculationScenario(client: BlueprintRuntimeClient, scenario: IrrigationCalculationScenario): Promise<void> {
	await client.setState(scenario.sensors.rainfall, '0')
	await client.setState(scenario.sensors.temperature, '20')
	await client.setState(scenario.sensors.moisture, '50')
	await setAutomation(client, scenario.entities.automation, false)
	await setSwitch(client, scenario.entities.valve, false)
	await setHelper(client, scenario.entities.helper, '{}')
	await prepareNextAction(client, [scenario.entities.automation])
}

async function initializeSchedulerScenario(client: BlueprintRuntimeClient, scenario: IrrigationSchedulerScenario): Promise<void> {
	const { entities } = scenario
	await setAutomation(client, entities.automation, false)
	await setSwitch(client, entities.pump, false)
	for (const [zoneIndex, valve] of entities.valves.entries()) {
		await setSwitch(client, valve, false)
		await setHelper(client, entities.helpers[zoneIndex], '{}')
	}
	await prepareNextAction(client, [entities.automation])
}

/** Enables or disables an automation through its real Home Assistant service */
export async function setAutomation(client: BlueprintRuntimeClient, entityId: string, enabled: boolean): Promise<void> {
	await client.callService('automation', enabled ? 'turn_on' : 'turn_off', { entity_id: entityId })
}

/** Writes a string or JSON-serialized zone status to an `input_text` entity */
export async function setHelper(client: BlueprintRuntimeClient, entityId: string, value: string | ZoneStatus): Promise<void> {
	await client.callService('input_text', 'set_value', {
		entity_id: entityId,
		value: typeof value === 'string' ? value : JSON.stringify(value),
	})
}

/** Turns a switch entity on or off through its real Home Assistant service */
export async function setSwitch(client: BlueprintRuntimeClient, entityId: string, enabled: boolean): Promise<void> {
	await client.callService('switch', enabled ? 'turn_on' : 'turn_off', { entity_id: entityId })
}

/** Polls and parses a zone helper until its value satisfies the supplied predicate */
export async function waitForZoneHelper(
	client: BlueprintRuntimeClient,
	entityId: string,
	predicate: (status: ZoneStatus) => boolean,
	options: { timeoutMs?: number } = {}
): Promise<ZoneStatus> {
	const deadline = Date.now() + (options.timeoutMs ?? 5000)

	while (Date.now() < deadline) {
		const state = await client.getState(entityId)
		if (state) {
			const status = parseZoneStatus(state.state)
			if (status && predicate(status)) {
				return status
			}
		}
		await settle(25)
	}

	const state = await client.getState(entityId)
	throw new Error(`Timed out waiting for zone status ${entityId}; current=${state?.state ?? 'missing'}`)
}

function calculationScenarioEntityIds(scenario: IrrigationCalculationScenario): string[] {
	return [scenario.sensors.rainfall, scenario.sensors.temperature, ...Object.values(scenario.entities)]
}

function schedulerScenarioEntityIds(scenario: IrrigationSchedulerScenario): string[] {
	return [scenario.entities.automation, scenario.entities.pump, ...scenario.entities.helpers, ...scenario.entities.valves]
}

function zoneStatusPredicate(expected: ZoneStatusExpectation): StatePredicate<ZoneStatus | null> {
	return (status) => status !== null && (typeof expected === 'function' ? expected(status) : isDeepStrictEqual(status, expected))
}

async function readIrrigationCalls(client: BlueprintRuntimeClient, entities: IrrigationSchedulerScenario['entities']): Promise<IrrigationCall[]> {
	const calls = await client.serviceCalls({ domain: 'switch' })
	return calls.flatMap((call): IrrigationCall[] => {
		if (callsForEntity([call], entities.pump).length > 0) {
			return [{ service: call.service, target: 'pump' }]
		}
		const zoneIndex = entities.valves.findIndex((valve) => callsForEntity([call], valve).length > 0)
		return zoneIndex < 0 ? [] : [{ service: call.service, target: `valve:${zoneIndex}` }]
	})
}

async function waitForAutomationTrigger(client: BlueprintRuntimeClient, entityId: string): Promise<void> {
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		const trigger = (await client.events()).find((event) => event.event_type === 'automation_triggered' && event.data.entity_id === entityId)
		if (trigger) return
		await settle(25)
	}
	throw new Error(`Timed out waiting for ${entityId} to be triggered`)
}

async function waitForAutomationToFinish(client: BlueprintRuntimeClient, entityId: string): Promise<void> {
	await waitForAutomationTrigger(client, entityId)
	await client.waitForActionToSettle([entityId])
}

async function expectNoAutomationTriggers(client: BlueprintRuntimeClient, entityId: string, options: StateHoldOptions = {}): Promise<void> {
	if (options.forMs === undefined) {
		await client.waitForActionToSettle([entityId])
	} else {
		await settle(options.forMs)
	}
	const trigger = (await client.events()).find((event) => event.event_type === 'automation_triggered' && event.data.entity_id === entityId)
	if (trigger) {
		throw new Error(`Unexpected automation trigger for ${entityId}`)
	}
}

async function waitForLogMessage(client: BlueprintRuntimeClient, entityId: string, text: string): Promise<BlueprintServiceCall> {
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		const call = (await client.serviceCalls({ domain: 'logbook', entityId, service: 'log' })).find((candidate) => String(candidate.serviceData.message).includes(text))
		if (call) return call
		await settle(25)
	}
	throw new Error(`Timed out waiting for logbook message containing ${JSON.stringify(text)} for ${entityId}`)
}

function relativeTime(anchorTime: number, offset: RelativeTimeOffset): string {
	const milliseconds = (offset.minutes ?? 0) * 60000 + (offset.milliseconds ?? 0)
	return new Date(anchorTime + milliseconds).toISOString()
}

function zoneEntity<TEntity>(entities: readonly TEntity[], zoneIndex: number): TEntity {
	const entity = entities[zoneIndex]
	if (entity === undefined) {
		throw new Error(`Zone index ${zoneIndex} is outside the configured range of ${entities.length} zones`)
	}
	return entity
}

function parseZoneStatus(value: string): ZoneStatus | null {
	try {
		const parsed: unknown = JSON.parse(value)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ZoneStatus) : null
	} catch {
		return null
	}
}
