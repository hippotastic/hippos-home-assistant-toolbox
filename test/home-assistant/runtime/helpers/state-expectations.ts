import { eventMatchesServiceCall, type BlueprintRuntimeClient, type BlueprintRuntimeEvent, type BlueprintRuntimeState, type ServiceCallMatch } from '../../harness/client.ts'
import { settle } from './timing.ts'

export type StateTransitionOptions = {
	withinMs?: number
}

export type StateHoldOptions = {
	forMs?: number
}

export type StatePredicate<T> = (actual: T) => boolean
export type StateExpectation<T> = T | StatePredicate<T>

type StateExpectationOptions<T> = {
	automationEntityIds?: string[]
	description?: string
	matches?: (actual: T, expected: T) => boolean
	revision?: (state: BlueprintRuntimeState) => string
	updates?: ServiceCallMatch[]
}

type StateObservation<T> = {
	revision: string
	value: T
}

export const DEFAULT_STATE_TRANSITION_TIMEOUT_MS = 500

const STATE_POLL_INTERVAL_MS = 50

export function createEntityStateExpectation<T>(
	client: BlueprintRuntimeClient,
	entityId: string,
	project: (state: BlueprintRuntimeState) => T,
	options: StateExpectationOptions<T> = {}
) {
	const description = options.description ?? entityId
	const automationEntityIds = options.automationEntityIds ?? []
	const matches = options.matches ?? Object.is
	const revision = options.revision ?? ((state: BlueprintRuntimeState) => state.last_changed)
	const updates = options.updates ?? []
	const read = async (): Promise<StateObservation<T> | null> => {
		const state = await client.getState(entityId)
		return state ? { revision: revision(state), value: project(state) } : null
	}
	const expectEntityNotToChange = async (holdOptions: StateHoldOptions = {}): Promise<void> => {
		await expectNoActivity(client, automationEntityIds, entityId, read, description, holdOptions, matches)
	}

	return {
		async expectToBecome(expected: StateExpectation<T>, transitionOptions: StateTransitionOptions = {}): Promise<T> {
			const withinMs = transitionOptions.withinMs ?? DEFAULT_STATE_TRANSITION_TIMEOUT_MS
			const deadline = Date.now() + withinMs

			while (true) {
				const observation = await read()
				if (observation && expectationMatches(observation.value, expected, matches)) {
					return observation.value
				}
				if (Date.now() >= deadline) {
					throw expectationError(description, 'become', expected, observation?.value ?? null, withinMs)
				}
				await settle(Math.min(STATE_POLL_INTERVAL_MS, deadline - Date.now()))
			}
		},

		expectNoChanges: expectEntityNotToChange,

		async expectNoUpdates(holdOptions: StateHoldOptions = {}): Promise<void> {
			if (updates.length === 0) {
				throw new Error(`No service-call matches are configured for ${description}`)
			}
			await expectNoActivity(client, automationEntityIds, entityId, read, description, holdOptions, matches, updates)
		},
	}
}

async function expectNoActivity<T>(
	client: BlueprintRuntimeClient,
	automationEntityIds: string[],
	entityId: string,
	read: () => Promise<StateObservation<T> | null>,
	description: string,
	options: StateHoldOptions,
	matches: (actual: T, expected: T) => boolean,
	updates: ServiceCallMatch[] = []
): Promise<void> {
	if (options.forMs === undefined) {
		if (automationEntityIds.length === 0) {
			throw new Error(`No scenario automation is configured for the immediate ${description} assertion`)
		}
		await client.waitForActionToSettle(automationEntityIds)
		const current = await read()
		if (!current) {
			throw new Error(`Expected ${description} to exist before checking for state changes`)
		}
		assertNoRecordedActivity(await client.events(), entityId, description, updates)
		return
	}

	const initial = await read()
	if (!initial) {
		throw new Error(`Expected ${description} to exist before checking for state changes`)
	}
	const eventsBeforeHold = await client.events()
	const firstObservedEventId = eventsBeforeHold.at(-1)?.id ?? 0
	const deadline = Date.now() + options.forMs

	while (Date.now() < deadline) {
		await settle(Math.min(STATE_POLL_INTERVAL_MS, deadline - Date.now()))
		const current = await read()
		if (!current || !matches(current.value, initial.value) || current.revision !== initial.revision) {
			throw expectationError(description, 'not change from', initial.value, current?.value ?? null, options.forMs)
		}
	}

	assertNoRecordedActivity(
		(await client.events()).filter((event) => event.id > firstObservedEventId),
		entityId,
		description,
		updates
	)
}

function assertNoRecordedActivity(events: BlueprintRuntimeEvent[], entityId: string, description: string, updates: ServiceCallMatch[]): void {
	const stateChange = events.find((event) => event.event_type === 'state_changed' && event.data.entity_id === entityId)
	if (stateChange) {
		throw new Error(`Expected no ${description} state changes; recorded event=${JSON.stringify(stateChange)}`)
	}

	const serviceCall = events.find((event) => updates.some((update) => eventMatchesServiceCall(event, update)))
	if (serviceCall) {
		throw new Error(`Expected no ${description} updates; recorded event=${JSON.stringify(serviceCall)}`)
	}
}

function expectationMatches<T>(actual: T, expected: StateExpectation<T>, matches: (actual: T, expected: T) => boolean): boolean {
	return typeof expected === 'function' ? (expected as StatePredicate<T>)(actual) : matches(actual, expected)
}

function expectationError<T>(description: string, behavior: 'become' | 'not change from', expected: StateExpectation<T>, current: T | null, durationMs?: number): Error {
	const duration = durationMs === undefined ? '' : behavior === 'not change from' ? ` for ${durationMs} ms` : ` within ${durationMs} ms`
	const expectedDescription = typeof expected === 'function' ? 'a state matching the supplied predicate' : JSON.stringify(expected)
	return new Error(`Expected ${description} to ${behavior} ${expectedDescription}${duration}; current=${JSON.stringify(current)}`)
}
