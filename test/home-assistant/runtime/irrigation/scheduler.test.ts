import { describe, expect, test } from 'vitest'
import { withScenarioDiagnostics } from '../../harness/client.ts'
import { prepareNextAction as prepareScenarioAction } from '../helpers/actions.ts'
import { setAutomation, setHelper, setSwitch, waitForZoneHelper, withSchedulerScenario, type ZoneStatus } from './helpers.ts'
import { IRRIGATION_END_TO_END, IRRIGATION_SCHEDULER_SCENARIOS } from './scenarios.ts'

const TIME_ZONE = 'Europe/Berlin'

describe("Hippo's Irrigation Scheduler", () => {
	test('waters the complete preplanned sequence when the configured daily time is reached', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.timeTrigger,
			async ({
				expectValveToBecome,
				expectNoValveChanges,
				fireScheduledTime,
				irrigationCalls,
				prepareNextAction,
				relativeTime,
				setZoneHelper,
				startSchedulers,
				waitForValveLog,
				waitForZoneHelper,
			}) => {
				await setZoneHelper(0, {
					interval: 1,
					next_start: relativeTime({ minutes: 5 }),
					next_end: relativeTime({ minutes: 6 }),
					runtime: 1,
				})
				await setZoneHelper(1, {
					interval: 1,
					next_start: relativeTime({ minutes: 6 }),
					next_end: relativeTime({ minutes: 7 }),
					runtime: 1,
				})
				await startSchedulers()

				const plannedEnd = relativeTime({ milliseconds: 800 })
				const secondPlannedEnd = relativeTime({ milliseconds: 1600 })
				for (const zoneIndex of [0, 1]) {
					const status = await waitForZoneHelper(zoneIndex, (value) => Array.isArray(value.next))
					await setZoneHelper(zoneIndex, {
						...status,
						next: [
							zoneIndex === 0 ? relativeTime({ minutes: -1 }) : plannedEnd,
							(Date.parse(zoneIndex === 0 ? plannedEnd : secondPlannedEnd) - Date.parse(zoneIndex === 0 ? relativeTime({ minutes: -1 }) : plannedEnd)) / 1000,
							0,
						],
					})
				}
				await prepareNextAction()

				// If the daily start has not fired, expect neither planned zone to water
				await expectValveToBecome(0, 'off', { withinMs: 0 })
				await expectValveToBecome(1, 'off', { withinMs: 0 })
				await Promise.all([expectNoValveChanges(0, { forMs: 50 }), expectNoValveChanges(1, { forMs: 50 })])

				// If the daily start fires, expect the first zone to start
				// while the second zone remains off
				expect(await fireScheduledTime()).toBe(1)
				await expectValveToBecome(0, 'on')
				await expectValveToBecome(1, 'off', { withinMs: 0 })
				// Until the first planned end, expect only the first zone to remain on
				const firstHoldMs = Math.max(0, Date.parse(plannedEnd) - Date.now() - 100)
				await Promise.all([expectNoValveChanges(0, { forMs: firstHoldMs }), expectNoValveChanges(1, { forMs: firstHoldMs })])

				// At the first planned end, expect watering to continue with the second zone
				await expectValveToBecome(1, 'on', { withinMs: 5000 })
				await expectValveToBecome(0, 'off')
				await waitForZoneHelper(0, (status) => typeof status.last_end === 'string')
				// Until the second planned end, expect the second zone to remain on
				await expectValveToBecome(1, 'on', { withinMs: 0 })

				// At the final planned end, expect both zones to be off
				// and the valve calls to preserve their watering order
				await expectValveToBecome(1, 'off', { withinMs: 5000 })
				await waitForZoneHelper(1, (status) => typeof status.last_end === 'string')
				await waitForValveLog(1, 'Remaining watering demand: 1 minute')
				expect(await irrigationCalls()).toEqual([
					{ service: 'turn_on', target: 'valve:0' },
					{ service: 'turn_off', target: 'valve:0' },
					{ service: 'turn_on', target: 'valve:1' },
					{ service: 'turn_off', target: 'valve:1' },
				])
			}
		)
	})

	test('replans safely when a configured helper is manually cleared', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.emptyHelper,
			async ({ prepareNextAction, setRawZoneHelper, setZoneHelper, startSchedulers, waitForSchedulingStarted, waitForZoneHelper }) => {
				await setZoneHelper(0, { interval: 1, runtime: 1 })
				await startSchedulers()
				await waitForZoneHelper(0, (status) => Array.isArray(status.next))

				// If a configured helper is manually cleared,
				// expect the scheduler to create a fresh plan without failing
				await prepareNextAction()
				await setRawZoneHelper(0, '')
				await waitForSchedulingStarted()
			}
		)
	})

	test('plans positive runtimes contiguously in stable helper order', async () => {
		await withSchedulerScenario(IRRIGATION_SCHEDULER_SCENARIOS.planning, async ({ entities, setZoneHelper, startSchedulers, waitForZoneHelper }) => {
			await setZoneHelper(0, { custom: 'zone-1', interval: 1, runtime: 2 })
			await setZoneHelper(1, { custom: 'zone-2', interval: 1, runtime: 1 })
			await setZoneHelper(2, {
				custom: 'zone-3',
				interval: 1,
				next_start: '2026-01-01T04:50:00+01:00',
				next_end: '2026-01-01T05:00:00+01:00',
				runtime: 0,
			})

			// If zones have positive runtimes, expect contiguous plans in helper order
			// while a zero-runtime zone loses its stale schedule metadata
			await startSchedulers()
			const first = await waitForZoneHelper(0, (status) => Array.isArray(status.next))
			const second = await waitForZoneHelper(1, (status) => Array.isArray(status.next))
			const zero = await waitForZoneHelper(2, (status) => status.next === undefined)

			expect(first.custom).toBeUndefined()
			expect(second.custom).toBeUndefined()
			expect(first.next?.[1]).toBe(120)
			expect(second.next?.[1]).toBe(60)
			expect(Date.parse(second.next![0])).toBe(Date.parse(first.next![0]) + first.next![1] * 1000)
			expect(zero.custom).toBeUndefined()
			expect(typeof zero.cycle).toBe('string')
			expect(zero).toMatchObject({ interval: 1, runtime: 0, slot: 0, valve: entities.valves[2], watered: 0 })

			// Successful internal planning stays silent; calculation, execution, and
			// exceptional scheduling outcomes provide the user-facing log entries.
		})
	})

	test('anchors watering intervals to the daily start before or after last_end', async () => {
		const scenario = IRRIGATION_SCHEDULER_SCENARIOS.interval
		const previousStart = previousDailyStart(scenario.startTime)
		const lastEnds = [new Date(previousStart.getTime() - 60 * 60000), new Date(previousStart.getTime() + 60 * 60000)]
		const expectedStarts = [addLocalDays(previousStart, 1), addLocalDays(previousStart, 2)]

		await withSchedulerScenario(scenario, async ({ setZoneHelper, startSchedulers, waitForZoneHelper }) => {
			await setZoneHelper(0, { interval: 2, last_end: lastEnds[0].toISOString(), runtime: 1 })
			await setZoneHelper(1, { interval: 2, last_end: lastEnds[1].toISOString(), runtime: 1 })

			// If last watering ended before the previous daily start,
			// expect the interval to begin at that start rather than one day later
			// If it ended after the daily start, expect the next day to become the anchor
			await startSchedulers()
			for (const zoneIndex of [0, 1]) {
				const status = await waitForZoneHelper(zoneIndex, (value) => Array.isArray(value.next))
				expect(Math.abs(Date.parse(status.next![0]) - expectedStarts[zoneIndex].getTime())).toBeLessThan(2000)
			}
		})
	})

	test('distributes recalculated demand across cycle slots and explains expired demand', async () => {
		await withSchedulerScenario(IRRIGATION_SCHEDULER_SCENARIOS.splitCycle, async ({ client, setZoneHelper, startSchedulers, waitForValveLog, waitForZoneHelper }) => {
			await setZoneHelper(0, { interval: 3, max_runtime: 60, runtime: 250 })
			await startSchedulers()

			const primary = await waitForZoneHelper(0, (status) => status.next?.[1] === 3600 && status.next?.[2] === 0)
			expect(primary.watered).toBe(0)

			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, false)
			await setZoneHelper(0, { ...primary, next: undefined, slot: 1, watered: 3600 })
			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, true)
			const secondary = await waitForZoneHelper(0, (status) => status.next?.[1] === 3600 && status.next?.[2] === 1)
			expect(Date.parse(secondary.next![0]) - Date.parse(secondary.cycle!)).toBe(4 * 60 * 60 * 1000)

			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, false)
			await setZoneHelper(0, { ...secondary, next: undefined, runtime: 150, slot: 2, watered: 7200 })
			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, true)
			const reduced = await waitForZoneHelper(0, (status) => status.next?.[1] === 1800 && status.next?.[2] === 2)

			await setZoneHelper(0, { ...reduced, runtime: 250 })
			const increased = await waitForZoneHelper(0, (status) => status.next?.[1] === 3600 && status.next?.[2] === 2)
			expect(increased.watered).toBe(7200)

			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, false)
			await setZoneHelper(0, { ...increased, next: undefined, runtime: 400, slot: 6, watered: 21600 })
			await setAutomation(client, IRRIGATION_SCHEDULER_SCENARIOS.splitCycle.entities.automation, true)
			const expiredLog = await waitForValveLog(0, 'Remaining watering demand: 40 minutes')
			expect(String(expiredLog.serviceData.message)).toContain('No further run can be scheduled')
		})
	})

	test('does not shorten an active run when its calculated runtime decreases', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.splitCycle,
			async ({ expectNoValveChanges, expectValveToBecome, relativeTime, setZoneHelper, startSchedulers, waitForValveLog, waitForZoneHelper }) => {
				const runStart = relativeTime({ milliseconds: -100 })
				await setZoneHelper(1, {
					cycle: relativeTime({ minutes: -1 }),
					interval: 3,
					next: [runStart, 1.2, 0],
					runtime: 2,
					slot: 0,
					watered: 0,
				})
				await startSchedulers()
				await expectValveToBecome(1, 'on')
				const startLog = await waitForValveLog(1, 'Starting to water for 1 minute')
				expect(String(startLog.serviceData.message)).toMatch(
					/^Starting to water for 1 minute \(out of 2 minutes watering demand\)\. Scheduled end: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/
				)
				const active = await waitForZoneHelper(1, (status) => Array.isArray(status.next))
				await setZoneHelper(1, { ...active, runtime: 0 })
				await expectNoValveChanges(1, { forMs: 500 })
				await expectValveToBecome(1, 'off', { withinMs: 3000 })
				const completed = await waitForZoneHelper(1, (status) => status.next === undefined && Number(status.watered) >= 1)
				expect(completed.slot).toBe(1)
				const completionLog = await waitForValveLog(1, 'Completed 1 minute')
				expect(String(completionLog.serviceData.message)).toBe('Completed 1 minute.')
			}
		)
	})

	test('ignores malformed, non-object, and valveless entries while clearing stale zero-runtime schedules', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.invalid,
			async ({ client, entities, setRawZoneHelper, setZoneHelper, startSchedulers, waitForSchedulingFinished, waitForZoneHelper }) => {
				await setRawZoneHelper(0, 'not JSON')
				await setRawZoneHelper(1, '[]')
				await setRawZoneHelper(2, { interval: 1, runtime: 1 })
				await setZoneHelper(3, {
					custom: 'preserved',
					interval: 1,
					next_start: '2026-01-01T04:50:00+01:00',
					next_end: '2026-01-01T05:00:00+01:00',
					runtime: 0,
				})

				// If helper values are malformed, non-objects, or missing a valve,
				// expect the scheduler to ignore them without writing replacements
				// If a valid zone has zero runtime, expect stale schedule fields to be cleared
				await startSchedulers()
				await waitForSchedulingFinished()

				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[0] })).toEqual([])
				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[1] })).toEqual([])
				expect(await client.serviceCalls({ domain: 'input_text', entityId: entities.helpers[2] })).toEqual([])
				expect(await waitForZoneHelper(3, (status) => status.next_start === undefined)).toMatchObject({
					runtime: 0,
				})
				expect((await client.getState(entities.helpers[3]))!.state).not.toContain('custom')
			}
		)
	})

	test('stops competing zones and starts the pump before the current zone', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.active,
			async ({ expectValveToBecome, irrigationCalls, relativeTime, setValve, setZoneHelper, startSchedulers, waitForValveLog, waitForZoneHelper }) => {
				await setZoneHelper(0, {
					interval: 1,
					next_start: relativeTime({ minutes: -1 }),
					next_end: relativeTime({ minutes: 1 }),
					runtime: 1,
				})
				await setZoneHelper(1, {
					interval: 1,
					next_start: relativeTime({ minutes: 2 }),
					next_end: relativeTime({ minutes: 3 }),
					runtime: 1,
				})
				await setValve(1, true)

				// If one zone is scheduled now while another valve is still on,
				// expect the competing valve to stop before the pump and current zone start
				await startSchedulers()
				await expectValveToBecome(0, 'on')
				await expectValveToBecome(1, 'off')
				await waitForZoneHelper(1, (status) => typeof status.last_end === 'string')

				// A follow-up reconciliation may repeat the idempotent zone start
				expect((await irrigationCalls()).slice(0, 3)).toEqual([
					{ service: 'turn_off', target: 'valve:1' },
					{ service: 'turn_on', target: 'pump' },
					{ service: 'turn_on', target: 'valve:0' },
				])

				// If the scheduler changes active zones, expect both valves to log the reason
				await waitForValveLog(1, 'scheduled run ended or another zone is starting')
				await waitForValveLog(0, 'Starting to water for')
			}
		)
	})

	test('cleans up inside the control window but leaves devices alone outside it', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.recentWindow,
			async ({ expectPumpToBecome, expectValveToBecome, relativeTime, setPump, setValve, setZoneHelper, startSchedulers }) => {
				await setZoneHelper(0, { interval: 1, last_end: relativeTime({ minutes: -5 }), runtime: 1 })
				await setValve(0, true)
				await setPump(true)

				// If watering ended 5 minutes ago inside the 30-minute control window,
				// expect the scheduler to stop a valve and pump left on
				await startSchedulers()
				await expectValveToBecome(0, 'off')
				await expectPumpToBecome('off')
			}
		)

		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.outsideWindow,
			async ({ expectPumpToBecome, expectValveToBecome, irrigationCalls, relativeTime, setPump, setValve, setZoneHelper, startSchedulers, waitForZoneHelper }) => {
				await setZoneHelper(0, { interval: 1, last_end: relativeTime({ minutes: -31 }), runtime: 1 })
				await setValve(0, true)
				await setPump(true)

				// If watering ended 31 minutes ago outside the control window,
				// expect the scheduler to leave the valve and pump untouched
				await startSchedulers()
				await waitForZoneHelper(0, (status) => Array.isArray(status.next))
				await expectValveToBecome(0, 'on', { withinMs: 0 })
				await expectPumpToBecome('on', { withinMs: 0 })
				expect(await irrigationCalls()).toEqual([])
			}
		)
	})

	test('hands a completed zone to the next scheduled zone without the fallback path', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.handoff,
			async ({ client, expectValveToBecome, relativeTime, setZoneHelper, startSchedulers, waitForValveLog, waitForZoneHelper }) => {
				await setZoneHelper(0, {
					interval: 1,
					next_start: relativeTime({ minutes: -1 }),
					next_end: relativeTime({ milliseconds: 500 }),
					runtime: 1,
				})
				await setZoneHelper(1, {
					interval: 1,
					next_start: relativeTime({ milliseconds: 500 }),
					next_end: relativeTime({ minutes: 1 }),
					runtime: 1,
				})

				await startSchedulers()
				await expectValveToBecome(0, 'on')

				// If the active zone reaches its planned end as the next zone starts,
				// expect a direct handoff without waiting for the safety stop
				await expectValveToBecome(1, 'on', { withinMs: 5000 })
				await expectValveToBecome(0, 'off')
				await waitForZoneHelper(0, (status) => typeof status.last_end === 'string')

				// If the handoff succeeds, expect a completion log without an automatic-stop warning
				const logCalls = await client.serviceCalls({ domain: 'logbook', service: 'log' })
				expect(logCalls.map((call) => String(call.serviceData.message)).join(' ')).not.toContain('still on after watering should have ended')
				await waitForValveLog(0, 'Completed')
			}
		)
	})

	test('ignores schedule-only helper changes but reacts to material status changes', async () => {
		await withSchedulerScenario(
			IRRIGATION_SCHEDULER_SCENARIOS.triggerFilter,
			async ({ client, entities, expectNoSchedulingUpdates, prepareNextAction, setZoneHelper, startSchedulers, waitForSchedulingStarted, waitForZoneHelper }) => {
				await setZoneHelper(0, { interval: 1, runtime: 1 })
				await startSchedulers()

				const status: ZoneStatus = await waitForZoneHelper(0, (value) => Array.isArray(value.next))
				await prepareNextAction()

				// If only generated schedule timestamps change,
				// expect the scheduler not to create another plan
				await setZoneHelper(0, {
					...status,
					next: [new Date(Date.parse(status.next![0]) + 60000).toISOString(), status.next![1], status.next![2]],
				})
				// The test copy settles helper triggers for 100 ms,
				// so expect no scheduling update throughout that delayed trigger window
				await expectNoSchedulingUpdates({ forMs: 150 })

				// The calculation blueprint records sliding-window rain observations even
				// when rounded demand is unchanged; that internal-only field stays silent.
				await prepareNextAction()
				await setZoneHelper(0, { ...status, r: 12 })
				await expectNoSchedulingUpdates({ forMs: 150 })

				// If a material zone value changes, expect the scheduler to replan
				await prepareNextAction()
				await setZoneHelper(0, { ...status, runtime: 2 })
				await waitForSchedulingStarted()

				// If a helper becomes unavailable, expect no attempt to replan it
				await prepareNextAction()
				await client.setState(entities.helpers[0], 'unavailable')
				await expectNoSchedulingUpdates()
			}
		)
	})

	test('waits for unavailable valves to settle before scheduling', async () => {
		await withSchedulerScenario(IRRIGATION_SCHEDULER_SCENARIOS.startup, async ({ client, entities, setZoneHelper, startSchedulers, waitForZoneHelper }) => {
			await setZoneHelper(0, { interval: 1, runtime: 1 })
			await client.setState(entities.valves[0], 'unknown')

			// The blueprint's 30-second startup settle time is replaced with 100 ms in tests,
			// so if the valve is unavailable, expect scheduling to wait at least about 80 ms
			const startedAt = await startSchedulers()
			await waitForZoneHelper(0, (status) => Array.isArray(status.next))
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(80)
		})
	})

	test('passes calculated zone state into scheduling end to end', async () => {
		const scenario = IRRIGATION_END_TO_END
		const { entities } = scenario
		const entityIds = [scenario.sensors.rainfall, scenario.sensors.temperature, ...Object.values(entities)]
		await withScenarioDiagnostics(entityIds, async (client) => {
			await client.setState(scenario.sensors.rainfall, '0')
			await client.setState(scenario.sensors.temperature, '30')
			await setAutomation(client, entities.calculationAutomation, false)
			await setAutomation(client, entities.schedulerAutomation, false)
			await setSwitch(client, entities.valve, false)
			await setHelper(client, entities.helper, '{}')
			await setAutomation(client, entities.schedulerAutomation, true)
			await prepareScenarioAction(client, [entities.calculationAutomation, entities.schedulerAutomation])

			// If climate calculation produces a 14-minute runtime,
			// expect the scheduler to turn it into a matching plan without starting early
			await setAutomation(client, entities.calculationAutomation, true)
			const status = await waitForZoneHelper(client, entities.helper, (value) => value.runtime === 14 && Array.isArray(value.next))
			expect(status).toMatchObject({ interval: 2, runtime: 14, valve: entities.valve })
			expect(status.next?.[1]).toBe(14 * 60)
			expect((await client.getState(entities.valve))?.state).toBe('off')
		})
	})
})

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
