type SensorScenarioOptions = {
	conditionOff?: boolean
	conditionOn?: boolean
	maxOnDurationMinutes?: number
	offDelayMinutes?: number
	outputDomain?: 'input_boolean' | 'light' | 'switch'
	sensorCount?: number
	withCustomActions?: boolean
}

export type SensorScenario = ReturnType<typeof sensorScenario>

function sensorScenario(id: string, options: SensorScenarioOptions = {}) {
	const inputPrefix = `fixture_sensor_${id}`
	const sensors = Array.from({ length: options.sensorCount ?? 1 }, (_, index) => `input_boolean.${inputPrefix}_input_${index + 1}`)
	const conditionOn = options.conditionOn ? `input_boolean.${inputPrefix}_condition_on` : undefined
	const conditionOff = options.conditionOff ? `input_boolean.${inputPrefix}_condition_off` : undefined
	const outputDomain = options.outputDomain ?? 'input_boolean'

	return {
		conditionOff,
		conditionOn,
		id,
		inputs: sensors,
		maxOnDurationMinutes: options.maxOnDurationMinutes ?? 0,
		offDelayMinutes: options.offDelayMinutes ?? 0,
		outputDomain,
		entities: {
			automation: `automation.fixture_sensor_${id}`,
			marker: `switch.fixture_sensor_${id}_marker`,
			output: `${outputDomain}.fixture_sensor_${id}_state`,
			uptime: `sensor.fixture_sensor_${id}_uptime`,
		},
		withCustomActions: options.withCustomActions ?? false,
	}
}

export const SENSOR_SCENARIOS = {
	actions: sensorScenario('actions', { withCustomActions: true }),
	conditions: sensorScenario('conditions', { conditionOn: true, conditionOff: true }),
	delay: sensorScenario('delay', { conditionOn: true, offDelayMinutes: 0.1 }),
	domainBoolean: sensorScenario('domain_boolean'),
	domainLight: sensorScenario('domain_light', { outputDomain: 'light' }),
	domainSwitch: sensorScenario('domain_switch', { outputDomain: 'switch' }),
	invalid: sensorScenario('invalid', { sensorCount: 2 }),
	maxDuration: sensorScenario('max_duration', { maxOnDurationMinutes: 1, sensorCount: 2 }),
	reconcile: sensorScenario('reconcile'),
	startup: sensorScenario('startup'),
	transitions: sensorScenario('transitions', { sensorCount: 2 }),
} as const
