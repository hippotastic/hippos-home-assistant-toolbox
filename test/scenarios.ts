import type { DocumentOptions, SchemaOptions, ToStringOptions } from 'yaml'
import { stringify } from 'yaml'

type Automation = {
	alias: string
	id: string
	initial_state?: boolean
	use_blueprint: {
		input: Record<string, unknown>
		path: string
	}
}

type CoverScenarioOptions = {
	coverAngleHoming?: boolean
	defaultAngle?: number
	defaultAngleEntity?: string
	defaultAngleEntityInitial?: number
	defaultPosition?: number
	initialPosition?: number
	initialTilt?: number
	lockoutAngle?: number
	lockoutPosition?: number
	omitOptionalModes?: boolean
	nightAngle?: number
	nightPosition?: number
	privacyAngle?: number
	privacyPosition?: number
	sunAngle?: number
	sunAzimuth?: number
	sunElevation?: number
	sunPosition?: number
	sunSideAngle?: number
	supportsPosition?: boolean
	supportsTilt?: boolean
}

export type CoverScenario = ReturnType<typeof coverScenario>
export type IrrigationCalculationScenario = ReturnType<typeof irrigationCalculationScenario>
export type IrrigationSchedulerScenario = ReturnType<typeof irrigationSchedulerScenario>
export type SensorScenario = ReturnType<typeof sensorScenario>

export const IRRIGATION_VARIANTS = ['current', 'reference'] as const
export type IrrigationVariant = (typeof IRRIGATION_VARIANTS)[number]

function coverScenario(id: string, options: CoverScenarioOptions = {}) {
	const inputPrefix = `fixture_cover_${id}`
	const optionalModeEntity = (mode: string): string | never[] => (options.omitOptionalModes ? [] : `input_boolean.${inputPrefix}_${mode}`)
	const commonInputs: Record<string, unknown> = {
		automatic_control_enabled_entity: `input_boolean.${inputPrefix}_automatic_control`,
		cover_angle_homing: options.coverAngleHoming ?? true,
		default_angle: options.defaultAngle ?? 45,
		default_angle_entity: options.defaultAngleEntity ?? [],
		default_position: options.defaultPosition ?? 80,
		lockout_prevention_angle: options.lockoutAngle ?? 100,
		lockout_prevention_entity: optionalModeEntity('lockout'),
		lockout_prevention_position: options.lockoutPosition ?? 90,
		night_mode_angle: options.nightAngle ?? 15,
		night_mode_entity: optionalModeEntity('night'),
		night_mode_position: options.nightPosition ?? 10,
		privacy_mode_angle: options.privacyAngle ?? 25,
		privacy_mode_entity: optionalModeEntity('privacy'),
		privacy_mode_position: options.privacyPosition ?? 40,
		sun_entity: `sun.${inputPrefix}`,
		sun_protection_angle: options.sunAngle ?? 30,
		sun_protection_cover_azimuth: options.sunAzimuth ?? 180,
		sun_protection_cover_side_angle: options.sunSideAngle ?? 40,
		sun_protection_entity: optionalModeEntity('sun'),
		sun_protection_min_elevation: options.sunElevation ?? 25,
		sun_protection_position: options.sunPosition ?? 70,
	}

	return {
		id,
		commonInputs,
		controls: {
			automatic: commonInputs.automatic_control_enabled_entity as string,
			lockout: `input_boolean.${inputPrefix}_lockout`,
			night: `input_boolean.${inputPrefix}_night`,
			privacy: `input_boolean.${inputPrefix}_privacy`,
			sun: `input_boolean.${inputPrefix}_sun`,
			sunEntity: commonInputs.sun_entity as string,
		},
		initialPosition: options.initialPosition ?? 50,
		initialTilt: options.initialTilt ?? 50,
		externalAngleInitial: options.defaultAngleEntity ? (options.defaultAngleEntityInitial ?? 62) : undefined,
		supportsPosition: options.supportsPosition ?? true,
		supportsTilt: options.supportsTilt ?? true,
		entities: {
			automation: `automation.fixture_cover_${id}`,
			cover: `cover.fixture_cover_${id}`,
			helper: `input_text.fixture_cover_${id}_status`,
		},
	}
}

type SensorScenarioOptions = {
	conditionOff?: boolean
	conditionOn?: boolean
	maxOnDurationMinutes?: number
	offDelayMinutes?: number
	outputDomain?: 'input_boolean' | 'light' | 'switch'
	sensorCount?: number
	withCustomActions?: boolean
}

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
		},
		withCustomActions: options.withCustomActions ?? false,
	}
}

type IrrigationCalculationScenarioOptions = {
	baseRuntimeMinutes?: number
	intervalDays?: number
}

function irrigationCalculationScenario(id: string, options: IrrigationCalculationScenarioOptions = {}) {
	const prefix = `fixture_irrigation_calculation_${id}`
	return {
		baseRuntimeMinutes: options.baseRuntimeMinutes ?? 10,
		id,
		intervalDays: options.intervalDays ?? 1,
		sensors: {
			rainfall: `sensor.${prefix}_rainfall`,
			temperature: `sensor.${prefix}_temperature`,
		},
		variants: Object.fromEntries(
			IRRIGATION_VARIANTS.map((variant) => [
				variant,
				{
					automation: `automation.${prefix}_${variant}`,
					helper: `input_text.${prefix}_${variant}_status`,
					valve: `switch.${prefix}_${variant}_valve`,
				},
			])
		) as Record<IrrigationVariant, { automation: string; helper: string; valve: string }>,
	}
}

type IrrigationSchedulerScenarioOptions = {
	startTime?: string
	withPump?: boolean
	zoneCount?: number
}

function irrigationSchedulerScenario(id: string, options: IrrigationSchedulerScenarioOptions = {}) {
	const prefix = `fixture_irrigation_scheduler_${id}`
	const zoneCount = options.zoneCount ?? 2
	return {
		id,
		startTime: options.startTime ?? '04:37:00',
		variants: Object.fromEntries(
			IRRIGATION_VARIANTS.map((variant) => [
				variant,
				{
					automation: `automation.${prefix}_${variant}`,
					helpers: Array.from({ length: zoneCount }, (_, index) => `input_text.${prefix}_${variant}_zone_${index + 1}`),
					pump: `switch.${prefix}_${variant}_pump`,
					valves: Array.from({ length: zoneCount }, (_, index) => `switch.${prefix}_${variant}_valve_${index + 1}`),
				},
			])
		) as Record<IrrigationVariant, { automation: string; helpers: string[]; pump: string; valves: string[] }>,
		withPump: options.withPump ?? false,
		zoneCount,
	}
}

export const COVER_SCENARIOS = {
	availability: coverScenario('availability', { defaultPosition: 70, defaultAngle: 40 }),
	default: coverScenario('default', {
		defaultAngleEntity: 'input_number.fixture_cover_default_angle_override',
		defaultPosition: 80,
	}),
	fullyOpen: coverScenario('fully_open', { defaultPosition: 100, defaultAngle: 40, initialPosition: 100 }),
	homing: coverScenario('homing', { defaultPosition: 50, defaultAngle: 40 }),
	homingDisabled: coverScenario('homing_disabled', {
		coverAngleHoming: false,
		defaultPosition: 50,
		defaultAngle: 40,
	}),
	homingExtreme: coverScenario('homing_extreme', { defaultPosition: 50, defaultAngle: 0 }),
	invalidAngle: coverScenario('invalid_angle', {
		defaultAngle: 35,
		defaultAngleEntity: 'input_number.fixture_cover_invalid_angle_override',
		defaultAngleEntityInitial: -2,
		defaultPosition: 65,
	}),
	invalidHighAngle: coverScenario('invalid_high_angle', {
		defaultAngle: 35,
		defaultAngleEntity: 'input_number.fixture_cover_invalid_high_angle_override',
		defaultPosition: 65,
	}),
	lockout: coverScenario('lockout', {
		defaultPosition: 40,
		defaultAngle: 50,
		lockoutPosition: 80,
		lockoutAngle: 70,
	}),
	manual: coverScenario('manual', { defaultPosition: 70, defaultAngle: 40, initialPosition: 70, initialTilt: 40 }),
	minimal: coverScenario('minimal', { defaultPosition: 65, defaultAngle: 35, omitOptionalModes: true }),
	modes: coverScenario('modes'),
	positionOnly: coverScenario('position_only', { defaultPosition: 70, defaultAngle: 35, supportsTilt: false }),
	requiredAvailability: coverScenario('required_availability', { defaultPosition: 70, defaultAngle: 40 }),
	sun: coverScenario('sun', { sunAzimuth: 0, sunSideAngle: 40 }),
	sunNormal: coverScenario('sun_normal', { sunAzimuth: 180, sunSideAngle: 40 }),
	tolerance: coverScenario('tolerance', { defaultPosition: 52, defaultAngle: 52 }),
	tiltOnly: coverScenario('tilt_only', {
		coverAngleHoming: false,
		defaultPosition: 100,
		defaultAngle: 35,
		supportsPosition: false,
	}),
} as const

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
	triggerFilter: irrigationSchedulerScenario('trigger_filter', { zoneCount: 1 }),
} as const

export const IRRIGATION_END_TO_END = {
	id: 'end_to_end',
	sensors: {
		rainfall: 'sensor.fixture_irrigation_end_to_end_rainfall',
		temperature: 'sensor.fixture_irrigation_end_to_end_temperature',
	},
	startTime: '04:37:00',
	variants: Object.fromEntries(
		IRRIGATION_VARIANTS.map((variant) => [
			variant,
			{
				calculationAutomation: `automation.fixture_irrigation_end_to_end_calculation_${variant}`,
				helper: `input_text.fixture_irrigation_end_to_end_${variant}_status`,
				schedulerAutomation: `automation.fixture_irrigation_end_to_end_scheduler_${variant}`,
				valve: `switch.fixture_irrigation_end_to_end_${variant}_valve`,
			},
		])
	) as Record<IrrigationVariant, { calculationAutomation: string; helper: string; schedulerAutomation: string; valve: string }>,
} as const

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

function sensorAutomations(): Automation[] {
	return Object.values(SENSOR_SCENARIOS).map((scenario) => {
		const input: Record<string, unknown> = {
			condition_entities_off: scenario.conditionOff ? [scenario.conditionOff] : [],
			condition_entities_on: scenario.conditionOn ? [scenario.conditionOn] : [],
			input_sensors: scenario.inputs,
			max_on_duration_minutes: scenario.maxOnDurationMinutes,
			off_delay_minutes: scenario.offDelayMinutes,
			state_entity: scenario.entities.output,
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

function irrigationBlueprintPath(blueprint: 'irrigation_scheduler' | 'irrigation_zone_calculation', variant: IrrigationVariant): string {
	const directory = variant === 'current' ? 'hippotastic' : 'hippotastic/reference'
	return `${directory}/${blueprint}.yaml`
}

function irrigationCalculationAutomations(): Automation[] {
	return Object.values(IRRIGATION_CALCULATION_SCENARIOS).flatMap((scenario) =>
		IRRIGATION_VARIANTS.map((variant) => {
			const entities = scenario.variants[variant]
			return {
				alias: `Fixture irrigation calculation ${scenario.id} ${variant}`,
				id: objectId(entities.automation),
				initial_state: false,
				use_blueprint: {
					input: {
						base_runtime_minutes: scenario.baseRuntimeMinutes,
						max_temperature_of_last_24h_entity: scenario.sensors.temperature,
						rainfall_percentage_of_last_24h_entity: scenario.sensors.rainfall,
						status_helper_entity: entities.helper,
						valve_entity: entities.valve,
						watering_interval_days: scenario.intervalDays,
					},
					path: irrigationBlueprintPath('irrigation_zone_calculation', variant),
				},
			}
		})
	)
}

function irrigationSchedulerAutomations(): Automation[] {
	return Object.values(IRRIGATION_SCHEDULER_SCENARIOS).flatMap((scenario) =>
		IRRIGATION_VARIANTS.map((variant) => {
			const entities = scenario.variants[variant]
			return {
				alias: `Fixture irrigation scheduler ${scenario.id} ${variant}`,
				id: objectId(entities.automation),
				initial_state: false,
				use_blueprint: {
					input: {
						irrigation_start_time: scenario.startTime,
						master_pump_entity: scenario.withPump ? entities.pump : [],
						zone_status_helper_entities: entities.helpers,
					},
					path: irrigationBlueprintPath('irrigation_scheduler', variant),
				},
			}
		})
	)
}

function irrigationEndToEndAutomations(): Automation[] {
	return IRRIGATION_VARIANTS.flatMap((variant) => {
		const entities = IRRIGATION_END_TO_END.variants[variant]
		return [
			{
				alias: `Fixture irrigation end-to-end calculation ${variant}`,
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
					path: irrigationBlueprintPath('irrigation_zone_calculation', variant),
				},
			},
			{
				alias: `Fixture irrigation end-to-end scheduler ${variant}`,
				id: objectId(entities.schedulerAutomation),
				initial_state: false,
				use_blueprint: {
					input: {
						irrigation_start_time: IRRIGATION_END_TO_END.startTime,
						zone_status_helper_entities: [entities.helper],
					},
					path: irrigationBlueprintPath('irrigation_scheduler', variant),
				},
			},
		]
	})
}

function irrigationAutomations(): Automation[] {
	return [...irrigationCalculationAutomations(), ...irrigationSchedulerAutomations(), ...irrigationEndToEndAutomations()]
}

function objectId(entityId: string): string {
	return entityId.split('.', 2)[1] ?? entityId
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort()
}

export function fixtureFiles(): Record<string, string> {
	const coverScenarios = Object.values(COVER_SCENARIOS)
	const irrigationCalculationScenarios = Object.values(IRRIGATION_CALCULATION_SCENARIOS)
	const irrigationSchedulerScenarios = Object.values(IRRIGATION_SCHEDULER_SCENARIOS)
	const sensorScenarios = Object.values(SENSOR_SCENARIOS)
	const inputBooleans = unique([
		...coverScenarios.flatMap((scenario) => [scenario.controls.automatic, scenario.controls.lockout, scenario.controls.night, scenario.controls.privacy, scenario.controls.sun]),
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
		...irrigationCalculationScenarios.flatMap((scenario) => IRRIGATION_VARIANTS.map((variant) => scenario.variants[variant].helper)),
		...irrigationSchedulerScenarios.flatMap((scenario) => IRRIGATION_VARIANTS.flatMap((variant) => scenario.variants[variant].helpers)),
		...IRRIGATION_VARIANTS.map((variant) => IRRIGATION_END_TO_END.variants[variant].helper),
	].map((entityId) => [objectId(entityId), { initial: '{}', max: 255 }] as const)
	const covers = coverScenarios.map((scenario) => ({
		id: objectId(scenario.entities.cover),
		position: scenario.initialPosition,
		supports_position: scenario.supportsPosition,
		supports_tilt: scenario.supportsTilt,
		tilt: scenario.initialTilt,
	}))
	const lights = sensorScenarios.flatMap((scenario) => (scenario.outputDomain === 'light' ? [objectId(scenario.entities.output)] : []))
	const switches = sensorScenarios.flatMap((scenario) => [
		...(scenario.outputDomain === 'switch' ? [objectId(scenario.entities.output)] : []),
		...(scenario.withCustomActions ? [objectId(scenario.entities.marker)] : []),
	])
	const irrigationSwitches = [
		...irrigationCalculationScenarios.flatMap((scenario) => IRRIGATION_VARIANTS.map((variant) => scenario.variants[variant].valve)),
		...irrigationSchedulerScenarios.flatMap((scenario) => IRRIGATION_VARIANTS.flatMap((variant) => [scenario.variants[variant].pump, ...scenario.variants[variant].valves])),
		...IRRIGATION_VARIANTS.map((variant) => IRRIGATION_END_TO_END.variants[variant].valve),
	].map(objectId)
	const yamlOptions: DocumentOptions & SchemaOptions & ToStringOptions = {
		lineWidth: 0,
		sortMapEntries: true,
	}

	return {
		'automations.yaml': stringify([...coverAutomations(), ...sensorAutomations(), ...irrigationAutomations()], yamlOptions),
		'fixture_covers.yaml': stringify(covers, yamlOptions),
		'fixture_lights.yaml': stringify(unique(lights), yamlOptions),
		'fixture_states.yaml': stringify(initialFixtureStates(), yamlOptions),
		'fixture_switches.yaml': stringify(unique([...switches, ...irrigationSwitches]), yamlOptions),
		'input_booleans.yaml': stringify(Object.fromEntries(inputBooleans.map((entityId) => [objectId(entityId), { initial: false }])), yamlOptions),
		'input_numbers.yaml': stringify(
			Object.fromEntries(
				coverScenarios.flatMap((scenario) =>
					scenario.externalAngleInitial === undefined
						? []
						: [[objectId(scenario.commonInputs.default_angle_entity as string), { initial: scenario.externalAngleInitial, max: 100, min: -2, step: 1 }]]
				)
			),
			yamlOptions
		),
		'input_texts.yaml': stringify(Object.fromEntries([...inputTexts, ...irrigationInputTexts]), yamlOptions),
	}
}

export function expectedAutomationStates(): Array<{ entityId: string; state: 'off' | 'on' }> {
	return [
		...[...coverAutomations(), ...sensorAutomations()].map((automation) => ({ entityId: `automation.${automation.id}`, state: 'on' as const })),
		...irrigationAutomations().map((automation) => ({ entityId: `automation.${automation.id}`, state: 'off' as const })),
	]
}

export function expectedFixtureStateEntityIds(): string[] {
	return initialFixtureStates().map((item) => item.entity_id)
}

function initialFixtureStates(): Array<{ attributes: Record<string, unknown>; entity_id: string; state: string }> {
	const irrigationSensors = [
		...Object.values(IRRIGATION_CALCULATION_SCENARIOS).flatMap((scenario) => [scenario.sensors.rainfall, scenario.sensors.temperature]),
		IRRIGATION_END_TO_END.sensors.rainfall,
		IRRIGATION_END_TO_END.sensors.temperature,
	]
	return [
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
		{
			attributes: {},
			entity_id: 'sensor.uptime',
			state: '2000-01-01T00:00:00+00:00',
		},
	]
}
