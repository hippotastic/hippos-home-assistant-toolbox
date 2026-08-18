export type MusicControllerState = {
	active: boolean
	direction: 'down' | 'up'
	favorite: number | null
	paused: number | null
	v: 1
}

type MusicScenarioOptions = {
	feedback?: boolean
	initialHelper?: MusicControllerState | string
	initialPlayerState?: string
	initialVolume?: number
	maximumVolume?: number
	minimumVolume?: number
	secondButton?: boolean | 'same'
	shuffleFavorites?: boolean
	startVolume?: number
	volumeSetFails?: boolean
}

export type MusicScenario = ReturnType<typeof musicScenario>

function favorite(id: string, title: string) {
	return {
		media: {
			entity_id: 'media_player.picker_source_is_ignored',
			media_content_id: id,
			media_content_type: 'playlist',
			metadata: { media_class: 'playlist', title },
		},
	}
}

function musicScenario(id: string, favoriteIds: string[], options: MusicScenarioOptions = {}) {
	const prefix = `fixture_music_${id}`
	const feedback = options.feedback ?? true
	const button = `input_boolean.${prefix}_button`
	const secondButton = options.secondButton === true ? `input_boolean.${prefix}_second_button` : options.secondButton === 'same' ? button : undefined
	const helper =
		options.initialHelper ??
		({
			active: false,
			direction: 'up',
			favorite: null,
			paused: null,
			v: 1,
		} satisfies MusicControllerState)

	return {
		id,
		commonInputs: {
			button_entity: button,
			double_tap_gap_milliseconds: 120,
			favorites: favoriteIds.map((favoriteId, index) => favorite(favoriteId, `Favorite ${index + 1}`)),
			full_volume_fade_seconds: 1,
			long_press_milliseconds: 200,
			maximum_volume: options.maximumVolume ?? 14,
			media_player_entity: `media_player.${prefix}_player`,
			minimum_volume: options.minimumVolume ?? 10,
			playing_feedback_entity: feedback ? `light.${prefix}_playing` : [],
			second_button_entity: secondButton ?? [],
			seeking_feedback_entity: feedback ? `switch.${prefix}_seeking` : [],
			...(options.shuffleFavorites === undefined ? {} : { shuffle_favorites: options.shuffleFavorites }),
			start_volume: options.startVolume ?? 12,
			status_helper_entity: `input_text.${prefix}_status`,
		},
		entities: {
			automation: `automation.${prefix}`,
			button,
			helper: `input_text.${prefix}_status`,
			player: `media_player.${prefix}_player`,
			playing: feedback ? `light.${prefix}_playing` : undefined,
			secondButton,
			seeking: feedback ? `switch.${prefix}_seeking` : undefined,
		},
		favoriteIds,
		initial: {
			helper: typeof helper === 'string' ? helper : JSON.stringify(helper),
			playerState: options.initialPlayerState ?? 'idle',
			volume: options.initialVolume ?? 0.11,
			volumeSetFails: options.volumeSetFails ?? false,
		},
	}
}

export const MUSIC_SCENARIOS = {
	allFail: musicScenario('all_fail', ['test://fail/one', 'test://fail/two']),
	dual: musicScenario('dual', ['test://success/one', 'test://success/two', 'test://success/three'], { secondButton: true }),
	duplicateButton: musicScenario('duplicate_button', ['test://success/one'], { secondButton: 'same' }),
	failover: musicScenario('failover', ['test://fail/one', 'test://success/two', 'test://success/three']),
	inverted: musicScenario('inverted', ['test://success/one'], {
		initialVolume: 0.2,
		maximumVolume: 10,
		minimumVolume: 50,
		startVolume: 80,
	}),
	main: musicScenario('main', ['test://success/one', 'test://success/two', 'test://success/three']),
	malformed: musicScenario('malformed', ['test://success/one'], { initialHelper: 'not-json' }),
	optional: musicScenario('optional', ['test://success/one'], { feedback: false }),
	resumeFail: musicScenario('resume_fail', ['test://success/one', 'test://success/two'], {
		initialHelper: { active: true, direction: 'down', favorite: 0, paused: null, v: 1 },
		initialPlayerState: 'paused',
		initialVolume: 0.13,
	}),
	shuffle: musicScenario('shuffle', ['test://fail/one', 'test://success/two'], { shuffleFavorites: true }),
	slow: musicScenario('slow', ['test://slow/one', 'test://success/two']),
	volumeFail: musicScenario('volume_fail', ['test://success/one'], { initialVolume: 0.08, volumeSetFails: true }),
} as const
