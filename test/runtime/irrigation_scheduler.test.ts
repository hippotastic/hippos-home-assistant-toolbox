import { describe, expect, test } from 'vitest'
import { withScenarioDiagnostics, type BlueprintRuntimeClient, type BlueprintServiceCall } from '../api.ts'
import { IRRIGATION_END_TO_END, IRRIGATION_SCHEDULER_SCENARIOS, IRRIGATION_VARIANTS } from '../scenarios.ts'
import { callsForEntity, normalizeServiceNames, settle } from './helpers.ts'
import { initializeSchedulerScenario, schedulerScenarioEntityIds, setAutomation, setHelper, setSwitch, waitForZoneStatus, type ZoneStatus } from './irrigation-helpers.ts'

const TIME_ZONE = 'Europe/Berlin'

describe("Hippo's Irrigation Scheduler", () => {
	test('waters the complete preplanned sequence when the configured daily time is reached', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.timeTrigger
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) =>
				JSON.stringify({
					interval: 1,
					next_end: new Date(Date.now() + (zoneIndex + 6) * 60_000).toISOString(),
					next_start: new Date(Date.now() + (zoneIndex + 5) * 60_000).toISOString(),
					runtime: 1,
					valve: scenario.variants[variant].valves[zoneIndex],
				})
			)
			await enableSchedulerVariants(client, scenario)

			const plannedEnd = Date.now() + 2_500
			const secondPlannedEnd = plannedEnd + 2_500
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				for (const zoneIndex of [0, 1]) {
					const status = await waitForScheduledStatus(client, entities.helpers[zoneIndex])
					await setHelper(client, entities.helpers[zoneIndex], {
						...status,
						next_end: new Date(zoneIndex === 0 ? plannedEnd : secondPlannedEnd).toISOString(),
						next_start: new Date(zoneIndex === 0 ? Date.now() - 60_000 : plannedEnd).toISOString(),
					})
				}
			}
			await settle(250)
			await client.clearEvents()

			try {
				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					expect((await client.getState(entities.valves[0]))?.state).toBe('off')
					expect((await client.getState(entities.valves[1]))?.state).toBe('off')
					await client.expectNoServiceCall({ domain: 'switch', entityId: entities.valves[0], service: 'turn_on' }, { timeoutMs: 150 })
				}

				expect(await client.fireScheduledTime(scenario.startTime)).toBe(2)

				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await client.waitForState(entities.valves[0], { state: 'on' })
					expect((await client.getState(entities.valves[1]))?.state).toBe('off')
				}

				await settle(Math.max(0, plannedEnd - Date.now() - 250))
				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					expect((await client.getState(entities.valves[0]))?.state).toBe('on')
					expect((await client.getState(entities.valves[1]))?.state).toBe('off')
				}

				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await client.waitForState(entities.valves[1], { state: 'on' }, { timeoutMs: 5_000 })
					await client.waitForState(entities.valves[0], { state: 'off' })
					await waitForZoneStatus(client, entities.helpers[0], (status) => typeof status.last_end === 'string')
				}

				await settle(Math.max(0, secondPlannedEnd - Date.now() - 250))
				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					expect((await client.getState(entities.valves[1]))?.state).toBe('on')
				}

				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await client.waitForState(entities.valves[1], { state: 'off' }, { timeoutMs: 5_000 })
					await waitForZoneStatus(client, entities.helpers[1], (status) => typeof status.last_end === 'string')

					const calls = (await client.serviceCalls({ domain: 'switch' })).filter((call) => entities.valves.some((entityId) => callsForEntity([call], entityId).length > 0))
					expect(normalizeServiceNames(calls)).toEqual(['switch.turn_on', 'switch.turn_off', 'switch.turn_on', 'switch.turn_off'])
				}
			} finally {
				for (const variant of IRRIGATION_VARIANTS) {
					const entities = scenario.variants[variant]
					await setAutomation(client, entities.automation, false)
					await setSwitch(client, entities.valves[0], false)
					await setSwitch(client, entities.valves[1], false)
				}
			}
		})
	})

	test('replans safely when a configured helper is manually cleared', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.emptyHelper
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant) => JSON.stringify({ interval: 1, runtime: 1, valve: scenario.variants[variant].valves[0] }))
			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				await waitForScheduledStatus(client, scenario.variants[variant].helpers[0])
			}

			for (const variant of IRRIGATION_VARIANTS) {
				await client.clearEvents()
				await setHelper(client, scenario.variants[variant].helpers[0], '')
				await waitForSchedulingStarted(client)
			}
		})
	})

	test('plans positive runtimes contiguously in stable helper order', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.planning
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) => {
				const entities = scenario.variants[variant]
				return JSON.stringify({
					custom: `zone-${zoneIndex + 1}`,
					interval: 1,
					...(zoneIndex === 2 ? { next_end: '2026-01-01T05:00:00+01:00', next_start: '2026-01-01T04:50:00+01:00' } : {}),
					runtime: [2, 1, 0][zoneIndex],
					valve: entities.valves[zoneIndex],
				})
			})

			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				const first = await waitForScheduledStatus(client, entities.helpers[0])
				const second = await waitForScheduledStatus(client, entities.helpers[1])
				const zero = await waitForZoneStatus(client, entities.helpers[2], (status) => status.next_start === undefined && status.next_end === undefined)

				expect(millisecondsBetween(first.next_start!, first.next_end!)).toBe(120_000)
				expect(millisecondsBetween(second.next_start!, second.next_end!)).toBe(60_000)
				expect(Date.parse(second.next_start!)).toBe(Date.parse(first.next_end!))
				expect(zero).toMatchObject({ custom: 'zone-3', interval: 1, runtime: 0, valve: entities.valves[2] })
			}

			const current = scenario.variants.current
			const scheduledLog = await waitForLogMessage(client, current.valves[0], 'Scheduled 2 minutes of watering')
			expect(String(scheduledLog.serviceData.message)).toContain('next configured daily start')
			await waitForLogMessage(client, current.valves[2], 'calculated runtime is 0 minutes')
		})
	})

	test('anchors watering intervals to the daily start before or after last_end', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.interval
		const previousStart = previousDailyStart(scenario.startTime)
		const lastEnds = [new Date(previousStart.getTime() - 60 * 60_000), new Date(previousStart.getTime() + 60 * 60_000)]
		const expectedStarts = [addLocalDays(previousStart, 1), addLocalDays(previousStart, 2)]

		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) => {
				const entities = scenario.variants[variant]
				return JSON.stringify({
					interval: 2,
					last_end: lastEnds[zoneIndex].toISOString(),
					runtime: 1,
					valve: entities.valves[zoneIndex],
				})
			})

			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				for (const zoneIndex of [0, 1]) {
					const status = await waitForScheduledStatus(client, entities.helpers[zoneIndex])
					expect(Math.abs(Date.parse(status.next_start!) - expectedStarts[zoneIndex].getTime())).toBeLessThan(2_000)
				}
			}
		})
	})

	test('ignores malformed, non-object, and valveless entries while clearing stale zero-runtime schedules', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.invalid
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) => {
				if (zoneIndex === 0) return 'not JSON'
				if (zoneIndex === 1) return '[]'
				if (zoneIndex === 2) return JSON.stringify({ interval: 1, runtime: 1 })
				const entities = scenario.variants[variant]
				return JSON.stringify({
					custom: 'preserved',
					interval: 1,
					next_end: '2026-01-01T05:00:00+01:00',
					next_start: '2026-01-01T04:50:00+01:00',
					runtime: 0,
					valve: entities.valves[zoneIndex],
				})
			})

			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await waitForSchedulingFinished(client)
				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[0] })).toEqual([])
				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[1] })).toEqual([])
				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[2] })).toEqual([])
				expect(await waitForZoneStatus(client, entities.helpers[3], (status) => status.next_start === undefined)).toMatchObject({
					custom: 'preserved',
					runtime: 0,
				})
			}
		})
	})

	test('stops competing zones and starts the pump before the current zone', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.active
		const now = Date.now()
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) => {
				const entities = scenario.variants[variant]
				return JSON.stringify({
					interval: 1,
					next_end: new Date(now + (zoneIndex === 0 ? 60_000 : 180_000)).toISOString(),
					next_start: new Date(now + (zoneIndex === 0 ? -60_000 : 120_000)).toISOString(),
					runtime: 1,
					valve: entities.valves[zoneIndex],
				})
			})
			for (const variant of IRRIGATION_VARIANTS) {
				await setSwitch(client, scenario.variants[variant].valves[1], true)
			}
			await client.clearEvents()

			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await client.waitForState(entities.valves[0], { state: 'on' })
				await client.waitForState(entities.valves[1], { state: 'off' })
				await waitForZoneStatus(client, entities.helpers[1], (status) => typeof status.last_end === 'string')

				const calls = (await client.serviceCalls({ domain: 'switch' })).filter((call) =>
					[entities.pump, ...entities.valves].some((entityId) => callsForEntity([call], entityId).length > 0)
				)
				expect(normalizeServiceNames(calls)).toEqual(['switch.turn_off', 'switch.turn_on', 'switch.turn_on'])
				expect(callsForEntity([calls[0]], entities.valves[1])).toHaveLength(1)
				expect(callsForEntity([calls[1]], entities.pump)).toHaveLength(1)
				expect(callsForEntity([calls[2]], entities.valves[0])).toHaveLength(1)
			}

			const current = scenario.variants.current
			await waitForLogMessage(client, current.valves[1], 'another zone is scheduled now')
			await waitForLogMessage(client, current.valves[0], 'according to schedule until')
		})
	})

	test('cleans up inside the control window but leaves devices alone outside it', async () => {
		const recent = IRRIGATION_SCHEDULER_SCENARIOS.recentWindow
		await withScenarioDiagnostics(schedulerScenarioEntityIds(recent), async (client) => {
			await initializeSchedulerScenario(client, recent, (variant) =>
				JSON.stringify({
					interval: 1,
					last_end: new Date(Date.now() - 5 * 60_000).toISOString(),
					runtime: 1,
					valve: recent.variants[variant].valves[0],
				})
			)
			for (const variant of IRRIGATION_VARIANTS) {
				await setSwitch(client, recent.variants[variant].valves[0], true)
				await setSwitch(client, recent.variants[variant].pump, true)
			}
			await client.clearEvents()
			await enableSchedulerVariants(client, recent)

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = recent.variants[variant]
				await client.waitForState(entities.valves[0], { state: 'off' })
				await client.waitForState(entities.pump, { state: 'off' })
			}
		})

		const outside = IRRIGATION_SCHEDULER_SCENARIOS.outsideWindow
		await withScenarioDiagnostics(schedulerScenarioEntityIds(outside), async (client) => {
			await initializeSchedulerScenario(client, outside, (variant) =>
				JSON.stringify({
					interval: 1,
					last_end: new Date(Date.now() - 31 * 60_000).toISOString(),
					runtime: 1,
					valve: outside.variants[variant].valves[0],
				})
			)
			for (const variant of IRRIGATION_VARIANTS) {
				await setSwitch(client, outside.variants[variant].valves[0], true)
				await setSwitch(client, outside.variants[variant].pump, true)
			}
			await client.clearEvents()
			await enableSchedulerVariants(client, outside)

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = outside.variants[variant]
				await waitForScheduledStatus(client, entities.helpers[0])
				expect((await client.getState(entities.valves[0]))?.state).toBe('on')
				expect((await client.getState(entities.pump))?.state).toBe('on')
				expect(await client.serviceCalls({ domain: 'switch', entityId: entities.valves[0] })).toEqual([])
				expect(await client.serviceCalls({ domain: 'switch', entityId: entities.pump })).toEqual([])
			}
		})
	})

	test('hands a completed zone to the next scheduled zone without the fallback path', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.handoff
		const now = Date.now()
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant, zoneIndex) => {
				const entities = scenario.variants[variant]
				return JSON.stringify({
					interval: 1,
					next_end: new Date(now + (zoneIndex === 0 ? 1_500 : 60_000)).toISOString(),
					next_start: new Date(now + (zoneIndex === 0 ? -60_000 : 1_500)).toISOString(),
					runtime: 1,
					valve: entities.valves[zoneIndex],
				})
			})

			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				await client.waitForState(scenario.variants[variant].valves[0], { state: 'on' })
			}
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await client.waitForState(entities.valves[1], { state: 'on' }, { timeoutMs: 5_000 })
				await client.waitForState(entities.valves[0], { state: 'off' })
				await waitForZoneStatus(client, entities.helpers[0], (status) => typeof status.last_end === 'string')
			}

			const logCalls = await client.serviceCalls({ domain: 'logbook', service: 'log' })
			expect(logCalls.map((call) => String(call.serviceData.message)).join(' ')).not.toContain('safety fallback')
			const current = scenario.variants.current
			await waitForLogMessage(client, current.valves[0], 'Completed scheduled watering')
		})
	})

	test('ignores schedule-only helper changes but reacts to material status changes', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.triggerFilter
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant) => JSON.stringify({ interval: 1, runtime: 1, valve: scenario.variants[variant].valves[0] }))
			await enableSchedulerVariants(client, scenario)

			const statuses = new Map<string, ZoneStatus>()
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				statuses.set(variant, await waitForScheduledStatus(client, entities.helpers[0]))
			}
			await settle(350)

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				const status = statuses.get(variant)!
				await setHelper(client, entities.helpers[0], {
					...status,
					next_end: new Date(Date.parse(status.next_end!) + 60_000).toISOString(),
					next_start: new Date(Date.parse(status.next_start!) + 60_000).toISOString(),
				})
			}
			await client.clearEvents()
			await client.expectNoServiceCall({ domain: 'logbook', service: 'log', data: { message: 'Creating or updating irrigation schedule' } }, { timeoutMs: 300 })

			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setHelper(client, entities.helpers[0], { ...statuses.get(variant)!, runtime: 2 })
			}
			await client.clearEvents()
			await waitForSchedulingStarted(client)

			await settle(250)
			for (const variant of IRRIGATION_VARIANTS) {
				await client.setState(scenario.variants[variant].helpers[0], 'unavailable')
			}
			await client.clearEvents()
			await client.expectNoServiceCall({ domain: 'logbook', service: 'log', data: { message: 'Creating or updating irrigation schedule' } }, { timeoutMs: 300 })
		})
	})

	test('waits for unavailable valves to settle before scheduling', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.startup
		await withScenarioDiagnostics(schedulerScenarioEntityIds(scenario), async (client) => {
			await initializeSchedulerScenario(client, scenario, (variant) => JSON.stringify({ interval: 1, runtime: 1, valve: scenario.variants[variant].valves[0] }))
			for (const variant of IRRIGATION_VARIANTS) {
				await client.setState(scenario.variants[variant].valves[0], 'unknown')
			}
			await client.clearEvents()

			const startedAt = Date.now()
			await enableSchedulerVariants(client, scenario)
			for (const variant of IRRIGATION_VARIANTS) {
				await waitForScheduledStatus(client, scenario.variants[variant].helpers[0])
			}
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80)
		})
	})

	test('passes calculated zone state into scheduling end to end', async () => {
		const scenario = IRRIGATION_END_TO_END
		const entityIds = [scenario.sensors.rainfall, scenario.sensors.temperature, ...IRRIGATION_VARIANTS.flatMap((variant) => Object.values(scenario.variants[variant]))]
		await withScenarioDiagnostics(entityIds, async (client) => {
			await client.setState(scenario.sensors.rainfall, '0')
			await client.setState(scenario.sensors.temperature, '30')
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				await setAutomation(client, entities.calculationAutomation, false)
				await setAutomation(client, entities.schedulerAutomation, false)
				await setSwitch(client, entities.valve, false)
				await setHelper(client, entities.helper, '{}')
				await setAutomation(client, entities.schedulerAutomation, true)
			}
			await settle(250)
			await client.clearEvents()

			for (const variant of IRRIGATION_VARIANTS) {
				await setAutomation(client, scenario.variants[variant].calculationAutomation, true)
			}
			for (const variant of IRRIGATION_VARIANTS) {
				const entities = scenario.variants[variant]
				const status = await waitForZoneStatus(
					client,
					entities.helper,
					(value) => value.runtime === 14 && typeof value.next_start === 'string' && typeof value.next_end === 'string'
				)
				expect(status).toMatchObject({ interval: 2, runtime: 14, valve: entities.valve })
				expect(millisecondsBetween(status.next_start!, status.next_end!)).toBe(14 * 60_000)
				expect((await client.getState(entities.valve))?.state).toBe('off')
			}
		})
	})
})

async function enableSchedulerVariants(
	client: BlueprintRuntimeClient,
	scenario: (typeof IRRIGATION_SCHEDULER_SCENARIOS)[keyof typeof IRRIGATION_SCHEDULER_SCENARIOS]
): Promise<void> {
	for (const variant of IRRIGATION_VARIANTS) {
		await setAutomation(client, scenario.variants[variant].automation, true)
	}
}

async function waitForScheduledStatus(client: BlueprintRuntimeClient, helper: string): Promise<ZoneStatus> {
	return waitForZoneStatus(client, helper, (status) => typeof status.next_start === 'string' && typeof status.next_end === 'string')
}

async function waitForSchedulingStarted(client: BlueprintRuntimeClient): Promise<void> {
	await client.waitForServiceCall({ domain: 'logbook', service: 'log', data: { message: 'Creating or updating irrigation schedule' } })
}

async function waitForSchedulingFinished(client: BlueprintRuntimeClient): Promise<void> {
	await client.waitForServiceCall({ domain: 'logbook', service: 'log', data: { message: 'Finished scheduling' } })
}

async function waitForLogMessage(client: BlueprintRuntimeClient, entityId: string, text: string): Promise<BlueprintServiceCall> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		const call = (await client.serviceCalls({ domain: 'logbook', entityId, service: 'log' })).find((candidate) => String(candidate.serviceData.message).includes(text))
		if (call) return call
		await settle(25)
	}
	throw new Error(`Timed out waiting for logbook message containing ${JSON.stringify(text)} for ${entityId}`)
}

function millisecondsBetween(start: string, end: string): number {
	return Date.parse(end) - Date.parse(start)
}

function previousDailyStart(time: string): Date {
	const now = new Date()
	const local = localParts(now)
	const [hour, minute, second] = time.split(':').map(Number)
	let start = zonedDate(local.year, local.month, local.day, hour, minute, second)
	if (start.getTime() > now.getTime()) {
		start = addLocalDays(start, -1)
	}
	return start
}

function addLocalDays(value: Date, days: number): Date {
	const parts = localParts(value)
	const calendarDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second))
	return zonedDate(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth() + 1, calendarDate.getUTCDate(), parts.hour, parts.minute, parts.second)
}

function zonedDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
	const target = Date.UTC(year, month - 1, day, hour, minute, second)
	let guess = target
	for (let index = 0; index < 3; index += 1) {
		const observed = localParts(new Date(guess))
		const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second)
		guess += target - observedAsUtc
	}
	return new Date(guess)
}

function localParts(value: Date): { day: number; hour: number; minute: number; month: number; second: number; year: number } {
	const parts = new Intl.DateTimeFormat('en-GB', {
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23',
		minute: '2-digit',
		month: '2-digit',
		second: '2-digit',
		timeZone: TIME_ZONE,
		year: 'numeric',
	}).formatToParts(value)
	const number = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value)
	return { day: number('day'), hour: number('hour'), minute: number('minute'), month: number('month'), second: number('second'), year: number('year') }
}
