import type { BlueprintRuntimeClient, BlueprintRuntimeState, ServiceCallMatch } from '../../harness/client.ts'
import { settle } from './timing.ts'

export type StateTransitionOptions = {
	withinMs?: number
}

export type StateHoldOptions = {
	forMs: number
}

export type StatePredicate<T> = (actual: T) => boolean
export type StateExpectation<T> = T | StatePredicate<T>

type StateExpectationOptions<T> = {
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
	const matches = options.matches ?? Object.is
	const revision = options.revision ?? ((state: BlueprintRuntimeState) => state.last_changed)
	const updates = options.updates ?? []
	const read = async (): Promise<StateObservation<T> | null> => {
		const state = await client.getState(entityId)
		return state ? { revision: revision(state), value: project(state) } : null
	}
	const expectEntityNotToChange = async (holdOptions: StateHoldOptions): Promise<void> => {
		const initial = await read()
		if (!initial) {
			throw new Error(`Expected ${description} to exist before checking for state changes`)
		}
		await expectNoChanges(read, initial, description, initial.value, holdOptions, matches)
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

		async expectNoUpdates(holdOptions: StateHoldOptions): Promise<void> {
			if (updates.length === 0) {
				throw new Error(`No service-call matches are configured for ${description}`)
			}
			await Promise.all([expectEntityNotToChange(holdOptions), ...updates.map((update) => client.expectNoServiceCall(update, { timeoutMs: holdOptions.forMs }))])
		},
	}
}

async function expectNoChanges<T>(
	read: () => Promise<StateObservation<T> | null>,
	initial: StateObservation<T>,
	description: string,
	expected: T,
	options: StateHoldOptions,
	matches: (actual: T, expected: T) => boolean
): Promise<void> {
	const deadline = Date.now() + options.forMs

	while (Date.now() < deadline) {
		await settle(Math.min(STATE_POLL_INTERVAL_MS, deadline - Date.now()))
		const current = await read()
		if (!current || !matches(current.value, expected) || current.revision !== initial.revision) {
			throw expectationError(description, 'not change from', expected, current?.value ?? null, options.forMs)
		}
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
