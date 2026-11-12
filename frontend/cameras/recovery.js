/* Camera recovery and its shared HA stream hook. */
import { watchVideoStart } from './video-fallback.js'
import { openControlledStream, stopControlledStream } from './stream-cleanup.js'

export function installCameraRecovery({ recovery = true, cleanup = true, hideControls = false, automaticVideo = false } = {}) {
	const CHECK_INTERVAL = 2000
	const LOAD_TIMEOUT = 20000
	const BACKGROUND_RESTART_DELAY = 60000
	const MAX_RETRY_DELAY = 30000
	const NO_CHANGE = Symbol.for('lit-noChange')
	const STREAM_PATH = '/api/hippos_toolbox/camera_stream/'
	const trackStreams = recovery || cleanup || automaticVideo

	const streams = new Map()
	const players = new Map()
	const previews = new Map()
	const replacementViews = new WeakSet()
	let disposed = false
	let timer
	let prototype
	let originalRender
	let patchedRender
	let originalViewRender
	let originalToggleMicrophone
	let originalMicrophoneTrack
	let renderReplacement
	let toggleReplacementMicrophone
	let replacementMicrophoneTrack
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

	function usesDashboardPreview(stream) {
		return recovery && stream.getRootNode().host?.localName === 'hui-image'
	}

	function onFirstVideoFrame(video, callback) {
		const frame = video.requestVideoFrameCallback?.(callback)
		if (frame !== undefined) return () => video.cancelVideoFrameCallback?.(frame)
		video.addEventListener('loadeddata', callback, { once: true })
		return () => video.removeEventListener('loadeddata', callback)
	}

	function watchDashboardPreview(stream) {
		if (!usesDashboardPreview(stream)) return
		const player = stream.shadowRoot?.querySelector('ha-web-rtc-player:not(.hidden)')
		if (!player?.posterUrl) return

		void player.updateComplete.then(() => {
			if (disposed || !player.isConnected || player.classList.contains('hidden')) return
			const video = player.shadowRoot?.querySelector('video')
			const existing = previews.get(player)
			if (existing && existing.video !== video) existing.remove()
			if (!video || video.readyState >= video.HAVE_CURRENT_DATA || !player.posterUrl) return
			if (existing?.video === video) {
				if (existing.image.getAttribute('src') !== player.posterUrl) existing.image.src = player.posterUrl
				return
			}

			// WebRTC can cover the native poster before it paints a frame. Keep the
			// same HA thumbnail visible in a separate image until video is presented.
			const image = document.createElement('img')
			image.alt = ''
			image.setAttribute('data-hippo-camera-cache-preview', '')
			image.style.cssText = 'position:absolute; inset:0; width:100%; height:auto; pointer-events:none;'
			image.style.aspectRatio = String(stream.aspectRatio ?? 16 / 9)
			image.style.objectFit = stream.fitMode ?? 'cover'
			image.src = player.posterUrl
			const remove = () => {
				cancelFrame()
				image.remove()
				previews.delete(player)
			}
			const cancelFrame = onFirstVideoFrame(video, remove)
			previews.set(player, { video, image, remove })
			player.shadowRoot.prepend(image)
		})
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
				imageStyle: null,
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
				videoFallback: null,
				replacementView: null,
				primaryEntity: null,
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
		if (image && !state.imageStyle?.isConnected) {
			// Keep HA's accessible image label while hiding the browser's
			// visual alt-text placeholder until the first JPEG arrives.
			const style = document.createElement('style')
			style.textContent = 'img { color: transparent; font-size: 0; }'
			stream.shadowRoot.prepend(style)
			state.imageStyle = style
		}
		if (image !== state.image) {
			if (state.managedEntity && state.image) stopControlledStream(stream, state)
			state.image?.removeEventListener('error', state.onError)
			state.image = image
			state.lastAttemptAt = Date.now()
			image?.addEventListener('error', state.onError)
		}
		hookPlayer(stream.shadowRoot?.querySelector('ha-hls-player'))
		watchDashboardPreview(stream)
		if (renderReplacement && !replacementViews.has(stream)) {
			const entityId = stream.stateObj?.attributes?.hippos_toolbox_replacement_camera
			const replacement = document.querySelector('home-assistant')?.hass?.states?.[entityId]
			const primary = stream.stateObj?.entity_id
			if (state.replacementView && (state.primaryEntity !== primary || state.replacementView.stateObj?.entity_id !== replacement?.entity_id)) {
				state.replacementView = null
				stream.requestUpdate()
			}
			if (state.replacementView && state.replacementView.stateObj !== replacement) state.replacementView.stateObj = replacement
			const player = !state.replacementView && replacement && replacement.entity_id !== primary ? stream.shadowRoot?.querySelector('ha-web-rtc-player') : null
			if ((state.videoFallback?.player ?? null) !== (player ?? null)) {
				state.videoFallback?.dispose()
				state.videoFallback = null
				if (player) {
					state.videoFallback = watchVideoStart(player, () => {
						const alternate = document.querySelector('home-assistant')?.hass?.states?.[entityId]
						if (!alternate || stream.stateObj?.entity_id !== primary || stream.stateObj?.attributes?.hippos_toolbox_replacement_camera !== entityId) return
						state.videoFallback?.dispose()
						state.videoFallback = null
						// Let HA choose and authenticate the replacement's transport. The
						// replacement view itself cannot activate another replacement.
						const view = document.createElement('ha-camera-stream')
						replacementViews.add(view)
						view.stateObj = alternate
						if (!window.isSecureContext) {
							// The app's HTTP microphone bridge uses the dialog's primary entity.
							view.addEventListener('camera-capabilities-changed', (event) => event.stopPropagation())
						}
						const poster = player.posterUrl ?? stream._posterUrl
						if (poster) {
							view.style.aspectRatio = String(stream.aspectRatio ?? 16 / 9)
							view.style.background = `center / contain no-repeat url(${JSON.stringify(poster)})`
							const removePoster = (event) => {
								const hasImage = view.shadowRoot?.querySelector('img')?.naturalWidth > 1
								if (!hasImage && !(event.type === 'streams' && event.detail?.hasVideo)) return
								view.style.background = ''
								view.style.removeProperty('aspect-ratio')
								view.removeEventListener('load', removePoster)
								view.removeEventListener('streams', removePoster)
							}
							view.addEventListener('load', removePoster)
							view.addEventListener('streams', removePoster)
						}
						state.primaryEntity = primary
						state.replacementView = view
						stream.dispatchEvent(new CustomEvent('camera-capabilities-changed', { bubbles: true, composed: true, detail: {} }))
						stream.requestUpdate()
					})
				}
			}
		}
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
			state.videoFallback?.resetDeadline()
			const image = stream.shadowRoot?.querySelector('img')
			if (image && (state.managedEntity || (recovery && longPause) || (recovery && (image.naturalWidth === 0 || hlsFallback(stream, image))))) {
				// Reopening our deliberately closed response is normal lifecycle work.
				recover(stream, state, state.managedEntity ? undefined : 'Tab visible again')
			}
		}
	}

	function onOnline() {
		for (const [stream, state] of streams) {
			const image = stream.shadowRoot?.querySelector('img')
			if (image && (state.managedEntity || (recovery && (image.naturalWidth === 0 || hlsFallback(stream, image))))) {
				recover(stream, state, state.managedEntity ? undefined : 'Network online again')
			}
		}
	}

	function checkStreams() {
		for (const [stream, state] of streams) {
			if (!stream.isConnected) {
				releaseDisconnectedImage(stream, state.image)
				state.videoFallback?.dispose()
				state.imageStyle?.remove()
				stream.removeEventListener('load', state.onLoad)
				state.image?.removeEventListener('error', state.onError)
				streams.delete(stream)
				continue
			}
			if (document.hidden || navigator.onLine === false) continue
			watchStream(stream)
			state.videoFallback?.check()
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
		for (const [player, preview] of previews) {
			if (!preview.video.isConnected || player.classList.contains('hidden')) preview.remove()
		}
	}

	function* cameraStreams() {
		const roots = [document]
		while (roots.length) {
			for (const element of roots.pop().querySelectorAll('*')) {
				if (element.shadowRoot) roots.push(element.shadowRoot)
				if (element.localName === 'ha-camera-stream' && element.stateObj?.entity_id?.startsWith('camera.')) yield element
			}
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
			state.videoFallback?.dispose()
			state.imageStyle?.remove()
			stream.removeEventListener('load', state.onLoad)
			state.image?.removeEventListener('error', state.onError)
		}
		const activeStreams = new Set([...streams.keys()].filter((stream) => stream.isConnected))
		streams.clear()
		for (const [player, state] of players) detachPlayer(player, state)
		for (const preview of previews.values()) preview.remove()
		if (patchedRender && prototype?._renderStream === patchedRender) {
			prototype._renderStream = originalRender
			if (hideControls) for (const stream of cameraStreams()) activeStreams.add(stream)
		}
		if (renderReplacement && prototype?.render === renderReplacement) prototype.render = originalViewRender
		if (toggleReplacementMicrophone && prototype?.toggleMicrophone === toggleReplacementMicrophone) prototype.toggleMicrophone = originalToggleMicrophone
		if (replacementMicrophoneTrack && Object.getOwnPropertyDescriptor(prototype, 'microphoneTrack')?.get === replacementMicrophoneTrack)
			Object.defineProperty(prototype, 'microphoneTrack', originalMicrophoneTrack)
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
			if (trackStreams) releaseDisconnectedImage(this, this.shadowRoot?.querySelector('img'))
			const result = originalRender.apply(this, args)
			if (hideControls && (args[0]?.type === 'hls' || args[0]?.type === 'web_rtc') && this.stateObj?.entity_id?.startsWith('camera.')) {
				// Set the child player's Lit binding before WebKit creates its
				// native controls. Removing them from the video later can flash.
				const index = result?.strings?.findIndex((part) => /[.?]controls=\s*$/.test(part))
				if (index >= 0 && index < result.values?.length) result.values[index] = false
			}
			const transport = args[0]?.type
			const dashboardPreview = transport === 'web_rtc' && usesDashboardPreview(this)
			const dialogPreview = recovery && (transport === 'web_rtc' || transport === 'hls') && this.getRootNode().host?.localName === 'more-info-camera'
			if (dashboardPreview || dialogPreview) {
				const entityId = this.stateObj?.entity_id
				const hass = document.querySelector('home-assistant')?.hass
				const picture = hass?.states?.[entityId]?.attributes?.entity_picture
				const index = result?.strings?.findIndex((part) => /\.posterUrl=\s*$/.test(part))
				if (
					(dashboardPreview || hass?.entities?.[entityId]?.platform === 'hippos_toolbox') &&
					index >= 0 &&
					index < result.values?.length &&
					typeof picture === 'string' &&
					picture.startsWith(`/api/camera_proxy/${entityId}?token=`)
				) {
					// Use the current cached picture in HA's native poster binding,
					// even while the dialog's own signed thumbnail is pending.
					const tile = dialogPreview && [...streams.keys()].find((stream) => stream.isConnected && stream.stateObj?.entity_id === entityId && usesDashboardPreview(stream))
					const preview = tile || this
					const url = new URL(picture, location.href)
					const width = Math.round((preview.clientWidth || (dialogPreview ? window.innerWidth : 0)) * window.devicePixelRatio)
					if (width > 0) {
						url.searchParams.set('width', width)
						url.searchParams.set('height', Math.max(1, Math.round(width / (preview.aspectRatio || 16 / 9))))
					}
					result.values[index] = url.pathname + url.search
				}
			}
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
			if (trackStreams)
				this.updateComplete.then(() => {
					if (!disposed) watchStream(this)
				})
			return result
		}
		prototype._renderStream = patchedRender
		if (automaticVideo && typeof prototype.render === 'function') {
			originalViewRender = prototype.render
			renderReplacement = function () {
				const state = streams.get(this)
				const view = state?.replacementView
				if (view && state.primaryEntity === this.stateObj?.entity_id && view.stateObj?.entity_id === this.stateObj.attributes?.hippos_toolbox_replacement_camera) {
					view.aspectRatio = this.aspectRatio
					view.fitMode = this.fitMode
					view.controls = this.controls
					view.muted = this.muted
					view.allowExoPlayer = this.allowExoPlayer
					// Lit accepts the native element as the render value and tears down
					// the old player through its usual disconnected callback.
					return view
				}
				return originalViewRender.call(this)
			}
			prototype.render = renderReplacement
			if (typeof prototype.toggleMicrophone === 'function') {
				originalToggleMicrophone = prototype.toggleMicrophone
				toggleReplacementMicrophone = function () {
					const view = streams.get(this)?.replacementView
					if (view?.isConnected) return view.toggleMicrophone()
					return originalToggleMicrophone.call(this)
				}
				prototype.toggleMicrophone = toggleReplacementMicrophone
			}
			originalMicrophoneTrack = Object.getOwnPropertyDescriptor(prototype, 'microphoneTrack')
			if (originalMicrophoneTrack?.get && originalMicrophoneTrack.configurable) {
				replacementMicrophoneTrack = function () {
					const view = streams.get(this)?.replacementView
					return view?.isConnected ? view.microphoneTrack : originalMicrophoneTrack.get.call(this)
				}
				Object.defineProperty(prototype, 'microphoneTrack', { ...originalMicrophoneTrack, get: replacementMicrophoneTrack })
			}
		}
		if (trackStreams) {
			document.addEventListener('visibilitychange', onVisibility)
			window.addEventListener('online', onOnline)
			timer = setInterval(checkStreams, CHECK_INTERVAL)
		}

		// Attach once to existing cards. Future cards are covered by _renderStream.
		for (const element of cameraStreams()) {
			if (trackStreams) watchStream(element)
			const image = element.shadowRoot?.querySelector('img')
			const source = image?.getAttribute('src') ?? ''
			if (hideControls || usesDashboardPreview(element) || source.includes('/api/camera_proxy_stream/') || source.includes(STREAM_PATH)) element.requestUpdate()
		}
	})

	return dispose
}
