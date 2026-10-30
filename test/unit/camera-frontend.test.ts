/* Method references are compared or passed to Reflect.apply with an explicit receiver. */
/* eslint-disable @typescript-eslint/unbound-method */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCameraFrontend } from '../../tools/frontend/bundle.ts'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(`${root}custom_components/hippos_toolbox/frontend/cameras.js`, 'utf8')
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const windows: JSDOM[] = []

afterEach(() => {
	for (const dom of windows.splice(0)) dom.window.close()
})

async function fixture({ deferOpen = false, deferSubscription = false, rejectSubscription = false, deferApp = false, deferConnection = false, ios = false } = {}) {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://ha.example/', runScripts: 'outside-only', pretendToBeVisual: true })
	windows.push(dom)
	const w = dom.window
	if (ios) Object.defineProperty(w.navigator, 'userAgent', { value: 'iPhone' })
	const logs: unknown[][] = []
	Object.assign(w, {
		console: {
			info: (...args: unknown[]) => {
				logs.push(args)
			},
			warn: (...args: unknown[]) => {
				logs.push(args)
			},
		},
	})
	const intervals = new Set<() => void>()
	w.setInterval = (callback: () => void) => {
		intervals.add(callback)
		return intervals.size
	}
	w.clearInterval = () => intervals.clear()
	w.requestAnimationFrame = () => 1
	w.cancelAnimationFrame = () => undefined
	let now = 100000
	w.Date.now = () => now
	let timerId = 0
	type ScheduledTimeout = { callback: () => void; due: number }
	const timeouts = new Map<number, ScheduledTimeout>()
	w.setTimeout = (callback: () => void, delay = 0) => {
		const id = ++timerId
		timeouts.set(id, { callback, due: now + delay })
		return id
	}
	w.clearTimeout = (id?: number) => {
		if (id !== undefined) timeouts.delete(id)
	}
	const calls: Array<{ type: string; stream_id?: string; entity_id?: string; path?: string }> = []
	let subscription: ((settings: unknown) => void) | undefined
	const callbacks: NonNullable<typeof subscription>[] = []
	const settingsRequests: Array<{ command: { type: string; protocol: number }; options: { resubscribe: boolean } }> = []
	let finishSubscription: (() => void) | undefined
	let finishOpen: (() => void) | undefined
	let unsubscribed = 0
	let subscriptions = 0
	let sequence = 0
	const subscribeMessage = async (
		callback: NonNullable<typeof subscription>,
		command: (typeof settingsRequests)[number]['command'],
		options: (typeof settingsRequests)[number]['options']
	) => {
		subscriptions++
		subscription = callback
		callbacks.push(callback)
		settingsRequests.push({ command, options })
		if (rejectSubscription) throw new Error('Settings subscription unavailable')
		if (deferSubscription)
			await new Promise<void>((resolve) => {
				finishSubscription = resolve
			})
		return () => {
			unsubscribed++
			return Promise.resolve()
		}
	}
	const conn = new w.EventTarget()
	Object.assign(conn, { subscribeMessage })
	const finishConnection = () => Object.assign(w, { hassConnection: Promise.resolve({ conn }) })
	if (!deferConnection) finishConnection()
	class CameraStream extends w.HTMLElement {
		stateObj = { entity_id: 'camera.front_door' }
		_capabilities = { frontend_stream_types: [] as string[] }
		_posterUrl: string | undefined
		updateComplete = Promise.resolve()
		fitMode = 'cover'
		_connection = { hassUrl: (path: string) => new URL(path, 'http://ha.example/').href }
		_api = {
			callWS: async (command: (typeof calls)[number]) => {
				calls.push(command)
				if (command.type.endsWith('/open')) {
					const id = `session-${++sequence}`
					if (deferOpen)
						await new Promise<void>((resolve) => {
							finishOpen = resolve
						})
					return { stream_id: id, path: `/api/hippos_toolbox/camera_stream/${command.entity_id}?stream_id=${id}&authSig=test` }
				}
				if (command.type.endsWith('/stop')) return { stopped: true }
				return { path: `${command.path}&authSig=test` }
			},
		}
		constructor() {
			super()
			this.attachShadow({ mode: 'open' }).innerHTML = '<img>'
		}
		_renderStream(_transport: { type: string }) {
			return { strings: ['<img .src=', '>'], values: [`/api/camera_proxy_stream/${this.stateObj.entity_id}?token=old`] as unknown[] }
		}
		requestUpdate() {
			queueMicrotask(() => {
				const result = this._renderStream({ type: 'mjpeg' })
				const image = this.shadowRoot!.querySelector('img')
				if (image && result.values[0] !== Symbol.for('lit-noChange')) image.src = result.values[0] as string
			})
		}
	}
	class Dialog extends w.HTMLElement {
		_entityId = 'camera.front_door'
		_currView = 'info'
		_fill = false
		showDialog(params: { entityId: string }) {
			this._entityId = params.entityId
		}
		requestUpdate() {
			this._fill = Boolean(this._fill)
		}
	}
	w.customElements.define('ha-camera-stream', CameraStream)
	w.customElements.define('ha-more-info-dialog', Dialog)
	const dialog = new Dialog()
	const camera = new CameraStream()
	dialog.append(camera)
	w.document.body.append(dialog)
	const originalRender = CameraStream.prototype._renderStream
	const originalDialog = Dialog.prototype.showDialog
	const originalAttach = w.HTMLElement.prototype.attachShadow
	const originalDefine = w.customElements.define
	const registry = w.customElements
	const finishApp = () => {
		Object.defineProperty(w, 'customElements', { configurable: true, value: registry })
		registry.define('home-assistant', class extends w.HTMLElement {})
	}
	if (deferApp) {
		// HA replaces the native registry during boot. A whenDefined promise on
		// that old registry never resolves when the app uses its replacement.
		Object.defineProperty(w, 'customElements', {
			configurable: true,
			value: {
				get: registry.get.bind(registry),
				whenDefined: (name: string) => (name === 'home-assistant' ? new Promise(() => undefined) : registry.whenDefined(name)),
			},
		})
	} else finishApp()
	const dispose = () => w.eval("globalThis[Symbol.for('hippo.toolbox.cameras')]?.dispose()") as void
	const install = async () => {
		w.eval(source)
		await flush()
	}
	await install()
	const send = async (payload: unknown) => {
		subscription!(payload)
		await flush()
		camera.requestUpdate()
		await flush()
	}
	return {
		w,
		conn,
		camera,
		dialog,
		calls,
		logs,
		intervals,
		callbacks,
		settingsRequests,
		originalRender,
		originalDialog,
		originalAttach,
		originalDefine,
		send,
		settings: (zoom: boolean, recovery: boolean, cleanup: boolean) => send({ protocol: 1, camera_zoom: zoom, camera_recovery: recovery, camera_stream_cleanup: cleanup }),
		tick: async (elapsed = 2000) => {
			now += elapsed
			for (const [id, timer] of [...timeouts]) {
				if (timer.due <= now) {
					timeouts.delete(id)
					timer.callback()
				}
			}
			await flush()
			for (const callback of [...intervals]) callback()
			await flush()
		},
		finishOpen: () => finishOpen!(),
		finishSubscription: () => finishSubscription!(),
		finishApp,
		finishConnection,
		pendingTimeouts: () => timeouts.size,
		install,
		dispose,
		counts: () => ({ subscriptions, unsubscribed }),
		rejectSubscription: () => {
			rejectSubscription = true
		},
	}
}

async function zoomFixture({ ios = false, playerTag = '', reducedMotion = false } = {}) {
	const f = await fixture({ ios })
	let media: HTMLImageElement | HTMLVideoElement = f.camera.shadowRoot!.querySelector('img')!
	if (playerTag) {
		const player = f.w.document.createElement(playerTag)
		media.remove()
		media = f.w.document.createElement('video')
		player.attachShadow({ mode: 'open' }).append(media)
		f.camera.shadowRoot!.append(player)
	}
	let frameTime = 0
	let frameId = 0
	const frames = new Map<number, FrameRequestCallback>()
	f.w.requestAnimationFrame = (callback) => {
		frames.set(++frameId, callback)
		return frameId
	}
	f.w.cancelAnimationFrame = (id) => frames.delete(id)
	Object.defineProperty(f.w.performance, 'now', { value: () => frameTime })
	f.w.matchMedia = () => ({ matches: reducedMotion }) as MediaQueryList
	const view = () => {
		const values = /translate(?:3d)?\(([-\d.]+)px, ([-\d.]+)px(?:, 0)?\) scale\(([-\d.]+)\)/.exec(media.style.transform)
		return values ? { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) } : { x: 0, y: 0, scale: 1 }
	}
	const Rect = f.w.DOMRect as typeof DOMRect
	media.getBoundingClientRect = () => {
		const { x, y, scale } = view()
		return new Rect(100 + x - (400 * (scale - 1)) / 2, 200 + y - (200 * (scale - 1)) / 2, 400 * scale, 200 * scale)
	}
	f.camera.getBoundingClientRect = () => new Rect(100, 200, 400, 200)
	const pointer = (type: string, { pointerId = 1, pointerType = 'touch', clientX = 300, clientY = 300, button = 0 } = {}) => {
		// jsdom has no PointerEvent constructor; supply its fields on a mouse event.
		const event = new f.w.MouseEvent(type, { clientX, clientY, button, bubbles: true, composed: true, cancelable: true })
		Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType }, timeStamp: { value: f.w.Date.now() } })
		media.dispatchEvent(event)
		return event
	}
	const frame = (elapsed = 220) => {
		frameTime += elapsed
		for (const [id, callback] of [...frames]) {
			// A callback earlier in this frame may cancel a later callback.
			if (!frames.delete(id)) continue
			callback(frameTime)
		}
	}
	await f.settings(true, false, false)
	frame(0)
	return {
		...f,
		media,
		view,
		pointer,
		tap: (clientX = 300, clientY = 300, pointerType = 'touch') => {
			pointer('pointerdown', { clientX, clientY, pointerType })
			pointer('pointerup', { clientX, clientY, pointerType })
		},
		frame,
	}
}

describe('camera double-tap zoom', () => {
	test.each([
		{ ios: false, playerTag: '' },
		{ ios: true, playerTag: '' },
		{ ios: false, playerTag: 'ha-hls-player' },
		{ ios: true, playerTag: 'ha-hls-player' },
		{ ios: false, playerTag: 'ha-web-rtc-player' },
		{ ios: true, playerTag: 'ha-web-rtc-player' },
	])('animates into the tapped detail and back to the overview (%j)', async (options) => {
		const f = await zoomFixture(options)
		let ancestorGestures = 0
		f.dialog.addEventListener('pointerdown', () => ancestorGestures++)
		f.dialog.addEventListener('pointerup', () => ancestorGestures++)
		f.tap(350, 320)
		f.frame()
		expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
		await f.tick(100)
		f.tap(350, 320)
		f.frame(110)
		expect(f.view()).toEqual({ scale: 1.875, x: -87.5, y: -35 })
		f.frame(110)
		expect(f.view()).toEqual({ scale: 2, x: -100, y: -40 })
		// A browser's compatibility dblclick must not apply the gesture twice.
		f.media.dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true, clientX: 350, clientY: 320 }))
		f.frame()
		expect(f.view()).toEqual({ scale: 2, x: -100, y: -40 })
		f.tap(300, 300)
		await f.tick(100)
		f.tap(300, 300)
		f.frame()
		expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
		expect(ancestorGestures).toBe(0)
		f.dispose()
	})

	test.each(['touch', 'mouse', 'pen'])('clamps zoom near the image edges for %s', async (pointerType) => {
		const f = await zoomFixture()
		f.tap(490, 390, pointerType)
		f.tap(490, 390, pointerType)
		f.frame()
		expect(f.view()).toEqual({ scale: 2, x: -200, y: -100 })
		f.dispose()
	})

	test.each(['slow', 'far apart', 'long press', 'drag', 'drag back', 'moved release', 'pointercancel', 'lostpointercapture', 'different pointer types', 'secondary button'])(
		'does not zoom for %s, and recognizes a fresh pair afterwards',
		async (gesture) => {
			const f = await zoomFixture()
			f.tap()
			if (gesture === 'slow') await f.tick(500)
			const options = {
				clientX: gesture === 'far apart' ? 400 : 300,
				pointerType: gesture === 'different pointer types' ? 'mouse' : 'touch',
				button: gesture === 'secondary button' ? 2 : 0,
			}
			f.pointer('pointerdown', options)
			if (gesture === 'long press') await f.tick(500)
			if (gesture === 'drag' || gesture === 'drag back') f.pointer('pointermove', { clientX: 340 })
			if (gesture === 'drag back') f.pointer('pointermove')
			f.pointer(gesture === 'pointercancel' || gesture === 'lostpointercapture' ? gesture : 'pointerup', {
				...options,
				clientX: gesture === 'drag' || gesture === 'moved release' ? 340 : options.clientX,
			})
			f.frame()
			expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
			await f.tick(500)
			f.tap()
			f.tap()
			f.frame()
			expect(f.view().scale).toBe(2)
			f.dispose()
		}
	)

	test('preserves pan and pinch, and resets a manually zoomed view on double-tap', async () => {
		const f = await zoomFixture()
		f.tap(350, 320)
		f.tap(350, 320)
		f.frame()
		f.pointer('pointerdown')
		f.pointer('pointermove', { clientX: 330, clientY: 320 })
		f.pointer('pointerup', { clientX: 330, clientY: 320 })
		expect(f.view()).toEqual({ scale: 2, x: -70, y: -20 })
		f.tap()
		f.pointer('pointerdown', { clientX: 250 })
		f.pointer('pointerdown', { pointerId: 2, clientX: 350 })
		f.pointer('pointermove', { pointerId: 2, clientX: 450 })
		f.pointer('pointerup', { pointerId: 2, clientX: 450 })
		f.pointer('pointerup', { clientX: 250 })
		f.tap()
		f.frame()
		expect(f.view().scale).toBe(4)
		f.tap()
		f.frame()
		expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
		f.dispose()
	})

	test('wheel zoom invalidates a preceding tap and double-tap resets fractional zoom', async () => {
		const f = await zoomFixture()
		f.tap()
		const event = new f.w.WheelEvent('wheel', { cancelable: true, deltaY: -100, clientX: 350, clientY: 320 })
		f.media.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		const scale = f.view().scale
		expect(scale).toBeGreaterThan(1)
		f.tap()
		f.frame()
		expect(f.view().scale).toBe(scale)
		f.tap()
		f.frame()
		expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
		f.dispose()
	})

	test.each(['pointer', 'wheel', 'resize'])('interrupts animation at the current view on %s', async (interaction) => {
		const f = await zoomFixture()
		f.tap()
		f.tap()
		f.frame(110)
		expect(f.view().scale).toBe(1.875)
		if (interaction === 'pointer') {
			f.pointer('pointerdown')
			f.pointer('pointermove', { clientX: 320 })
			expect(f.view()).toEqual({ scale: 1.875, x: 20, y: 0 })
		} else if (interaction === 'wheel') {
			f.media.dispatchEvent(new f.w.WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 300 }))
			expect(f.view().scale).toBeGreaterThan(2)
		} else f.w.dispatchEvent(new f.w.Event('resize'))
		const interrupted = f.view()
		f.frame()
		expect(f.view()).toEqual(interrupted)
		f.dispose()
	})

	test('respects reduced motion without delaying zoom', async () => {
		const f = await zoomFixture({ reducedMotion: true })
		f.tap()
		f.tap()
		expect(f.view().scale).toBe(2)
		f.tap()
		f.tap()
		expect(f.view()).toEqual({ scale: 1, x: 0, y: 0 })
		f.dispose()
	})

	test.each(['disable', 'close', 'detach', 'dispose'])('cancels animation and removes gestures on %s', async (action) => {
		const f = await zoomFixture({ ios: true })
		f.tap()
		f.tap()
		f.frame(110)
		expect(f.view().scale).toBe(1.875)
		if (action === 'disable') await f.settings(false, false, false)
		else if (action === 'close') f.dialog.dispatchEvent(new f.w.Event('closed'))
		else if (action === 'detach') {
			f.media.remove()
			await flush()
		} else f.dispose()
		f.frame()
		f.tap()
		f.tap()
		f.frame()
		expect(f.media.getAttribute('style')).toBeNull()
		f.dispose()
	})
})

describe('camera frontend', () => {
	test.each(['app', 'connection', 'both'] as const)('starts without another reload when %s becomes ready after the bundle', async (delayed) => {
		const f = await fixture({ deferApp: delayed !== 'connection', deferConnection: delayed !== 'app' })
		await f.tick(30000)
		expect(f.counts().subscriptions).toBe(0)
		expect(f.intervals.size).toBe(0)
		expect(f.logs).toHaveLength(0)
		if (delayed !== 'connection') f.finishApp()
		if (delayed !== 'app') f.finishConnection()
		await f.tick(100)
		expect(f.counts().subscriptions).toBe(1)
		await f.settings(true, true, true)
		expect(f.intervals.size).toBe(1)
		expect(f.w.HTMLElement.prototype.attachShadow).not.toBe(f.originalAttach)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		expect(f.logs).toHaveLength(0)
		f.dispose()
	})

	test('cancels pending startup when a newer bundle replaces it', async () => {
		const f = await fixture({ deferApp: true, deferConnection: true })
		f.dispose()
		expect(f.pendingTimeouts()).toBe(0)
		await f.install()
		f.finishApp()
		f.finishConnection()
		await f.tick(100)
		await f.settings(true, true, true)
		expect(f.counts().subscriptions).toBe(1)
		expect(f.intervals.size).toBe(1)
		f.dispose()
	})

	test('ships one current bundle with no external module imports or CSS indentation', async () => {
		expect(source).toBe(await buildCameraFrontend())
		expect(source).not.toMatch(/\bimport\s*\(/)
		expect(source).not.toMatch(/\n[ \t]{2,}/)
	})

	test('preserves CSS selectors and interpolated iOS animation values when minifying', async () => {
		const f = await fixture({ ios: true })
		await f.settings(true, false, false)
		class Player extends f.w.HTMLElement {
			constructor() {
				super()
				this.attachShadow({ mode: 'open' }).innerHTML = '<video></video>'
			}
		}
		f.w.customElements.define('ha-hls-player', Player)
		const player = new Player()
		f.camera.shadowRoot!.append(player)
		await flush()
		const preflight = player.shadowRoot!.querySelector('style[data-hippo-camera-zoom-preflight-style]')!.textContent
		expect(preflight).toContain('animation:hippo-camera-video-reveal 1ms step-end 5000ms forwards')
		expect(preflight).toContain('visibility:hidden')
		expect(preflight).toContain('@keyframes hippo-camera-video-reveal')
		expect(preflight).not.toContain('HIPPO_CSS_EXPRESSION_')
		expect(player.shadowRoot!.querySelector('style[data-hippo-camera-zoom-style]')!.textContent).toContain(':host([data-hippo-camera-zoom]) video')
		expect(f.camera.shadowRoot!.querySelector('style[data-hippo-camera-zoom-style]')!.textContent).toContain(':host([data-hippo-camera-zoom])>img')
		f.dispose()
	})

	test('keeps native rendering usable when the initial settings subscription fails', async () => {
		const f = await fixture({ rejectSubscription: true })
		f.camera.requestUpdate()
		await flush()
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.intervals.size).toBe(0)
		expect(f.calls).toHaveLength(0)
		expect(f.w.HTMLElement.prototype.attachShadow).toBe(f.originalAttach)
		expect(f.logs).toEqual([["Hippo's Toolbox: camera extensions disabled; using the native viewer because backend communication failed or is incompatible."]])
		f.conn.dispatchEvent(new f.w.Event('ready'))
		await f.tick(30000)
		expect(f.counts()).toEqual({ subscriptions: 2, unsubscribed: 0 })
		f.dispose()
	})

	test('waits for settings without blocking native camera rendering or guessing enabled defaults', async () => {
		const f = await fixture({ deferSubscription: true })
		f.camera.requestUpdate()
		await f.tick(9000)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.intervals.size).toBe(0)
		expect(f.calls).toHaveLength(0)
		expect(f.logs).toHaveLength(0)
		f.finishSubscription()
		await flush()
		expect(f.intervals.size).toBe(0)
		await f.settings(true, true, true)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		f.dispose()
	})

	test('restores native hooks and sources immediately on disconnect and ignores old callbacks', async () => {
		const f = await fixture()
		await f.settings(true, true, true)
		f.conn.dispatchEvent(new f.w.Event('disconnected'))
		await f.settings(true, true, true)
		expect(f.intervals.size).toBe(0)
		expect(f.w.HTMLElement.prototype.attachShadow).toBe(f.originalAttach)
		expect((Object.getPrototypeOf(f.camera) as typeof f.camera)._renderStream).toBe(f.originalRender)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		f.dispose()
	})

	test.each([
		null,
		{},
		{ protocol: 2, camera_zoom: true, camera_recovery: true, camera_stream_cleanup: true },
		{ camera_zoom: true, camera_recovery: true, camera_stream_cleanup: true },
		{ protocol: 1, camera_zoom: true, camera_recovery: true },
		{ protocol: 1, camera_zoom: true, camera_recovery: 'true', camera_stream_cleanup: true },
	])('falls back safely for invalid or incompatible settings %j after activation', async (payload) => {
		const f = await fixture()
		await f.settings(true, true, true)
		await f.send(payload)
		expect(f.intervals.size).toBe(0)
		expect(f.w.HTMLElement.prototype.attachShadow).toBe(f.originalAttach)
		expect((Object.getPrototypeOf(f.camera) as typeof f.camera)._renderStream).toBe(f.originalRender)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.counts().unsubscribed).toBe(1)
		await f.settings(true, true, true)
		expect(f.intervals.size).toBe(0)
		f.dispose()
	})

	test.each([false, true])('times out a missing settings snapshot with pending acknowledgement=%s and ignores late replies', async (pendingAck) => {
		const f = await fixture({ deferSubscription: pendingAck })
		await f.tick(10000)
		if (pendingAck) {
			f.finishSubscription()
			await flush()
		}
		await f.settings(true, true, true)
		expect(f.counts()).toEqual({ subscriptions: 1, unsubscribed: 1 })
		expect(f.intervals.size).toBe(0)
		expect(f.calls).toHaveLength(0)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.dispose()
	})

	test('does not activate a settings snapshot until its subscription is acknowledged', async () => {
		const f = await fixture({ deferSubscription: true })
		await f.settings(true, true, true)
		expect(f.intervals.size).toBe(0)
		expect(f.calls).toHaveLength(0)
		f.finishSubscription()
		await flush()
		expect(f.intervals.size).toBe(1)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		f.dispose()
	})

	test('an old browser bundle stays native if the updated backend rejects its protocol on reconnect', async () => {
		const f = await fixture()
		await f.settings(true, true, true)
		f.conn.dispatchEvent(new f.w.Event('disconnected'))
		f.rejectSubscription()
		f.conn.dispatchEvent(new f.w.Event('ready'))
		await flush()
		f.callbacks[0]({ protocol: 1, camera_zoom: true, camera_recovery: true, camera_stream_cleanup: true })
		await f.tick(30000)
		expect(f.intervals.size).toBe(0)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.settingsRequests).toEqual(Array.from({ length: 2 }, () => ({ command: { type: 'hippos_toolbox/frontend/subscribe', protocol: 1 }, options: { resubscribe: false } })))
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		f.dispose()
	})

	test('uses English camera recovery messages and reasons', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		f.camera.shadowRoot!.querySelector('img')!.dispatchEvent(new f.w.Event('error'))
		await flush()
		expect(f.logs).toContainEqual(['[Hippo Camera Recovery] MJPEG stream recovery', { camera: 'camera.front_door', reason: 'Image error', attempt: 1 }])
		f.camera.remove()
		await f.tick()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(2)
		expect(f.logs).toHaveLength(1)
		f.dispose()
	})

	test.each([false, true])('opens and closes a normal MJPEG view silently with recovery=%s', async (recovery) => {
		const f = await fixture()
		await f.settings(false, recovery, true)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/hippos_toolbox/camera_stream/')
		expect(f.logs).toHaveLength(0)
		f.camera.remove()
		await f.tick()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(1)
		expect(f.logs).toHaveLength(0)
		f.dispose()
	})

	test('releases a detached native MJPEG image silently when controlled rendering is unavailable', async () => {
		const f = await fixture()
		Object.assign(f.camera, { _api: undefined })
		await f.settings(false, false, true)
		const image = f.camera.shadowRoot!.querySelector('img')!
		expect(image.src).toContain('/api/camera_proxy_stream/')
		f.camera.remove()
		await f.tick()
		expect(image.getAttribute('src')).toBeNull()
		expect(f.logs).toHaveLength(0)
		f.dispose()
	})

	test.each([false, true])('silently stops and resumes controlled views on backgrounding with recovery=%s', async (recovery) => {
		const f = await fixture()
		await f.settings(false, recovery, true)
		Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true })
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(1)
		Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: false })
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		expect(f.logs).toHaveLength(0)
		f.dispose()
	})

	test('resumes controlled views silently when the network returns', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		f.w.dispatchEvent(new f.w.Event('online'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		expect(f.logs).toHaveLength(0)
		f.dispose()
	})

	test('starts real MJPEG recovery at attempt one and backs off only recovery attempts', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		const image = f.camera.shadowRoot!.querySelector('img')!
		image.dispatchEvent(new f.w.Event('error'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		expect(f.logs).toContainEqual(['[Hippo Camera Recovery] MJPEG stream recovery', { camera: 'camera.front_door', reason: 'Image error', attempt: 1 }])
		image.dispatchEvent(new f.w.Event('error'))
		await f.tick(999)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		await f.tick(1)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(3)
		expect(f.logs).toContainEqual(['[Hippo Camera Recovery] MJPEG stream recovery', { camera: 'camera.front_door', reason: 'Image error', attempt: 2 }])
		f.dispose()
	})

	test('reports an initial reservation failure as opening failure without a recovery attempt', async () => {
		const f = await fixture()
		f.camera._api.callWS = () => Promise.reject(new Error('Backend unavailable'))
		await f.settings(false, true, true)
		expect(f.logs).toEqual([['[Hippo Camera Recovery] Could not open MJPEG view', { camera: 'camera.front_door' }]])
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.dispose()
	})

	test('still reports actual HLS fallback during initial view setup', async () => {
		const f = await fixture()
		f.camera._capabilities.frontend_stream_types = ['hls']
		Object.assign(f.camera, { _hlsStreams: { hasVideo: false } })
		await f.settings(false, true, true)
		expect(f.logs).toContainEqual(['[Hippo Camera Recovery] HLS stream recovery', { camera: 'camera.front_door', reason: 'HLS fell back to a still image', attempt: 1 }])
		expect(f.logs.some(([message]) => message === '[Hippo Camera Recovery] MJPEG stream recovery')).toBe(false)
		f.dispose()
	})

	test.each(Array.from({ length: 8 }, (_, mask) => [!!(mask & 1), !!(mask & 2), !!(mask & 4)]))(
		'applies independent switches zoom=%s recovery=%s cleanup=%s',
		async (zoom, recovery, cleanup) => {
			const f = await fixture()
			expect(f.intervals.size).toBe(0)
			expect(f.calls).toHaveLength(0)
			await f.settings(zoom, recovery, cleanup)
			expect(f.intervals.size).toBe(recovery || cleanup ? 1 : 0)
			expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(cleanup ? 1 : 0)
			expect(f.w.HTMLElement.prototype.attachShadow === f.originalAttach).toBe(!zoom)
			expect(f.counts().subscriptions).toBe(1)
			f.dispose()
			await flush()
			expect(f.intervals.size).toBe(0)
			expect(f.w.HTMLElement.prototype.attachShadow).toBe(f.originalAttach)
			expect(f.w.customElements.define).toBe(f.originalDefine)
			expect((Object.getPrototypeOf(f.dialog) as typeof f.dialog).showDialog).toBe(f.originalDialog)
			expect((Object.getPrototypeOf(f.camera) as typeof f.camera)._renderStream).toBe(f.originalRender)
		}
	)

	test('does not reopen streams for identical settings or a zoom-only change', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		await f.settings(false, true, true)
		await f.settings(true, true, true)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(0)
		f.dispose()
	})

	test('keeps the first image unset until reservation arrives and closes a late reservation after disabling', async () => {
		const f = await fixture({ deferOpen: true })
		await f.settings(false, true, true)
		expect(f.camera.shadowRoot!.querySelector('img')!.getAttribute('src')).toBeNull()
		await f.settings(false, false, false)
		f.finishOpen()
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(1)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.dispose()
	})

	test('closes only the abandoned view when two views use one camera', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		const other = f.w.document.createElement('ha-camera-stream') as typeof f.camera
		f.w.document.body.append(other)
		other.requestUpdate()
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		f.camera.remove()
		await f.tick()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toEqual([{ type: 'hippos_toolbox/camera_stream/stop', stream_id: 'session-1' }])
		expect(other.shadowRoot!.querySelector('img')!.src).toContain('session-2')
		f.dispose()
	})

	test('restores zoom styles and gestures on disable and can enable them again', async () => {
		const f = await fixture()
		const image = f.camera.shadowRoot!.querySelector('img')!
		image.style.opacity = '0.8'
		await f.settings(true, false, false)
		expect(image.style.touchAction).toBe('none')
		const event = new f.w.WheelEvent('wheel', { cancelable: true, deltaY: -100 })
		image.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		await f.settings(false, false, false)
		expect(image.getAttribute('style')).toBe('opacity: 0.8;')
		const inactive = new f.w.WheelEvent('wheel', { cancelable: true, deltaY: -100 })
		image.dispatchEvent(inactive)
		expect(inactive.defaultPrevented).toBe(false)
		expect(f.camera.fitMode).toBe('cover')
		await f.settings(true, false, false)
		const active = new f.w.WheelEvent('wheel', { cancelable: true, deltaY: -100 })
		image.dispatchEvent(active)
		expect(active.defaultPrevented).toBe(true)
		f.dispose()
	})

	test('removes old media listeners on close and reattaches on reopening the same dialog', async () => {
		const f = await fixture()
		await f.settings(true, false, false)
		const image = f.camera.shadowRoot!.querySelector('img')!
		f.dialog.dispatchEvent(new f.w.Event('closed'))
		const inactive = new f.w.WheelEvent('wheel', { cancelable: true })
		image.dispatchEvent(inactive)
		expect(inactive.defaultPrevented).toBe(false)
		Reflect.apply(f.dialog.showDialog, f.dialog, [{ entityId: 'camera.front_door' }])
		const active = new f.w.WheelEvent('wheel', { cancelable: true })
		image.dispatchEvent(active)
		expect(active.defaultPrevented).toBe(true)
		f.dispose()
	})

	test('unsubscribes a late subscription after disposal without activating features', async () => {
		const f = await fixture({ deferSubscription: true })
		f.dispose()
		f.finishSubscription()
		await flush()
		await f.settings(true, true, true)
		expect(f.counts()).toEqual({ subscriptions: 1, unsubscribed: 1 })
		expect(f.calls).toHaveLength(0)
		expect(f.intervals.size).toBe(0)
	})

	test('reopens sessions after a WebSocket reconnect even when settings are identical', async () => {
		const f = await fixture()
		await f.settings(false, true, true)
		f.conn.dispatchEvent(new f.w.Event('disconnected'))
		f.conn.dispatchEvent(new f.w.Event('ready'))
		await flush()
		await f.settings(false, true, true)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(1)
		expect(f.counts().subscriptions).toBe(2)
		expect(f.intervals.size).toBe(1)
		f.dispose()
	})

	test('reinstalls without duplicate subscriptions, stream hooks or watchdogs', async () => {
		const f = await fixture()
		await f.settings(true, true, true)
		await f.install()
		await f.settings(true, true, true)
		expect(f.counts()).toEqual({ subscriptions: 2, unsubscribed: 1 })
		expect(f.intervals.size).toBe(1)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		f.dispose()
	})

	test('recovery alone signs a fresh URL without camera tokens and backs off failures', async () => {
		const f = await fixture()
		await f.settings(false, true, false)
		const image = f.camera.shadowRoot!.querySelector('img')!
		image.dispatchEvent(new f.w.Event('error'))
		await flush()
		expect(f.calls).toHaveLength(1)
		expect(f.calls[0].type).toBe('auth/sign_path')
		expect(f.calls[0].path).not.toContain('token=')
		expect(image.src).toContain('authSig=test')
		image.dispatchEvent(new f.w.Event('error'))
		await flush()
		expect(f.calls).toHaveLength(1)
		await f.tick(1000)
		expect(f.calls).toHaveLength(2)
		expect(JSON.stringify(f.logs)).not.toMatch(/authSig|token=|session-/)
		f.dispose()
	})

	test('cleanup alone closes and resumes on backgrounding without retrying image errors', async () => {
		const f = await fixture()
		await f.settings(false, false, true)
		const image = f.camera.shadowRoot!.querySelector('img')!
		image.dispatchEvent(new f.w.Event('error'))
		await f.tick(21000)
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(1)
		Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true })
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toHaveLength(1)
		Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: false })
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/open'))).toHaveLength(2)
		f.dispose()
	})

	test('falls back to native rendering when the backend or required HA context is unavailable', async () => {
		const f = await fixture()
		f.camera._api.callWS = () => Promise.reject(Object.assign(new Error('Unsupported command'), { code: 'unknown_command' }))
		await f.settings(false, true, true)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		await f.settings(false, false, false)
		Object.assign(f.camera, { _api: undefined })
		await f.settings(false, true, true)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.dispose()
	})

	test.each([null, {}, { stream_id: 'session-bad' }, { stream_id: 'session-bad', path: '/unexpected/path' }])(
		'restores native rendering for malformed stream reservations %j',
		async (response) => {
			const f = await fixture()
			const callWS = f.camera._api.callWS
			Object.assign(f.camera._api, { callWS: (command: (typeof f.calls)[number]) => (command.type.endsWith('/open') ? Promise.resolve(response) : callWS(command)) })
			await f.settings(false, true, true)
			expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
			const calls = f.calls.length
			await f.tick(30000)
			expect(f.calls).toHaveLength(calls)
			f.dispose()
		}
	)

	test('restores native rendering on a reservation timeout and stops the late reservation', async () => {
		const f = await fixture({ deferOpen: true })
		await f.settings(false, true, true)
		await f.tick(10000)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.finishOpen()
		await flush()
		expect(f.calls.filter((c) => c.type.endsWith('/stop'))).toEqual([{ type: 'hippos_toolbox/camera_stream/stop', stream_id: 'session-1' }])
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		f.dispose()
	})

	test('restores every feature even if stopping an old backend session throws synchronously', async () => {
		const f = await fixture()
		await f.settings(true, true, true)
		f.camera._api.callWS = () => {
			throw new Error('Backend unavailable')
		}
		f.conn.dispatchEvent(new f.w.Event('disconnected'))
		await flush()
		expect(f.intervals.size).toBe(0)
		expect(f.w.HTMLElement.prototype.attachShadow).toBe(f.originalAttach)
		expect((Object.getPrototypeOf(f.camera) as typeof f.camera)._renderStream).toBe(f.originalRender)
		expect(f.camera.shadowRoot!.querySelector('img')!.src).toContain('/api/camera_proxy_stream/')
		expect(f.logs).toContainEqual(['[Hippo Camera Recovery] Could not confirm MJPEG stream stop', { camera: 'camera.front_door' }])
		f.dispose()
	})

	test('retains the native HLS short-background grace period and renews an expired player once', async () => {
		const f = await fixture()
		let nativeCalls = 0
		let renewals = 0
		const player = Object.assign(f.w.document.createElement('ha-hls-player'), {
			entityid: 'camera.front_door',
			_hiddenCleanupTimeout: undefined as number | undefined,
			_handleVisibilityChange: () => {
				nativeCalls++
			},
			_getStreamUrlFromEntityId: () => {
				renewals++
				return Promise.resolve()
			},
		})
		f.w.document.addEventListener('visibilitychange', player._handleVisibilityChange)
		f.camera.shadowRoot!.querySelector('img')!.remove()
		f.camera.shadowRoot!.append(player)
		await f.settings(false, true, false)
		player._hiddenCleanupTimeout = 42
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		expect(nativeCalls).toBe(1)
		expect(renewals).toBe(0)
		player._hiddenCleanupTimeout = undefined
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		await flush()
		expect(renewals).toBe(1)
		f.dispose()
		f.w.document.dispatchEvent(new f.w.Event('visibilitychange'))
		expect(nativeCalls).toBe(2)
	})

	test('releases detached zoom media and can enhance the same media when reinserted', async () => {
		const f = await fixture()
		await f.settings(true, false, false)
		const image = f.camera.shadowRoot!.querySelector('img')!
		image.remove()
		await flush()
		const inactive = new f.w.WheelEvent('wheel', { cancelable: true })
		image.dispatchEvent(inactive)
		expect(inactive.defaultPrevented).toBe(false)
		f.camera.shadowRoot!.append(image)
		await flush()
		const active = new f.w.WheelEvent('wheel', { cancelable: true })
		image.dispatchEvent(active)
		expect(active.defaultPrevented).toBe(true)
		f.dispose()
	})

	test('removes zoom effects when a reused dialog switches to another entity domain', async () => {
		const f = await fixture()
		await f.settings(true, false, false)
		Reflect.apply(f.dialog.showDialog, f.dialog, [{ entityId: 'sensor.temperature' }])
		const event = new f.w.WheelEvent('wheel', { cancelable: true })
		f.camera.shadowRoot!.querySelector('img')!.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(false)
		expect(f.camera.fitMode).toBe('cover')
		expect(f.dialog.hasAttribute('data-hippo-camera-zoom')).toBe(false)
		f.dispose()
	})
})
