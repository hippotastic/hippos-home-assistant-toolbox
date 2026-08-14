export const EMA_SCENARIO = {
	entities: {
		automation: 'automation.fixture_exponential_moving_average',
		average: 'input_number.fixture_exponential_moving_average',
		input: 'sensor.fixture_exponential_moving_average',
	},
	id: 'default',
	initial: {
		automationEnabled: false,
		average: 10,
		input: '20',
	},
	periodLength: 4,
	precision: 1,
} as const

export type EmaScenario = typeof EMA_SCENARIO
