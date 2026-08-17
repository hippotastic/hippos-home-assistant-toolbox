import type { DocumentOptions, SchemaOptions, ToStringOptions } from 'yaml'
import { stringify } from 'yaml'
import { COVER_SCENARIOS } from '../runtime/cover-automation/scenarios.ts'
import { EMA_SCENARIO } from '../runtime/exponential-moving-average/scenarios.ts'
import { IRRIGATION_CALCULATION_SCENARIOS, IRRIGATION_END_TO_END, IRRIGATION_SCHEDULER_SCENARIOS } from '../runtime/irrigation/scenarios.ts'
import { MUSIC_SCENARIOS } from '../runtime/push-button-music-controller/scenarios.ts'
import { SENSOR_SCENARIOS } from '../runtime/sensor-state-machine/scenarios.ts'

type Automation = {
	alias: string
	id: string
	initial_state?: boolean
	use_blueprint: {
		input: Record<string, unknown>
		path: string
	}
}

function coverAutomations(): Automation[] {
	return Object.values(COVER_SCENARIOS).map((scenario) => ({
		alias: `Fixture cover ${scenario.id}`,
		id: `fixture_cover_${scenario.id}`,
		use_blueprint: {
			input: {
				...scenario.commonInputs,
				cover_entity: scenario.entities.cover,
				cover_status_helper_entity: scenario.entities.helper,
			},
			path: 'hippotastic/cover_automation.yaml',
		},
	}))
}

function exponentialMovingAverageAutomations(): Automation[] {
	return [
		{
			alias: 'Fixture exponential moving average',
			id: objectId(EMA_SCENARIO.entities.automation),
			initial_state: EMA_SCENARIO.initial.automationEnabled,
			use_blueprint: {
				input: {
					average_entity: EMA_SCENARIO.entities.average,
					input_entity: EMA_SCENARIO.entities.input,
					period_length: EMA_SCENARIO.periodLength,
					precision: EMA_SCENARIO.precision,
				},
				path: 'hippotastic/exponential_moving_average.yaml',
			},
		},
	]
}

function legacyAdoptionAutomations(): Automation[] {
	const scenario = COVER_SCENARIOS.default
	const automation = (id: string): Automation => ({
		alias: `Fixture legacy blueprint adoption ${id}`,
		id: `fixture_legacy_blueprint_adoption_${id}`,
		initial_state: false,
		use_blueprint: {
			input: {
				...scenario.commonInputs,
				cover_entity: scenario.entities.cover,
				cover_status_helper_entity: scenario.entities.helper,
			},
			path: 'hippo/cover_automation.yaml',
		},
	})
	return [automation('one'), automation('two')]
}

function sensorAutomations(): Automation[] {
	return Object.values(SENSOR_SCENARIOS).map((scenario) => {
		const input: Record<string, unknown> = {
			condition_entities_off: scenario.conditionOff ? [scenario.conditionOff] : [],
			condition_entities_on: scenario.conditionOn ? [scenario.conditionOn] : [],
			input_sensors: scenario.inputs,
			max_on_duration_minutes: scenario.maxOnDurationMinutes,
			off_delay_minutes: scenario.offDelayMinutes,
			state_entity: scenario.entities.output,
			uptime_entity: scenario.entities.uptime,
		}

		if (scenario.withCustomActions) {
			input.on_actions = [
				{ action: 'switch.turn_on', target: { entity_id: scenario.entities.marker } },
				{ action: `${scenario.outputDomain}.turn_on`, target: { entity_id: scenario.entities.output } },
			]
			input.off_actions = [
				{ action: 'switch.turn_off', target: { entity_id: scenario.entities.marker } },
				{ action: `${scenario.outputDomain}.turn_off`, target: { entity_id: scenario.entities.output } },
			]
		}

		return {
			alias: `Fixture sensor ${scenario.id}`,
			id: `fixture_sensor_${scenario.id}`,
			use_blueprint: {
				input,
				path: 'hippotastic/sensor_state_machine.yaml',
			},
		}
	})
}

function irrigationCalculationAutomations(): Automation[] {
	return Object.values(IRRIGATION_CALCULATION_SCENARIOS).map((scenario) => ({
		alias: `Fixture irrigation calculation ${scenario.id}`,
		id: objectId(scenario.entities.automation),
		initial_state: false,
		use_blueprint: {
			input: {
				base_runtime_minutes: scenario.baseRuntimeMinutes,
				maximum_runtime_minutes: scenario.maximumRuntimeMinutes,
				max_temperature_of_last_24h_entity: scenario.sensors.temperature,
				rain_credit_percentage: scenario.rainCreditPercentage,
				rainfall_percentage_of_last_24h_entity: scenario.sensors.rainfall,
				...(scenario.withMoistureSensor ? { soil_moisture_entity: scenario.sensors.moisture } : {}),
				status_helper_entity: scenario.entities.helper,
				target_soil_moisture_percentage: scenario.targetMoisturePercentage,
				valve_entity: scenario.entities.valve,
				watering_interval_days: scenario.intervalDays,
			},
			path: 'hippotastic/irrigation_zone_calculation.yaml',
		},
	}))
}

function irrigationSchedulerAutomations(): Automation[] {
	return Object.values(IRRIGATION_SCHEDULER_SCENARIOS).map((scenario) => ({
		alias: `Fixture irrigation scheduler ${scenario.id}`,
		id: objectId(scenario.entities.automation),
		initial_state: false,
		use_blueprint: {
			input: {
				irrigation_start_time: scenario.startTime,
				master_pump_entity: scenario.withPump ? scenario.entities.pump : [],
				...(scenario.secondaryStartTime ? { secondary_irrigation_start_time: scenario.secondaryStartTime } : {}),
				zone_status_helper_entities: scenario.entities.helpers,
			},
			path: 'hippotastic/irrigation_scheduler.yaml',
		},
	}))
}

function irrigationEndToEndAutomations(): Automation[] {
	const { entities } = IRRIGATION_END_TO_END
	return [
		{
			alias: 'Fixture irrigation end-to-end calculation',
			id: objectId(entities.calculationAutomation),
			initial_state: false,
			use_blueprint: {
				input: {
					base_runtime_minutes: 10,
					max_temperature_of_last_24h_entity: IRRIGATION_END_TO_END.sensors.temperature,
					rainfall_percentage_of_last_24h_entity: IRRIGATION_END_TO_END.sensors.rainfall,
					status_helper_entity: entities.helper,
					valve_entity: entities.valve,
					watering_interval_days: 2,
				},
				path: 'hippotastic/irrigation_zone_calculation.yaml',
			},
		},
		{
			alias: 'Fixture irrigation end-to-end scheduler',
			id: objectId(entities.schedulerAutomation),
			initial_state: false,
			use_blueprint: {
				input: {
					irrigation_start_time: IRRIGATION_END_TO_END.startTime,
					zone_status_helper_entities: [entities.helper],
				},
				path: 'hippotastic/irrigation_scheduler.yaml',
			},
		},
	]
}

function irrigationAutomations(): Automation[] {
	return [...irrigationCalculationAutomations(), ...irrigationSchedulerAutomations(), ...irrigationEndToEndAutomations()]
}

function musicAutomations(): Automation[] {
	return Object.values(MUSIC_SCENARIOS).map((scenario) => ({
		alias: `Fixture music ${scenario.id}`,
		id: objectId(scenario.entities.automation),
		use_blueprint: {
			input: scenario.commonInputs,
			path: 'hippotastic/push_button_music_controller.yaml',
		},
	}))
}

function objectId(entityId: string): string {
	return entityId.split('.', 2)[1] ?? entityId
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort()
}

export function generatedFixtureFiles(): Record<string, string> {
	const coverScenarios = Object.values(COVER_SCENARIOS)
	const irrigationCalculationScenarios = Object.values(IRRIGATION_CALCULATION_SCENARIOS)
	const irrigationSchedulerScenarios = Object.values(IRRIGATION_SCHEDULER_SCENARIOS)
	const musicScenarios = Object.values(MUSIC_SCENARIOS)
	const sensorScenarios = Object.values(SENSOR_SCENARIOS)
	const inputBooleans = unique([
		...coverScenarios.flatMap((scenario) => [scenario.controls.automatic, scenario.controls.lockout, scenario.controls.night, scenario.controls.privacy, scenario.controls.sun]),
		...musicScenarios.map((scenario) => scenario.entities.button),
		...sensorScenarios.flatMap((scenario) => [
			...scenario.inputs,
			...(scenario.conditionOn ? [scenario.conditionOn] : []),
			...(scenario.conditionOff ? [scenario.conditionOff] : []),
			...(scenario.outputDomain === 'input_boolean' ? [scenario.entities.output] : []),
		]),
	])
	const inputTexts = coverScenarios.map(
		(scenario) =>
			[
				objectId(scenario.entities.helper),
				{
					initial: JSON.stringify({
						angle: scenario.initialTilt,
						modes: [],
						position: scenario.initialPosition,
					}),
					max: 255,
				},
			] as const
	)
	const irrigationInputTexts = [
		...irrigationCalculationScenarios.map((scenario) => scenario.entities.helper),
		...irrigationSchedulerScenarios.flatMap((scenario) => scenario.entities.helpers),
		IRRIGATION_END_TO_END.entities.helper,
	].map((entityId) => [objectId(entityId), { initial: '{}', max: 255 }] as const)
	const musicInputTexts = musicScenarios.map((scenario) => [objectId(scenario.entities.helper), { initial: scenario.initial.helper, max: 255 }] as const)
	const covers = coverScenarios.map((scenario) => ({
		id: objectId(scenario.entities.cover),
		position: scenario.initialPosition,
		supports_position: scenario.supportsPosition,
		supports_tilt: scenario.supportsTilt,
		tilt: scenario.initialTilt,
	}))
	const lights = sensorScenarios.flatMap((scenario) => (scenario.outputDomain === 'light' ? [objectId(scenario.entities.output)] : []))
	const musicLights = musicScenarios.flatMap((scenario) => (scenario.entities.playing ? [objectId(scenario.entities.playing)] : []))
	const switches = sensorScenarios.flatMap((scenario) => [
		...(scenario.outputDomain === 'switch' ? [objectId(scenario.entities.output)] : []),
		...(scenario.withCustomActions ? [objectId(scenario.entities.marker)] : []),
	])
	const musicSwitches = musicScenarios.flatMap((scenario) => (scenario.entities.seeking ? [objectId(scenario.entities.seeking)] : []))
	const irrigationSwitches = [
		...irrigationCalculationScenarios.map((scenario) => scenario.entities.valve),
		...irrigationSchedulerScenarios.flatMap((scenario) => [scenario.entities.pump, ...scenario.entities.valves]),
		IRRIGATION_END_TO_END.entities.valve,
	].map(objectId)
	const yamlOptions: DocumentOptions & SchemaOptions & ToStringOptions = {
		lineWidth: 0,
		sortMapEntries: true,
	}

	return {
		'automations.yaml': stringify(
			[...coverAutomations(), ...exponentialMovingAverageAutomations(), ...legacyAdoptionAutomations(), ...sensorAutomations(), ...irrigationAutomations(), ...musicAutomations()],
			yamlOptions
		),
		'fixture_covers.yaml': stringify(covers, yamlOptions),
		'fixture_lights.yaml': stringify(unique([...lights, ...musicLights]), yamlOptions),
		'fixture_media_players.yaml': stringify(
			musicScenarios.map((scenario) => ({
				id: objectId(scenario.entities.player),
				state: scenario.initial.playerState,
				volume_level: scenario.initial.volume,
			})),
			yamlOptions
		),
		'fixture_states.yaml': stringify(initialFixtureStates(), yamlOptions),
		'fixture_switches.yaml': stringify(unique([...switches, ...irrigationSwitches, ...musicSwitches]), yamlOptions),
		'input_booleans.yaml': stringify(Object.fromEntries(inputBooleans.map((entityId) => [objectId(entityId), { initial: false }])), yamlOptions),
		'input_numbers.yaml': stringify(
			Object.fromEntries([
				...coverScenarios.flatMap((scenario) =>
					scenario.externalAngleInitial === undefined
						? []
						: [[objectId(scenario.commonInputs.default_angle_entity as string), { initial: scenario.externalAngleInitial, max: 100, min: -2, step: 1 }]]
				),
				[objectId(EMA_SCENARIO.entities.average), { initial: EMA_SCENARIO.initial.average, max: 1000, min: -1000, step: 0.1 }],
			]),
			yamlOptions
		),
		'input_texts.yaml': stringify(Object.fromEntries([...inputTexts, ...irrigationInputTexts, ...musicInputTexts]), yamlOptions),
	}
}

export function expectedAutomationStates(): Array<{ entityId: string; state: 'off' | 'on' }> {
	return [
		...[...coverAutomations(), ...sensorAutomations()].map((automation) => ({ entityId: `automation.${automation.id}`, state: 'on' as const })),
		...exponentialMovingAverageAutomations().map((automation) => ({
			entityId: `automation.${automation.id}`,
			state: EMA_SCENARIO.initial.automationEnabled ? ('on' as const) : ('off' as const),
		})),
		...legacyAdoptionAutomations().map((automation) => ({ entityId: `automation.${automation.id}`, state: 'off' as const })),
		...irrigationAutomations().map((automation) => ({ entityId: `automation.${automation.id}`, state: 'off' as const })),
		...musicAutomations().map((automation) => ({ entityId: `automation.${automation.id}`, state: 'on' as const })),
	]
}

export function expectedFixtureStateEntityIds(): string[] {
	return initialFixtureStates().map((item) => item.entity_id)
}

function initialFixtureStates(): Array<{ attributes: Record<string, unknown>; entity_id: string; state: string }> {
	const irrigationSensors = [
		...Object.values(IRRIGATION_CALCULATION_SCENARIOS).flatMap((scenario) => [scenario.sensors.moisture, scenario.sensors.rainfall, scenario.sensors.temperature]),
		IRRIGATION_END_TO_END.sensors.rainfall,
		IRRIGATION_END_TO_END.sensors.temperature,
	]
	return [
		{
			attributes: {},
			entity_id: EMA_SCENARIO.entities.input,
			state: EMA_SCENARIO.initial.input,
		},
		...Object.values(COVER_SCENARIOS).map((scenario) => ({
			attributes: { azimuth: 180, elevation: 10 },
			entity_id: scenario.controls.sunEntity,
			state: 'above_horizon',
		})),
		...irrigationSensors.map((entityId) => ({
			attributes: {},
			entity_id: entityId,
			state: entityId.endsWith('_rainfall') ? '0' : '20',
		})),
		...Object.values(SENSOR_SCENARIOS).map((scenario) => ({
			attributes: {},
			entity_id: scenario.entities.uptime,
			state: '2000-01-01T00:00:00+00:00',
		})),
	]
}
