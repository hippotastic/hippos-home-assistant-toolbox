/* Camera recovery and its shared HA stream hook. */
import { openControlledStream, stopControlledStream } from './stream-cleanup.js'

export function installCameraRecovery({ recovery = true, cleanup = true } = {}) {
	const CHECK_INTERVAL = 2000
	const LOAD_TIMEOUT = 20000
	const BACKGROUND_RESTART_DELAY = 60000
	const MAX_RETRY_DELAY = 30000
	const NO_CHANGE = Symbol.for('lit-noChange')
	const STREAM_PATH = '/api/hippos_toolbox/camera_stream/'

	const streams = new Map()
	const players = new Map()
	let disposed = false
	let timer
	let prototype
	let originalRender
	let patchedRender
	let hiddenAt = document.hidden ? Date.now() : null

	function detachPlayer(player, state) {
		document.removeEventListener('visibilitychange', state.handler)
		if (player._handleVisibilityChange === state.handler) {
			player._handleVisibilityChange = state.original
			if (player.isConnected) document.addEventListener('visibilitychange', state.original)
		}
		players.delete(player)
	}

	function hookPlayer(player) {
		if (!recovery || !player || players.has(player)) return
		if (typeof player._handleVisibilityChange !== 'function' || typeof player._getStreamUrlFromEntityId !== 'function') return

		const original = player._handleVisibilityChange
		let refreshing = false
		let attempts = 0
		const handler = () => {
			if (disposed || !player.isConnected || document.pictureInPictureElement) return

			if (document.hidden || player._hiddenCleanupTimeout || !player.entityid || player.url) {
				original.call(player)
				return
			}

			// HA otherwise restarts _url after its server-side session has expired.
			// Keep HA's short-background grace period and renew only after cleanup.
			if (refreshing) return
			refreshing = true
			console.info('[Hippo Camera Recovery] HLS stream recovery', {
				camera: player.entityid,
				reason: 'Tab visible again',
				attempt: ++attempts,
			})
			Promise.resolve()
				.then(() => player._getStreamUrlFromEntityId())
				.catch(() => {
					// HA normally reports lookup errors through the parent stream.
					// The watchdog below also recovers an already-rendered fallback.
				})
				.finally(() => {
					refreshing = false
				})
		}

		document.removeEventListener('visibilitychange', original)
		player._handleVisibilityChange = handler
		document.addEventListener('visibilitychange', handler)
		players.set(player, { original, handler })
	}

	function hlsFallback(stream, image) {
		return Boolean(image && stream._capabilities?.frontend_stream_types?.includes('hls') && stream._hlsStreams?.hasVideo === false && stream._webRtcStreams?.hasVideo !== true)
	}

	function releaseDisconnectedImage(stream, image) {
		if (stream.isConnected) return
		const state = streams.get(stream)
		if (state?.managedEntity) {
			stopControlledStream(stream, state)
			if (image?.getAttribute('src')?.includes(STREAM_PATH)) image.removeAttribute('src')
			// The asynchronous server confirmation is the one authoritative log.
			return
		}
		if (!cleanup) return
		const source = image?.getAttribute('src')
		if (!source || !stream.stateObj?.entity_id) return
		const url = new URL(source, location.href)
		if (url.pathname !== `/api/camera_proxy_stream/${stream.stateObj.entity_id}` && url.pathname !== `${STREAM_PATH}${stream.stateObj.entity_id}`) return
		// A detached <img> can still own an endless multipart request. Remove its
		// source explicitly; src="" would instead request the current HTML page.
		image.removeAttribute('src')
		console.info('[Hippo Camera Recovery] MJPEG connection released', {
			camera: stream.stateObj.entity_id,
			reason: 'Camera view closed',
		})
	}

	async function recover(stream, state, reason) {
		if (disposed || state.controlDisabled || document.hidden || navigator.onLine === false || !stream.isConnected || state.refreshing) return
		const now = Date.now()
		if (now < state.nextRetryAt) return

		const image = stream.shadowRoot?.querySelector('img')
		if (!image) return
		const isHlsFallback = hlsFallback(stream, image)
		// Initial MJPEG reservations use the same renewal path, but are ordinary
		// setup. Only an interruption or HLS fallback counts as recovery.
		const isRecovery = reason !== undefined || isHlsFallback
		let url
		if (!isHlsFallback && !state.managedEntity) {
			const source = image.getAttribute('src')
			if (!source || !stream.stateObj?.entity_id?.startsWith('camera.')) return
			url = new URL(source, location.href)
			if (url.pathname !== `/api/camera_proxy_stream/${stream.stateObj.entity_id}`) return
			if (typeof stream._api?.callWS !== 'function' || typeof stream._connection?.hassUrl !== 'function') return
			// Cards behind a dialog can retain expired camera tokens. Ask HA to sign
			// the complete retry URL using the active authenticated connection instead.
			url.searchParams.delete('token')
			url.searchParams.delete('authSig')
			// A distinct URL also discards Chromium's canceled multipart resource.
			url.searchParams.set('_hippo_retry', `${Math.floor(now / 1000)}`)
		}

		if (state.managedEntity && !isHlsFallback) stopControlledStream(stream, state)
		if (isRecovery) {
			state.nextRetryAt = now + Math.min(1000 * 2 ** Math.min(state.attempts, 5), MAX_RETRY_DELAY)
			state.attempts += 1
			console.info(`[Hippo Camera Recovery] ${isHlsFallback ? 'HLS' : 'MJPEG'} stream recovery`, {
				camera: stream.stateObj.entity_id,
				reason: reason ?? 'HLS fell back to a still image',
				attempt: state.attempts,
			})
		}
		state.lastAttemptAt = now
		state.failed = false

		if (isHlsFallback) {
			if (state.managedEntity) {
				stopControlledStream(stream, state)
				state.managedEntity = null
			}
			// Reset HA's transport choice; its new HLS player obtains a fresh URL.
			stream._hlsStreams = undefined
			stream.requestUpdate()
		} else {
			state.refreshing = true
			const generation = state.generation
			try {
				if (state.managedEntity) {
					await openControlledStream(stream, state, image, () => !disposed)
					return
				}
				const signed = await stream._api.callWS({
					type: 'auth/sign_path',
					path: url.pathname + url.search,
				})
				if (typeof signed?.path !== 'string') throw new Error('Invalid signed camera path')
				// A lookup can finish after the user closes the dialog or hides the tab.
				if (disposed || document.hidden || navigator.onLine === false || !stream.isConnected) return
				if (stream.shadowRoot?.querySelector('img') !== image) return
				image.src = stream._connection.hassUrl(signed.path)
			} catch {
				if (state.generation !== generation) return
				if (state.managedEntity) {
					// Backend mismatches and timeouts must never leave a blank controlled
					// view. Use HA's source and stop enhancing this view for this install.
					stopControlledStream(stream, state)
					state.managedEntity = null
					state.controlDisabled = true
					stream.requestUpdate()
				}
				state.failed = true
				console.warn(isRecovery ? '[Hippo Camera Recovery] Could not renew stream URL' : '[Hippo Camera Recovery] Could not open MJPEG view', {
					camera: stream.stateObj.entity_id,
					...(isRecovery ? { attempt: state.attempts } : {}),
				})
			} finally {
				if (state.generation === generation) state.refreshing = false
			}
		}
	}

	function watchStream(stream) {
		if (disposed || !stream.isConnected) return
		let state = streams.get(stream)
		if (!state) {
			state = {
				image: null,
				attempts: 0,
				nextRetryAt: 0,
				lastAttemptAt: Date.now(),
				failed: false,
				refreshing: false,
				managedEntity: null,
				streamId: null,
				streamUrl: null,
				generation: 0,
				controlDisabled: false,
				interval: null,
				onError: null,
				onLoad: null,
			}
			state.onError = () => {
				state.failed = true
				if (recovery) recover(stream, state, 'Image error')
			}
			state.onLoad = () => {
				const image = stream.shadowRoot?.querySelector('img')
				if (hlsFallback(stream, image)) return
				if (state.managedEntity && image?.naturalWidth <= 1) return
				state.attempts = 0
				state.nextRetryAt = 0
				state.failed = false
				state.lastAttemptAt = Date.now()
			}
			stream.addEventListener('load', state.onLoad)
			streams.set(stream, state)
		}

		const image = stream.shadowRoot?.querySelector('img') ?? null
		if (image !== state.image) {
			if (state.managedEntity && state.image) stopControlledStream(stream, state)
			state.image?.removeEventListener('error', state.onError)
			state.image = image
			state.lastAttemptAt = Date.now()
			image?.addEventListener('error', state.onError)
		}
		hookPlayer(stream.shadowRoot?.querySelector('ha-hls-player'))
		if (state.managedEntity && image && !state.streamId) recover(stream, state)
		return state
	}

	function onVisibility() {
		if (document.hidden) {
			hiddenAt = Date.now()
			for (const [stream, state] of streams) if (state.managedEntity) stopControlledStream(stream, state)
			return
		}
		const longPause = hiddenAt !== null && Date.now() - hiddenAt >= BACKGROUND_RESTART_DELAY
		hiddenAt = null
		for (const [stream, state] of streams) {
			const image = stream.shadowRoot?.querySelector('img')
			if (image && (state.managedEntity || (recovery && longPause) || (recovery && (image.naturalWidth === 0 || hlsFallback(stream, image))))) {
				recover(stream, state, 'Tab visible again')
			}
		}
	}

	function onOnline() {
		for (const [stream, state] of streams) {
			const image = stream.shadowRoot?.querySelector('img')
			if (image && (state.managedEntity || (recovery && (image.naturalWidth === 0 || hlsFallback(stream, image))))) {
				recover(stream, state, 'Network online again')
			}
		}
	}

	function checkStreams() {
		for (const [stream, state] of streams) {
			if (!stream.isConnected) {
				releaseDisconnectedImage(stream, state.image)
				stream.removeEventListener('load', state.onLoad)
				state.image?.removeEventListener('error', state.onError)
				streams.delete(stream)
				continue
			}
			if (document.hidden || navigator.onLine === false) continue
			watchStream(stream)
			const image = state.image
			if (!image || !recovery) continue
			if (hlsFallback(stream, image)) {
				recover(stream, state, 'HLS fell back to a still image')
			} else if (image.naturalWidth > (state.managedEntity ? 1 : 0)) {
				state.attempts = 0
				state.nextRetryAt = 0
				state.failed = false
			} else if (state.failed || image.complete || Date.now() - state.lastAttemptAt >= LOAD_TIMEOUT) {
				// Canceled MJPEG requests do not reliably emit an image error event.
				recover(stream, state, state.failed ? 'Image error' : image.complete ? 'Image request interrupted' : 'Image load timed out')
			}
		}
		for (const [player, state] of players) {
			if (!player.isConnected) detachPlayer(player, state)
		}
	}

	function dispose() {
		if (disposed) return
		disposed = true
		clearInterval(timer)
		document.removeEventListener('visibilitychange', onVisibility)
		window.removeEventListener('online', onOnline)
		for (const [stream, state] of streams) {
			if (state.managedEntity) stopControlledStream(stream, state)
			stream.removeEventListener('load', state.onLoad)
			state.image?.removeEventListener('error', state.onError)
		}
		const activeStreams = [...streams.keys()].filter((stream) => stream.isConnected)
		streams.clear()
		for (const [player, state] of players) detachPlayer(player, state)
		if (prototype?._renderStream === patchedRender) prototype._renderStream = originalRender
		// Restore native sources after removing our render hook. A disposed module
		// must not leave a stopped signed URL in an otherwise connected image.
		for (const stream of activeStreams) stream.requestUpdate()
	}

	customElements.whenDefined('ha-camera-stream').then(() => {
		if (disposed) return
		prototype = customElements.get('ha-camera-stream')?.prototype
		originalRender = prototype?._renderStream
		if (typeof originalRender !== 'function') {
			console.warn("Hippo's camera recovery: this HA camera component is not supported.")
			dispose()
			return
		}

		// Regular render methods remain dynamically dispatched after custom-element
		// registration; replacing a lifecycle callback at this point would be too late.
		patchedRender = function renderCameraWithRecovery(...args) {
			// HA renders a poster after disconnection. Release the old live image
			// first, with the watchdog covering components that no longer render.
			releaseDisconnectedImage(this, this.shadowRoot?.querySelector('img'))
			const result = originalRender.apply(this, args)
			const source = result?.values?.[0]
			if (
				cleanup &&
				this.isConnected &&
				args[0]?.type === 'mjpeg' &&
				typeof source === 'string' &&
				result.strings?.[0]?.includes('.src=') &&
				typeof this._api?.callWS === 'function' &&
				typeof this._connection?.hassUrl === 'function'
			) {
				const url = new URL(source, location.href)
				if (url.pathname === `/api/camera_proxy_stream/${this.stateObj?.entity_id}`) {
					const state = watchStream(this)
					if (!state.controlDisabled) {
						if (state.managedEntity && state.managedEntity !== this.stateObj.entity_id) stopControlledStream(this, state)
						state.managedEntity = this.stateObj.entity_id
						state.interval = url.searchParams.has('interval') ? Number(url.searchParams.get('interval')) : null
						// The browser still opens a native MJPEG <img>. Only its signed URL
						// carries a server-controlled lifetime; no fetch or JPEG parser.
						// A 1x1 placeholder fires HA's load handler and briefly changes
						// the card to a square. Leave .src unset until a real image exists.
						result.values[0] = state.streamUrl ?? this._posterUrl ?? NO_CHANGE
					}
				}
			} else {
				const state = streams.get(this)
				if (state?.managedEntity) {
					stopControlledStream(this, state)
					state.managedEntity = null
				}
			}
			this.updateComplete.then(() => {
				if (!disposed) watchStream(this)
			})
			return result
		}
		prototype._renderStream = patchedRender
		document.addEventListener('visibilitychange', onVisibility)
		window.addEventListener('online', onOnline)
		timer = setInterval(checkStreams, CHECK_INTERVAL)

		// Attach once to existing cards. Future cards are covered by _renderStream.
		const roots = [document]
		while (roots.length) {
			for (const element of roots.pop().querySelectorAll('*')) {
				if (element.shadowRoot) roots.push(element.shadowRoot)
				if (element.localName === 'ha-camera-stream') {
					watchStream(element)
					const image = element.shadowRoot?.querySelector('img')
					const source = image?.getAttribute('src') ?? ''
					if (source.includes('/api/camera_proxy_stream/') || source.includes(STREAM_PATH)) element.requestUpdate()
				}
			}
		}
	})

	return dispose
}
