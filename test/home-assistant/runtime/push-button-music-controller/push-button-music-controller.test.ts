import { describe, expect, test } from 'vitest'
import { settle } from '../helpers/timing.ts'
import { withMusicScenario } from './helpers.ts'
import { MUSIC_SCENARIOS } from './scenarios.ts'

describe("Hippo's Push-Button Music Controller", () => {
	test('starts, pauses, resumes, and cycles favorites with the configured feedback', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, doubleTap, expectHelper, mediaCalls, prepareNextAction, scenario, singleTap }) => {
			await singleTap()
			await client.waitForState(scenario.entities.player, { attributes: { volume_level: 0.12 }, state: 'playing' })
			await client.waitForState(scenario.entities.playing!, { state: 'on' })
			await client.waitForState(scenario.entities.seeking!, { state: 'off' })
			await expectHelper({ active: true, favorite: 0, paused: null })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')[0]?.serviceData).toMatchObject({
				media_content_id: 'test://success/one',
			})

			await prepareNextAction()
			await singleTap()
			await client.waitForState(scenario.entities.player, { state: 'paused' })
			await client.waitForState(scenario.entities.playing!, { state: 'off' })
			const paused = await expectHelper({ active: true, favorite: 0 })
			expect(paused.paused).toBeTypeOf('number')

			await prepareNextAction()
			await singleTap()
			await client.waitForState(scenario.entities.player, { state: 'playing' })
			await expectHelper({ active: true, favorite: 0, paused: null })
			expect((await mediaCalls()).map((call) => call.service)).toContain('media_play')

			await prepareNextAction()
			await doubleTap()
			await expectHelper({ active: true, favorite: 1, paused: null })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')[0]?.serviceData).toMatchObject({
				media_content_id: 'test://success/two',
			})
		})
	})

	test('starts Favorite 2 on a reset double-tap and wraps a known favorite', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ doubleTap, expectHelper, prepareNextAction, setHelper }) => {
			await doubleTap()
			await expectHelper({ active: true, favorite: 1 })

			await setHelper({ active: true, direction: 'up', favorite: 2, paused: null, v: 1 })
			await prepareNextAction()
			await doubleTap()
			await expectHelper({ active: true, favorite: 0 })
		})
	})

	test('skips failed favorites once and resets after complete failure', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.failover, async ({ expectHelper, logMessages, mediaCalls, singleTap }) => {
			await singleTap()
			await expectHelper({ active: true, favorite: 1 })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media').map((call) => call.serviceData)).toMatchObject([
				{ media_content_id: 'test://fail/one' },
				{ media_content_id: 'test://success/two' },
			])
			expect(await logMessages()).toEqual(expect.arrayContaining(['Favorite 1 failed to start.', 'Favorite 2 started.']))
		})

		await withMusicScenario(MUSIC_SCENARIOS.allFail, async ({ expectHelper, logMessages, mediaCalls, singleTap }) => {
			await singleTap()
			await expectHelper({ active: false, favorite: null, paused: null })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')).toHaveLength(2)
			expect(await logMessages()).toEqual(expect.arrayContaining(['All configured favorites failed; the controller was reset.']))
		})
	})

	test('retries the current favorite before the rest when resume fails', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.resumeFail, async ({ configurePlayer, expectHelper, mediaCalls, singleTap }) => {
			await configurePlayer({ resume_fails: true })
			await singleTap()
			await expectHelper({ active: true, direction: 'down', favorite: 0, paused: null })
			expect((await mediaCalls()).map((call) => call.service)).toEqual(expect.arrayContaining(['media_play', 'play_media']))
			expect((await mediaCalls()).find((call) => call.service === 'play_media')?.serviceData).toMatchObject({
				media_content_id: 'test://success/one',
			})
		})
	})

	test('alternates long-press volume direction without changing playback', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, configurePlayer, expectHelper, holdFor, mediaCalls, prepareNextAction, scenario, setHelper }) => {
			await holdFor(550)
			const firstVolume = (await client.getState(scenario.entities.player))?.attributes.volume_level
			expect(firstVolume).toBeTypeOf('number')
			expect(firstVolume as number).toBeGreaterThan(0.11)
			await expectHelper({ direction: 'down' })
			expect((await mediaCalls()).every((call) => call.service === 'volume_set')).toBe(true)

			await prepareNextAction()
			await holdFor(550)
			const secondVolume = (await client.getState(scenario.entities.player))?.attributes.volume_level
			expect(secondVolume as number).toBeLessThan(firstVolume as number)
			await expectHelper({ direction: 'up' })
			expect((await mediaCalls()).every((call) => call.service === 'volume_set')).toBe(true)

			await configurePlayer({ state: 'idle', volume_level: 0.14 })
			await setHelper({ active: false, direction: 'up', favorite: null, paused: null, v: 1 })
			await prepareNextAction()
			await holdFor(550)
			const boundaryVolume = (await client.getState(scenario.entities.player))?.attributes.volume_level
			expect(boundaryVolume as number).toBeLessThan(0.14)
			await expectHelper({ direction: 'up' })
		})
	})

	test('shares tap gestures across two buttons', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.dual, async ({ client, doubleTap, expectHelper, prepareNextAction, scenario, singleTap }) => {
			const secondButton = scenario.entities.secondButton!

			await singleTap(secondButton)
			await client.waitForState(scenario.entities.player, { state: 'playing' })
			await expectHelper({ active: true, favorite: 0 })

			await prepareNextAction()
			await singleTap()
			await client.waitForState(scenario.entities.player, { state: 'paused' })

			await prepareNextAction()
			await singleTap(secondButton)
			await client.waitForState(scenario.entities.player, { state: 'playing' })

			await prepareNextAction()
			await doubleTap(secondButton)
			await expectHelper({ active: true, favorite: 1 })
		})
	})

	test('assigns fixed hold directions to two buttons and stops at their bounds', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.dual, async ({ client, configurePlayer, expectHelper, holdFor, mediaCalls, prepareNextAction, scenario, setHelper }) => {
			const secondButton = scenario.entities.secondButton!

			await setHelper({ active: false, direction: 'down', favorite: null, paused: null, v: 1 })
			await prepareNextAction()
			await holdFor(550)
			const raisedVolume = (await client.getState(scenario.entities.player))?.attributes.volume_level
			expect(raisedVolume as number).toBeGreaterThan(0.11)
			await expectHelper({ direction: 'down' })
			expect((await mediaCalls()).every((call) => call.service === 'volume_set')).toBe(true)

			await configurePlayer({ state: 'idle', volume_level: 0.13 })
			await setHelper({ active: false, direction: 'up', favorite: null, paused: null, v: 1 })
			await prepareNextAction()
			await holdFor(550, secondButton)
			const loweredVolume = (await client.getState(scenario.entities.player))?.attributes.volume_level
			expect(loweredVolume as number).toBeLessThan(0.13)
			await expectHelper({ direction: 'up' })
			expect((await mediaCalls()).every((call) => call.service === 'volume_set')).toBe(true)

			await configurePlayer({ state: 'idle', volume_level: 0.14 })
			await prepareNextAction()
			await holdFor(350)
			expect((await client.getState(scenario.entities.player))?.attributes.volume_level).toBe(0.14)
			expect(await mediaCalls()).toHaveLength(0)

			await configurePlayer({ state: 'idle', volume_level: 0.1 })
			await prepareNextAction()
			await holdFor(350, secondButton)
			expect((await client.getState(scenario.entities.player))?.attributes.volume_level).toBe(0.1)
			expect(await mediaCalls()).toHaveLength(0)
		})
	})

	test('falls back to alternating holds when both inputs select the same button', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.duplicateButton, async ({ client, expectHelper, holdFor, logMessages, scenario }) => {
			await client.callService('automation', 'turn_off', { entity_id: scenario.entities.automation })
			await client.callService('automation', 'turn_on', { entity_id: scenario.entities.automation })
			await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
			expect(await logMessages()).toContain('The second push button matches the first; using one-button alternating volume control instead.')

			await holdFor(550)
			await expectHelper({ direction: 'down' })
		})
	})

	test('does not combine presses from different buttons into one gesture', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.dual, async ({ client, expectHelper, mediaCalls, scenario }) => {
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.button })
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.button })
			await settle(20)
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.secondButton })
			await settle(350)
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.secondButton })
			await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })

			await expectHelper({ active: true, favorite: 0 })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')).toHaveLength(1)
			expect((await mediaCalls()).filter((call) => call.service === 'volume_set')).toHaveLength(1)
		})
	})

	test('treats tap-then-hold as only a long press and ignores presses while seeking', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, expectHelper, mediaCalls, scenario }) => {
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.button })
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.button })
			await settle(20)
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.button })
			await settle(350)
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.button })
			await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
			expect((await mediaCalls()).every((call) => call.service === 'volume_set')).toBe(true)
			await expectHelper({ active: false, direction: 'down', favorite: null })
		})

		await withMusicScenario(MUSIC_SCENARIOS.slow, async ({ client, expectHelper, mediaCalls, scenario }) => {
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.button })
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.button })
			await client.waitForState(scenario.entities.player, { state: 'buffering' })
			await client.callService('input_boolean', 'turn_on', { entity_id: scenario.entities.button })
			await client.callService('input_boolean', 'turn_off', { entity_id: scenario.entities.button })
			await client.waitForActionToSettle([scenario.entities.automation], { timeoutMs: 3_000 })
			await expectHelper({ active: true, favorite: 0 })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')).toHaveLength(1)
		})
	})

	test('resets an expired pause and preserves a session through unavailability', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, configurePlayer, expectHelper, prepareNextAction, scenario, setHelper, singleTap }) => {
			await configurePlayer({ state: 'paused' })
			await setHelper({ active: true, direction: 'down', favorite: 2, paused: Math.floor(Date.now() / 1000) - 1900, v: 1 })
			await expectHelper({ active: false, direction: 'down', favorite: null, paused: null })
			await prepareNextAction()
			await singleTap()
			await expectHelper({ active: true, direction: 'down', favorite: 0, paused: null })

			await prepareNextAction()
			await configurePlayer({ state: 'unavailable' })
			await client.waitForState(scenario.entities.playing!, { state: 'off' })
			await expectHelper({ active: true, direction: 'down', favorite: 0 })
		})
	})

	test('adopts external playback, mirrors player states, and resets on idle', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, configurePlayer, expectHelper, prepareNextAction, scenario }) => {
			await configurePlayer({ state: 'playing' })
			await client.waitForState(scenario.entities.playing!, { state: 'on' })
			await expectHelper({ active: true, favorite: null, paused: null })

			await prepareNextAction()
			await configurePlayer({ state: 'buffering' })
			await client.waitForState(scenario.entities.seeking!, { state: 'on' })
			await client.waitForState(scenario.entities.playing!, { state: 'on' })

			await prepareNextAction()
			await configurePlayer({ state: 'paused' })
			await client.waitForState(scenario.entities.seeking!, { state: 'off' })
			await client.waitForState(scenario.entities.playing!, { state: 'off' })
			const paused = await expectHelper({ active: true, favorite: null })
			expect(paused.paused).toBeTypeOf('number')

			await prepareNextAction()
			await configurePlayer({ state: 'idle' })
			await expectHelper({ active: false, favorite: null, paused: null })

			await prepareNextAction()
			await configurePlayer({ state: 'paused' })
			await expectHelper({ active: false, favorite: null, paused: null })
		})
	})

	test('aborts favorite switching when existing playback cannot be paused', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.main, async ({ client, configurePlayer, expectHelper, mediaCalls, prepareNextAction, scenario, doubleTap }) => {
			await configurePlayer({ state: 'playing' })
			await expectHelper({ active: true, favorite: null })
			await configurePlayer({ pause_fails: true })
			await prepareNextAction()
			await doubleTap()

			await client.waitForState(scenario.entities.player, { state: 'playing' })
			await client.waitForState(scenario.entities.seeking!, { state: 'off' })
			await expectHelper({ active: true, favorite: null })
			expect((await mediaCalls()).filter((call) => call.service === 'play_media')).toHaveLength(0)
			expect((await mediaCalls()).map((call) => call.service)).toContain('media_pause')
		})
	})

	test('normalizes malformed state, clamps inverted bounds, and aborts an unconfirmed volume', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.malformed, async ({ expectHelper }) => {
			await expectHelper({ active: false, direction: 'up', favorite: null, paused: null, v: 1 })
		})

		await withMusicScenario(MUSIC_SCENARIOS.inverted, async ({ client, expectHelper, scenario, singleTap }) => {
			await singleTap()
			await client.waitForState(scenario.entities.player, { attributes: { volume_level: 0.5 }, state: 'playing' })
			await expectHelper({ active: true, favorite: 0 })
		})

		await withMusicScenario(MUSIC_SCENARIOS.volumeFail, async ({ client, expectHelper, mediaCalls, scenario, singleTap }) => {
			await singleTap()
			await client.waitForState(scenario.entities.player, { state: 'idle' })
			await expectHelper({ active: false, favorite: null })
			expect((await mediaCalls()).some((call) => call.service === 'play_media')).toBe(false)
		})
	})

	test('works with optional feedback outputs omitted', async () => {
		await withMusicScenario(MUSIC_SCENARIOS.optional, async ({ expectHelper, singleTap }) => {
			await singleTap()
			await expectHelper({ active: true, favorite: 0 })
		})
	})
})
