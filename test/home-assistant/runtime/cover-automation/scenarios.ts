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
	omitModeEntities?: boolean
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

function coverScenario(id: string, options: CoverScenarioOptions = {}) {
	const inputPrefix = `fixture_cover_${id}`
	const modeEntity = (mode: string): string | never[] => (options.omitModeEntities ? [] : `input_boolean.${inputPrefix}_${mode}`)
	const commonInputs: Record<string, unknown> = {
		automatic_control_enabled_entity: `input_boolean.${inputPrefix}_automatic_control`,
		cover_angle_homing: options.coverAngleHoming ?? true,
		default_angle: options.defaultAngle ?? 45,
		default_angle_entity: options.defaultAngleEntity ?? [],
		default_position: options.defaultPosition ?? 80,
		lockout_prevention_angle: options.lockoutAngle ?? 100,
		lockout_prevention_entity: modeEntity('lockout'),
		lockout_prevention_position: options.lockoutPosition ?? 90,
		night_mode_angle: options.nightAngle ?? 15,
		night_mode_entity: modeEntity('night'),
		night_mode_position: options.nightPosition ?? 10,
		privacy_mode_angle: options.privacyAngle ?? 25,
		privacy_mode_entity: modeEntity('privacy'),
		privacy_mode_position: options.privacyPosition ?? 40,
		sun_entity: `sun.${inputPrefix}`,
		sun_protection_angle: options.sunAngle ?? 30,
		sun_protection_cover_azimuth: options.sunAzimuth ?? 180,
		sun_protection_cover_side_angle: options.sunSideAngle ?? 40,
		sun_protection_entity: modeEntity('sun'),
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
	minimal: coverScenario('minimal', { defaultPosition: 65, defaultAngle: 35, omitModeEntities: true }),
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
