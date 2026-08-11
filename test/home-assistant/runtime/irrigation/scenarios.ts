type IrrigationCalculationScenarioOptions = {
	baseRuntimeMinutes?: number
	intervalDays?: number
}

type IrrigationSchedulerScenarioOptions = {
	startTime?: string
	withPump?: boolean
	zoneCount?: number
}

export type IrrigationCalculationScenario = ReturnType<typeof irrigationCalculationScenario>
export type IrrigationSchedulerScenario = ReturnType<typeof irrigationSchedulerScenario>

function irrigationCalculationScenario(id: string, options: IrrigationCalculationScenarioOptions = {}) {
	const prefix = `fixture_irrigation_calculation_${id}`
	return {
		baseRuntimeMinutes: options.baseRuntimeMinutes ?? 10,
		entities: {
			automation: `automation.${prefix}`,
			helper: `input_text.${prefix}_status`,
			valve: `switch.${prefix}_valve`,
		},
		id,
		intervalDays: options.intervalDays ?? 1,
		sensors: {
			rainfall: `sensor.${prefix}_rainfall`,
			temperature: `sensor.${prefix}_temperature`,
		},
	}
}

function irrigationSchedulerScenario(id: string, options: IrrigationSchedulerScenarioOptions = {}) {
	const prefix = `fixture_irrigation_scheduler_${id}`
	const zoneCount = options.zoneCount ?? 2
	return {
		entities: {
			automation: `automation.${prefix}`,
			helpers: Array.from({ length: zoneCount }, (_, index) => `input_text.${prefix}_zone_${index + 1}`),
			pump: `switch.${prefix}_pump`,
			valves: Array.from({ length: zoneCount }, (_, index) => `switch.${prefix}_valve_${index + 1}`),
		},
		id,
		startTime: options.startTime ?? '04:37:00',
		withPump: options.withPump ?? false,
		zoneCount,
	}
}

export const IRRIGATION_CALCULATION_SCENARIOS = {
	emptyHelper: irrigationCalculationScenario('empty_helper'),
	fallback: irrigationCalculationScenario('fallback'),
	formula: irrigationCalculationScenario('formula'),
	noOp: irrigationCalculationScenario('no_op'),
	reconcile: irrigationCalculationScenario('reconcile'),
} as const

export const IRRIGATION_SCHEDULER_SCENARIOS = {
	active: irrigationSchedulerScenario('active', { withPump: true, zoneCount: 2 }),
	emptyHelper: irrigationSchedulerScenario('empty_helper', { zoneCount: 1 }),
	handoff: irrigationSchedulerScenario('handoff', { zoneCount: 2 }),
	interval: irrigationSchedulerScenario('interval', { zoneCount: 2 }),
	invalid: irrigationSchedulerScenario('invalid', { zoneCount: 4 }),
	outsideWindow: irrigationSchedulerScenario('outside_window', { withPump: true, zoneCount: 1 }),
	planning: irrigationSchedulerScenario('planning', { zoneCount: 3 }),
	recentWindow: irrigationSchedulerScenario('recent_window', { withPump: true, zoneCount: 1 }),
	startup: irrigationSchedulerScenario('startup', { zoneCount: 1 }),
	timeTrigger: irrigationSchedulerScenario('time_trigger', { startTime: '04:38:00', zoneCount: 2 }),
	triggerFilter: irrigationSchedulerScenario('trigger_filter', { zoneCount: 1 }),
} as const

export const IRRIGATION_END_TO_END = {
	entities: {
		calculationAutomation: 'automation.fixture_irrigation_end_to_end_calculation',
		helper: 'input_text.fixture_irrigation_end_to_end_status',
		schedulerAutomation: 'automation.fixture_irrigation_end_to_end_scheduler',
		valve: 'switch.fixture_irrigation_end_to_end_valve',
	},
	id: 'end_to_end',
	sensors: {
		rainfall: 'sensor.fixture_irrigation_end_to_end_rainfall',
		temperature: 'sensor.fixture_irrigation_end_to_end_temperature',
	},
	startTime: '04:37:00',
} as const
