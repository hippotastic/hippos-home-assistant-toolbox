import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { inject } from 'vitest'

export type BlueprintRuntimeClient = {
	callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void>
	diagnostics(): Promise<BlueprintRuntimeDiagnostics>
	events(): Promise<BlueprintRuntimeEvent[]>
	fireScheduledTime(time: string): Promise<number>
	getState(entityId: string): Promise<BlueprintRuntimeState | null>
	serviceCalls(match?: ServiceCallMatch): Promise<BlueprintServiceCall[]>
	setState(entityId: string, state: string, options?: SetStateOptions): Promise<void>
	startEventWindow(): Promise<void>
	waitForActionToSettle(automationEntityIds: string[], options?: WaitOptions): Promise<void>
	waitForServiceCall(match: ServiceCallMatch, options?: WaitOptions): Promise<BlueprintServiceCall>
	waitForState(entityId: string, expected: StateExpectation, options?: WaitOptions): Promise<BlueprintRuntimeState>
}

export type BlueprintRuntimeDiagnostics = {
	events: BlueprintRuntimeEvent[]
	states: BlueprintRuntimeState[]
}

export type BlueprintRuntimeEvent = {
	context: {
		id: string
		parent_id: string | null
		user_id: string | null
	}
	data: Record<string, unknown>
	event_type: string
	id: number
	time_fired: string
}

export type BlueprintRuntimeState = {
	attributes: Record<string, unknown>
	entity_id: string
	last_changed: string
	last_updated: string
	state: string
}

export type BlueprintServiceCall = {
	domain: string
	service: string
	serviceData: Record<string, unknown>
	target: Record<string, unknown>
}

export type ServiceCallMatch = {
	data?: Record<string, unknown>
	domain?: string
	entityId?: string
	service?: string
}

export type SetStateOptions = {
	attributes?: Record<string, unknown>
	lastChangedAgeSeconds?: number
}

export type StateExpectation = {
	attributes?: Record<string, unknown>
	state?: string
}

export type WaitOptions = {
	timeoutMs?: number
}

declare module 'vitest' {
	export interface ProvidedContext {
		haBlueprintContainerName: string
	}
}

const DOCKER_EXEC_REQUEST_SCRIPT = `
import json
import sys
import urllib.error
import urllib.request

command = sys.argv[1]
method = sys.argv[2]
payload = json.loads(sys.argv[3])
url = f"http://127.0.0.1:8123/api/blueprint-test/{command}"
body = None if method == "GET" else json.dumps(payload).encode()
request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method=method)

try:
    with urllib.request.urlopen(request, timeout=60) as response:
        print(json.dumps({"status": response.status, "body": response.read().decode()}))
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "body": error.read().decode()}))
`

const DOCKER_EXEC_BRIDGE_SCRIPT = `
import json
import sys
import urllib.error
import urllib.request

for line in sys.stdin:
    request_data = json.loads(line)
    command = request_data["command"]
    method = request_data["method"]
    payload = request_data["payload"]
    url = f"http://127.0.0.1:8123/api/blueprint-test/{command}"
    body = None if method == "GET" else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method=method)

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = {"id": request_data["id"], "status": response.status, "body": response.read().decode()}
    except urllib.error.HTTPError as error:
        result = {"id": request_data["id"], "status": error.code, "body": error.read().decode()}
    except Exception as error:
        result = {"id": request_data["id"], "error": repr(error)}

    print(json.dumps(result), flush=True)
`

type DockerExecResponse = {
	body: string
	status: number
}

type BridgeResponse = {
	body?: string
	error?: string
	id: number
	status?: number
}

type PendingBridgeRequest = {
	reject(error: Error): void
	resolve(value: unknown): void
}

let sharedTransport: DockerExecBridge | undefined

export function blueprintRuntimeClient(): BlueprintRuntimeClient {
	const containerName = inject('haBlueprintContainerName')
	if (!sharedTransport || sharedTransport.containerName !== containerName) {
		sharedTransport = new DockerExecBridge(containerName)
	}
	return new DockerExecBlueprintRuntimeClient(sharedTransport)
}

export async function closeBlueprintRuntimeClient(): Promise<void> {
	const transport = sharedTransport
	sharedTransport = undefined
	await transport?.close()
}

export async function withScenarioDiagnostics<T>(entityIds: string[], run: (client: BlueprintRuntimeClient) => Promise<T>): Promise<T> {
	const client = blueprintRuntimeClient()

	try {
		await client.startEventWindow()
		return await run(client)
	} catch (error) {
		const diagnostics = await client.diagnostics()
		const relevantStates = diagnostics.states.filter((state) => entityIds.includes(state.entity_id)).sort((left, right) => left.entity_id.localeCompare(right.entity_id))
		const relevantEvents = relevantDiagnosticEvents(diagnostics.events, entityIds)
		process.stderr.write(`\n--- Home Assistant scenario states ---\n${JSON.stringify(relevantStates, null, 2)}\n`)
		process.stderr.write(`--- Home Assistant recent events ---\n${JSON.stringify(relevantEvents.slice(-60), null, 2)}\n`)
		throw error
	}
}

export function requestHomeAssistant<T = unknown>(containerName: string, command: string, payload: Record<string, unknown>, method: 'GET' | 'POST'): T {
	const result = spawnSync('docker', ['exec', containerName, 'python3', '-c', DOCKER_EXEC_REQUEST_SCRIPT, command, method, JSON.stringify(payload)], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	})

	if (result.error) {
		throw result.error
	}

	if (result.status !== 0) {
		throw new Error(`docker exec ${containerName} failed:\n${result.stdout}${result.stderr}`)
	}

	const response = JSON.parse(result.stdout) as DockerExecResponse
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`${command} failed with HTTP ${response.status}: ${response.body}`)
	}

	return JSON.parse(response.body) as T
}

class DockerExecBlueprintRuntimeClient implements BlueprintRuntimeClient {
	private eventCursor = 0
	private readonly transport: DockerExecBridge

	constructor(transport: DockerExecBridge) {
		this.transport = transport
	}

	async callService(domain: string, service: string, data: Record<string, unknown> = {}): Promise<void> {
		await this.request('call_service', { data, domain, service })
	}

	diagnostics(): Promise<BlueprintRuntimeDiagnostics> {
		return this.request<BlueprintRuntimeDiagnostics>('diagnostics', {}, 'GET')
	}

	async events(): Promise<BlueprintRuntimeEvent[]> {
		return (await this.request<{ events: BlueprintRuntimeEvent[] }>('events', { after_event_id: this.eventCursor })).events
	}

	async fireScheduledTime(time: string): Promise<number> {
		return (await this.request<{ fired: number }>('fire_scheduled_time', { time })).fired
	}

	async getState(entityId: string): Promise<BlueprintRuntimeState | null> {
		return (await this.request<{ state: BlueprintRuntimeState | null }>('get_state', { entity_id: entityId })).state
	}

	async serviceCalls(match: ServiceCallMatch = {}): Promise<BlueprintServiceCall[]> {
		return (await this.events())
			.filter((event) => event.event_type === 'call_service')
			.sort((left, right) => left.time_fired.localeCompare(right.time_fired) || left.id - right.id)
			.map(serviceCallFromEvent)
			.filter((call): call is BlueprintServiceCall => call !== null)
			.filter((call) => serviceCallMatches(call, match))
	}

	async setState(entityId: string, state: string, options: SetStateOptions = {}): Promise<void> {
		await this.request('set_state', {
			attributes: options.attributes ?? {},
			entity_id: entityId,
			...(options.lastChangedAgeSeconds === undefined ? {} : { last_changed_age_seconds: options.lastChangedAgeSeconds }),
			state,
		})
	}

	async startEventWindow(): Promise<void> {
		this.eventCursor = (await this.request<{ event_cursor: number }>('event_cursor', {})).event_cursor
	}

	async waitForActionToSettle(automationEntityIds: string[], options: WaitOptions = {}): Promise<void> {
		await this.request('settle_action', {
			after_event_id: this.eventCursor,
			automation_entity_ids: automationEntityIds,
			timeout: (options.timeoutMs ?? 500) / 1000,
		})
	}

	async waitForServiceCall(match: ServiceCallMatch, options: WaitOptions = {}): Promise<BlueprintServiceCall> {
		const deadline = Date.now() + (options.timeoutMs ?? 5_000)

		while (Date.now() < deadline) {
			const call = (await this.serviceCalls(match))[0]
			if (call) {
				return call
			}
			await delay(50)
		}

		throw new Error(`Timed out waiting for service call ${JSON.stringify(match)}`)
	}

	async waitForState(entityId: string, expected: StateExpectation, options: WaitOptions = {}): Promise<BlueprintRuntimeState> {
		const deadline = Date.now() + (options.timeoutMs ?? 5_000)

		while (Date.now() < deadline) {
			const state = await this.getState(entityId)
			if (state && stateMatches(state, expected)) {
				return state
			}
			await delay(50)
		}

		const current = await this.getState(entityId)
		throw new Error(`Timed out waiting for ${entityId} to match ${JSON.stringify(expected)}; current=${JSON.stringify(current)}`)
	}

	private request<T = unknown>(command: string, payload: Record<string, unknown>, method: 'GET' | 'POST' = 'POST'): Promise<T> {
		return this.transport.request<T>(command, payload, method)
	}
}

class DockerExecBridge {
	readonly containerName: string
	private readonly pending = new Map<number, PendingBridgeRequest>()
	private readonly process: ChildProcessWithoutNullStreams
	private nextRequestId = 1
	private stderr = ''

	constructor(containerName: string) {
		this.containerName = containerName
		this.process = spawn('docker', ['exec', '-i', containerName, 'python3', '-u', '-c', DOCKER_EXEC_BRIDGE_SCRIPT], {
			stdio: 'pipe',
		})

		createInterface({ input: this.process.stdout }).on('line', (line) => this.handleLine(line))
		this.process.stderr.on('data', (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_000)
		})
		this.process.once('error', (error) => this.rejectAll(error))
		this.process.once('exit', (code) => {
			if (this.pending.size > 0) {
				this.rejectAll(new Error(`Persistent docker exec bridge exited with code ${String(code)}.\n${this.stderr}`))
			}
		})
	}

	request<T>(command: string, payload: Record<string, unknown>, method: 'GET' | 'POST'): Promise<T> {
		const id = this.nextRequestId
		this.nextRequestId += 1

		return new Promise<T>((resolveRequest, rejectRequest) => {
			this.pending.set(id, {
				reject: rejectRequest,
				resolve: (value) => resolveRequest(value as T),
			})
			this.process.stdin.write(`${JSON.stringify({ command, id, method, payload })}\n`, (error) => {
				if (error) {
					this.pending.delete(id)
					rejectRequest(error)
				}
			})
		})
	}

	async close(): Promise<void> {
		if (this.process.exitCode !== null) {
			return
		}

		this.process.stdin.end()
		await Promise.race([
			new Promise<void>((resolveExit) => this.process.once('exit', () => resolveExit())),
			delay(2_000).then(() => {
				this.process.kill('SIGTERM')
			}),
		])
	}

	private handleLine(line: string): void {
		let response: BridgeResponse
		try {
			response = JSON.parse(line) as BridgeResponse
		} catch (error) {
			this.rejectAll(new Error(`Invalid response from persistent docker exec bridge: ${line}`, { cause: error }))
			return
		}

		const pending = this.pending.get(response.id)
		if (!pending) {
			return
		}
		this.pending.delete(response.id)

		if (response.error) {
			pending.reject(new Error(`Home Assistant bridge request failed: ${response.error}`))
			return
		}
		if (response.status === undefined || response.body === undefined) {
			pending.reject(new Error(`Incomplete Home Assistant bridge response: ${line}`))
			return
		}
		if (response.status < 200 || response.status >= 300) {
			pending.reject(new Error(`Home Assistant request failed with HTTP ${response.status}: ${response.body}`))
			return
		}

		pending.resolve(JSON.parse(response.body) as unknown)
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error)
		}
		this.pending.clear()
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function serviceCallFromEvent(event: BlueprintRuntimeEvent): BlueprintServiceCall | null {
	const domain = event.data.domain
	const service = event.data.service
	if (typeof domain !== 'string' || typeof service !== 'string') {
		return null
	}

	return {
		domain,
		service,
		serviceData: isRecord(event.data.service_data) ? event.data.service_data : {},
		target: isRecord(event.data.target) ? event.data.target : {},
	}
}

export function eventMatchesServiceCall(event: BlueprintRuntimeEvent, match: ServiceCallMatch): boolean {
	const call = event.event_type === 'call_service' ? serviceCallFromEvent(event) : null
	return call !== null && serviceCallMatches(call, match)
}

function serviceCallMatches(call: BlueprintServiceCall, match: ServiceCallMatch): boolean {
	if (match.domain && call.domain !== match.domain) {
		return false
	}
	if (match.service && call.service !== match.service) {
		return false
	}
	if (match.entityId && !entityIds(call).includes(match.entityId)) {
		return false
	}
	return match.data === undefined || partialRecordMatches(call.serviceData, match.data)
}

function entityIds(call: BlueprintServiceCall): string[] {
	const value = call.target.entity_id ?? call.serviceData.entity_id
	if (typeof value === 'string') {
		return [value]
	}
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stateMatches(state: BlueprintRuntimeState, expected: StateExpectation): boolean {
	return (expected.state === undefined || state.state === expected.state) && (expected.attributes === undefined || partialRecordMatches(state.attributes, expected.attributes))
}

function relevantDiagnosticEvents(events: BlueprintRuntimeEvent[], entityIds: string[]): BlueprintRuntimeEvent[] {
	const relevantEntities = new Set(entityIds)
	const relevantContexts = new Set<string>()
	const relevantEventIds = new Set<number>()
	let foundMore = true

	while (foundMore) {
		foundMore = false
		for (const event of events) {
			if (relevantEventIds.has(event.id)) continue
			const directlyRelevant = eventEntityIds(event).some((entityId) => relevantEntities.has(entityId))
			const contextRelevant = relevantContexts.has(event.context.id) || (event.context.parent_id !== null && relevantContexts.has(event.context.parent_id))
			if (!directlyRelevant && !contextRelevant) continue

			relevantEventIds.add(event.id)
			relevantContexts.add(event.context.id)
			if (event.context.parent_id !== null) relevantContexts.add(event.context.parent_id)
			foundMore = true
		}
	}

	return events.filter((event) => relevantEventIds.has(event.id))
}

function eventEntityIds(event: BlueprintRuntimeEvent): string[] {
	return [event.data.entity_id, recordValue(event.data.service_data, 'entity_id'), recordValue(event.data.target, 'entity_id')].flatMap((value) =>
		typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
	)
}

function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined
}

function partialRecordMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
	return Object.entries(expected).every(([key, value]) => deepEqual(actual[key], value))
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left)
		const rightKeys = Object.keys(right)
		return leftKeys.length === rightKeys.length && rightKeys.every((key) => deepEqual(left[key], right[key]))
	}
	return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
