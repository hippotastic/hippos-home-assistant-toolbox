/* Camera dialog zoom, pan and aspect-ratio corrections. */
export const IS_IOS_WEBKIT = /iP(?:ad|hone|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function installCameraZoom() {
	const VERSION = 33
	let disposed = false
	const undoPatches = []
	const cleanups = new Map()
	const originals = new Map()
	const scopedHosts = new Set()

	function remember(element) {
		if (!originals.has(element))
			originals.set(element, {
				style: element.getAttribute('style'),
				controls: element.tagName === 'VIDEO' && !IS_IOS_WEBKIT ? element.controls : undefined,
				fitMode: element.fitMode,
				width: element.width,
				fill: element._fill,
			})
	}

	function restore(element) {
		const saved = originals.get(element)
		if (!saved) return
		if (saved.style === null) element.removeAttribute('style')
		else element.setAttribute('style', saved.style)
		if (saved.controls !== undefined) element.controls = saved.controls
		if ('fitMode' in element) element.fitMode = saved.fitMode
		if (element.tagName === 'HA-ADAPTIVE-DIALOG') element.width = saved.width
		if (element.tagName === 'HA-MORE-INFO-DIALOG') {
			element._fill = saved.fill
			element.requestUpdate?.()
		}
		originals.delete(element)
	}

	const MIN_SCALE = 1
	const DOUBLE_TAP_SCALE = 2
	const DOUBLE_TAP_DELAY_MS = 300
	const TAP_SLOP_PX = 10
	const DOUBLE_TAP_DISTANCE_PX = 30
	const ZOOM_ANIMATION_MS = 300
	const FALLBACK_ZOOM_ANIMATION_MS = 220
	const PAN_DECELERATION_PER_MS = 0.998 // UIScrollView.DecelerationRate.normal
	const PAN_VELOCITY_WINDOW_MS = 80
	const PAN_RELEASE_MAX_GAP_MS = 50
	const PAN_MOMENTUM_STOP_PX = 0.5
	const PAN_KEYFRAME_INTERVAL_MS = 1000 / 60
	const PAN_GRAB_BRAKE_MS = 96
	const PAN_GRAB_DRAG_SLOP_PX = 2
	const RUBBER_BAND_RESISTANCE = 0.55
	const RUBBER_BAND_LIMIT_PX = 96
	const RUBBER_BAND_RETURN_PER_MS = 0.022
	const VIDEO_MIN_REVEAL_DELAY_MS = 180
	const VIDEO_REVEAL_WATCHDOG_MS = 5000
	// WebKit's separate video layer needs intrinsic sizing even without metadata.
	const VIDEO_LOADING_SIZE = IS_IOS_WEBKIT ? 'auto' : '100%'
	const SCOPE_ATTRIBUTE = 'data-hippo-camera-zoom'
	const STYLE_ATTRIBUTE = 'data-hippo-camera-zoom-style'
	const PREFLIGHT_STYLE_ATTRIBUTE = 'data-hippo-camera-zoom-preflight-style'
	const VIDEO_PREVIEW_ATTRIBUTE = 'data-hippo-camera-video-preview'
	const PLAYER_TAGS = new Set(['HA-HLS-PLAYER', 'HA-WEB-RTC-PLAYER'])
	const MEDIA_HOOK = Symbol.for('hippo.cameraZoom.mediaHook')
	const DIALOG_PATCH = Symbol.for('hippo.cameraZoom.dialogPatch')
	const ATTACH_SHADOW_PATCH = Symbol.for('hippo.cameraZoom.attachShadowPatch')
	const CUSTOM_ELEMENTS_DEFINE_PATCH = Symbol.for('hippo.cameraZoom.customElementsDefinePatch')
	const PLAYER_CLASS_PATCH = Symbol.for('hippo.cameraZoom.playerClassPatch')
	const cameraVideoAspectRatios = new Map()

	const shadowStyles = {
		'HA-MORE-INFO-DIALOG': /* css */ `
            /* Reserve the desktop dialog height before HA loads the camera control. */
            :host([${SCOPE_ATTRIBUTE}]) ha-adaptive-dialog {
                --ha-dialog-min-height: var(--ha-dialog-max-height);
            }

            :host([${SCOPE_ATTRIBUTE}]) .content-wrapper {
                min-height: 0;
            }

            :host([${SCOPE_ATTRIBUTE}]) .content {
                display: flex !important;
                flex-direction: column;
                min-height: 0;
                overflow: hidden !important;
            }
        `,
		'HA-ADAPTIVE-DIALOG': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) {
                --ha-dialog-show-duration: 0ms;
            }
        `,
		'HA-DIALOG': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) wa-dialog {
                --show-duration: 0ms !important;
            }

            :host([${SCOPE_ATTRIBUTE}]) .mdc-dialog__container,
            :host([${SCOPE_ATTRIBUTE}]) .mdc-dialog__surface {
                animation: none !important;
                transition: none !important;
            }
        `,
		'HA-BOTTOM-SHEET': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) wa-drawer {
                --show-duration: 0ms !important;
            }

            /* The camera stage extends to the bottom of the visual viewport. */
            :host([${SCOPE_ATTRIBUTE}]) wa-drawer::part(body) {
                padding-bottom: 0 !important;
            }

            :host([${SCOPE_ATTRIBUTE}]) .body {
                min-height: 0;
                overflow: hidden !important;
            }
        `,
		'HA-MORE-INFO-INFO': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]),
            :host([${SCOPE_ATTRIBUTE}]) .container,
            :host([${SCOPE_ATTRIBUTE}]) .content,
            :host([${SCOPE_ATTRIBUTE}]) more-info-content {
                min-height: 0;
            }

            :host([${SCOPE_ATTRIBUTE}]) .container,
            :host([${SCOPE_ATTRIBUTE}]) .content,
            :host([${SCOPE_ATTRIBUTE}]) more-info-content {
                display: flex;
                flex: 1 1 auto;
                flex-direction: column;
            }

            :host([${SCOPE_ATTRIBUTE}]) [data-domain='camera'] .content {
                --video-max-height: 100%;
                height: 100%;
                overflow: hidden;
                padding: 0;
                position: relative;
            }
        `,
		'MORE-INFO-CONTENT': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) {
                display: flex;
                flex: 1 1 auto;
                flex-direction: column;
                height: 100%;
                min-height: 0;
            }

            :host([${SCOPE_ATTRIBUTE}]) more-info-camera {
                flex: 1 1 auto;
                height: 100%;
                min-height: 0;
            }
        `,
		'MORE-INFO-CAMERA': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) {
                display: flex !important;
                flex: 1 1 auto;
                flex-direction: column;
                height: 100%;
                min-height: 0;
                overflow: hidden;
                position: relative;
            }

            :host([${SCOPE_ATTRIBUTE}]) .actions {
                display: none !important;
            }

            :host([${SCOPE_ATTRIBUTE}]) :is(.buttons, .actions):has(#microphone-button) {
                bottom: max(12px, env(safe-area-inset-bottom, 0px));
                display: flex !important;
                padding: 0;
                position: absolute;
                right: max(12px, env(safe-area-inset-right, 0px));
                z-index: 1;
            }

            :host([${SCOPE_ATTRIBUTE}]) ha-camera-stream {
                bottom: 0;
                height: auto;
                left: 0;
                min-height: 0;
                overflow: hidden;
                position: absolute;
                right: 0;
                top: 0;
            }
        `,
		'HA-CAMERA-STREAM': /* css */ `
            :host([${SCOPE_ATTRIBUTE}]) {
                align-items: center;
                display: flex !important;
                height: 100%;
                justify-content: center;
                min-height: 0;
                overflow: hidden;
                width: 100%;
            }

            :host([${SCOPE_ATTRIBUTE}]) > img,
            :host([${SCOPE_ATTRIBUTE}]) > ha-hls-player,
            :host([${SCOPE_ATTRIBUTE}]) > ha-web-rtc-player {
                height: 100%;
                max-height: 100%;
                max-width: 100%;
                min-height: 0;
                width: 100%;
            }

            :host([${SCOPE_ATTRIBUTE}]) > img {
                margin: auto;
                object-fit: contain !important;
            }
        `,
		'HA-HLS-PLAYER': mediaPlayerStyle(),
		'HA-WEB-RTC-PLAYER': mediaPlayerStyle(),
	}

	const observedRoots = new Set()
	const observer = new MutationObserver((mutations) => {
		if (disposed) return
		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				scanNode(node)
			}
		}
		if (mutations.some((mutation) => mutation.removedNodes.length)) pruneDetached()
	})

	function pruneDetached() {
		for (const [media, cleanup] of cleanups) if (!media.isConnected) cleanup()
		for (const element of originals.keys())
			if (!element.isConnected) {
				restore(element)
				scopedHosts.delete(element)
			}
		// MutationObserver otherwise retains detached shadow roots indefinitely.
		observer.disconnect()
		for (const root of observedRoots) {
			if (root.host && !root.host.isConnected) observedRoots.delete(root)
			else observer.observe(root, { childList: true, subtree: true })
		}
	}

	function mediaPlayerStyle() {
		return /* css */ `
            :host([${SCOPE_ATTRIBUTE}]:not(.hidden)) {
                align-items: center;
                display: flex !important;
                height: 100%;
                justify-content: center;
                min-height: 0;
                overflow: hidden;
                position: relative;
                width: 100%;
            }

            :host([${SCOPE_ATTRIBUTE}]) video {
                height: ${VIDEO_LOADING_SIZE} !important;
                margin: auto;
                max-height: 100% !important;
                max-width: 100% !important;
                object-fit: contain !important;
                width: ${VIDEO_LOADING_SIZE} !important;
            }

            :host([${SCOPE_ATTRIBUTE}]) img[${VIDEO_PREVIEW_ATTRIBUTE}] {
                height: 100%;
                inset: 0;
                object-fit: contain;
                pointer-events: none;
                position: absolute;
                width: 100%;
            }
        `
	}

	function isCameraEntityId(entityId) {
		return typeof entityId === 'string' && entityId.startsWith('camera.')
	}

	function shouldEnhanceDialog(dialog) {
		if (!isCameraEntityId(dialog?._entityId)) return false
		return dialog._currView == null || dialog._currView === 'info'
	}

	function composedParent(node) {
		const parent = node?.parentNode
		if (parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return parent.host
		return parent
	}

	function findComposedAncestor(node, tagName) {
		let current = node
		while (current) {
			if (current.nodeType === Node.ELEMENT_NODE && current.tagName === tagName) {
				return current
			}
			current = composedParent(current)
		}
		return null
	}

	function walkTree(node, callback) {
		if (!node) return

		if (node.nodeType === Node.ELEMENT_NODE) {
			callback(node)
			if (node.shadowRoot) {
				callback(node.shadowRoot)
				for (const child of node.shadowRoot.children) walkTree(child, callback)
			}
		}

		if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.ELEMENT_NODE) {
			for (const child of node.children ?? []) walkTree(child, callback)
		}
	}

	function observeRoot(root) {
		if (disposed || !root || observedRoots.has(root)) return
		observedRoots.add(root)
		observer.observe(root, { childList: true, subtree: true })
	}

	function ensureShadowStyle(host) {
		const css = shadowStyles[host.tagName]
		const root = host.shadowRoot
		if (!css || !root) return

		observeRoot(root)
		const existing = root.querySelector(`style[${STYLE_ATTRIBUTE}]`)
		if (existing?.textContent) return

		const style = existing ?? document.createElement('style')
		style.setAttribute(STYLE_ATTRIBUTE, '')
		style.textContent = css
		if (!existing) root.append(style)
	}

	function ensurePlayerPreflightStyle(host, root = host.shadowRoot) {
		if (!PLAYER_TAGS.has(host.tagName) || !root) return
		scopedHosts.add(host)
		const existing = root.querySelector(`style[${PREFLIGHT_STYLE_ATTRIBUTE}]`)
		if (existing?.textContent) return

		const style = existing ?? document.createElement('style')
		style.setAttribute(PREFLIGHT_STYLE_ATTRIBUTE, '')
		style.textContent = /* css */ `
            video {
                height: auto !important;
                max-height: 100% !important;
                max-width: 100% !important;
                object-fit: contain !important;
                width: auto !important;
            }
        `
		if (IS_IOS_WEBKIT)
			style.textContent += /* css */ `
            video {
                animation: hippo-camera-video-reveal 1ms step-end ${VIDEO_REVEAL_WATCHDOG_MS}ms forwards;
                visibility: hidden;
            }
            @keyframes hippo-camera-video-reveal {
                to { visibility: visible; }
            }
        `
		if (!existing) root.append(style)
	}

	function removeZoomStyle(host, style) {
		if (!style) return
		// Lit can retain the first shadow child as its insertion anchor.
		if (host.renderOptions?.renderBefore === style) style.textContent = ''
		else style.remove()
	}

	function removePlayerPreflightStyle(host) {
		if (!PLAYER_TAGS.has(host.tagName)) return
		removeZoomStyle(host, host.shadowRoot?.querySelector(`style[${PREFLIGHT_STYLE_ATTRIBUTE}]`))
	}

	function markScopedHost(host) {
		if (!shadowStyles[host.tagName]) return
		remember(host)
		scopedHosts.add(host)
		if (!shadowStyles[host.tagName]) return
		host.setAttribute(SCOPE_ATTRIBUTE, '')
		ensurePlayerPreflightStyle(host)
		ensureShadowStyle(host)

		if (host.tagName === 'HA-ADAPTIVE-DIALOG') {
			// Compatibility fallback for HA versions without MoreInfoDialog._fill.
			host.width = 'full'
		}
	}

	function activateCameraScope(dialog) {
		if (disposed) return
		remember(dialog)
		scopedHosts.add(dialog)
		dialog.setAttribute(SCOPE_ATTRIBUTE, '')
		dialog.style.setProperty('--ha-dialog-show-duration', '0ms')
		ensureShadowStyle(dialog)

		walkTree(dialog, (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) return
			markScopedHost(node)
			if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
				const cameraStream = findComposedAncestor(node, 'HA-CAMERA-STREAM')
				if (cameraStream) {
					remember(cameraStream)
					cameraStream.fitMode = 'contain'
					hookMedia(node)
				}
			}
		})
	}

	function deactivateCameraScope(dialog) {
		dialog.style.removeProperty('--ha-dialog-show-duration')
		walkTree(dialog, (node) => {
			if (node.nodeType === Node.ELEMENT_NODE) {
				node.removeAttribute(SCOPE_ATTRIBUTE)
				removePlayerPreflightStyle(node)
				cleanups.get(node)?.()
				restore(node)
				scopedHosts.delete(node)
				removeZoomStyle(node, node.shadowRoot?.querySelector(`style[${STYLE_ATTRIBUTE}]`))
			}
		})
	}

	function processElement(element) {
		if (element.hasAttribute(VIDEO_PREVIEW_ATTRIBUTE)) return
		if (element.tagName === 'HA-MORE-INFO-DIALOG') {
			if (shouldEnhanceDialog(element)) activateCameraScope(element)
			return
		}

		const dialog = findComposedAncestor(element, 'HA-MORE-INFO-DIALOG')
		if (!dialog) {
			removePlayerPreflightStyle(element)
			return
		}

		if (!shouldEnhanceDialog(dialog)) {
			if (dialog.hasAttribute(SCOPE_ATTRIBUTE)) deactivateCameraScope(dialog)
			return
		}

		markScopedHost(element)
		if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
			handlePotentialMedia(element)
		}
	}

	function scanNode(node) {
		if (disposed) return
		walkTree(node, (current) => {
			if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
				observeRoot(current)
				return
			}
			if (current.nodeType === Node.ELEMENT_NODE) processElement(current)
		})
	}

	function patchAttachShadow() {
		const current = HTMLElement.prototype.attachShadow
		if (current[ATTACH_SHADOW_PATCH] === VERSION) return

		function attachShadowAndObserve(...args) {
			const root = current.apply(this, args)
			if (disposed) return root

			// Apply the preflight before Lit renders the first video frame,
			// but only inside a camera dialog. Dashboard players own their layout.
			const dialog = findComposedAncestor(this, 'HA-MORE-INFO-DIALOG')
			if (dialog && shouldEnhanceDialog(dialog)) ensurePlayerPreflightStyle(this, root)
			observeRoot(root)
			queueMicrotask(() => scanNode(this))
			return root
		}

		Object.defineProperty(attachShadowAndObserve, ATTACH_SHADOW_PATCH, {
			value: VERSION,
		})
		HTMLElement.prototype.attachShadow = attachShadowAndObserve
		undoPatches.push(() => {
			if (HTMLElement.prototype.attachShadow === attachShadowAndObserve) HTMLElement.prototype.attachShadow = current
		})
	}

	function patchPlayerClass(Player) {
		const prototype = Player?.prototype
		if (!prototype || prototype[PLAYER_CLASS_PATCH]) return

		const originalConnectedCallback = prototype.connectedCallback
		const connected = function connectCameraPlayerWithoutFlash(...args) {
			if (disposed) return originalConnectedCallback?.apply(this, args)
			const dialog = findComposedAncestor(this, 'HA-MORE-INFO-DIALOG')
			if (dialog && shouldEnhanceDialog(dialog)) {
				this.setAttribute(SCOPE_ATTRIBUTE, '')
				ensurePlayerPreflightStyle(this)
				ensureShadowStyle(this)
			} else {
				removePlayerPreflightStyle(this)
			}

			return originalConnectedCallback?.apply(this, args)
		}
		prototype.connectedCallback = connected
		Object.defineProperty(prototype, PLAYER_CLASS_PATCH, { value: true, configurable: true })
		undoPatches.push(() => {
			if (prototype.connectedCallback === connected) prototype.connectedCallback = originalConnectedCallback
			delete prototype[PLAYER_CLASS_PATCH]
		})
	}

	function patchPlayerDefinitions() {
		for (const tagName of PLAYER_TAGS) {
			patchPlayerClass(customElements.get(tagName.toLowerCase()))
		}

		const current = customElements.define
		if (typeof current !== 'function' || current[CUSTOM_ELEMENTS_DEFINE_PATCH]) return

		function defineAndPatchCameraPlayer(name, Player, options) {
			if (PLAYER_TAGS.has(name.toUpperCase())) patchPlayerClass(Player)
			return current.call(this, name, Player, options)
		}

		Object.defineProperty(defineAndPatchCameraPlayer, CUSTOM_ELEMENTS_DEFINE_PATCH, {
			value: true,
		})
		customElements.define = defineAndPatchCameraPlayer
		undoPatches.push(() => {
			if (customElements.define === defineAndPatchCameraPlayer) customElements.define = current
		})
	}

	function patchMoreInfoDialog() {
		customElements.whenDefined('ha-more-info-dialog').then(() => {
			if (disposed) return
			const MoreInfoDialog = customElements.get('ha-more-info-dialog')
			const prototype = MoreInfoDialog?.prototype
			if (!prototype || prototype[DIALOG_PATCH]) return

			const originalShowDialog = prototype.showDialog
			if (typeof originalShowDialog !== 'function') return

			const showDialog = function showCameraDialogMaximized(params) {
				if (disposed) return originalShowDialog.call(this, params)
				remember(this)
				const isCamera = isCameraEntityId(params?.entityId)
				const view = params?.view ?? params?.tab ?? 'info'

				// This property is consumed by both current and older HA dialog styles.
				// It is set before HA schedules its first render, so there is no narrow
				// or animated intermediate camera layout.
				if (isCamera && view === 'info') {
					this.style.setProperty('--ha-dialog-show-duration', '0ms')
					this.setAttribute(SCOPE_ATTRIBUTE, '')
					ensureShadowStyle(this)
				} else {
					deactivateCameraScope(this)
				}

				const result = originalShowDialog.call(this, params)

				if (isCamera) {
					// HA currently derives width="full" from this state. Setting it in
					// the same task as showDialog makes the first rendered frame full.
					this._fill = true
					this.requestUpdate?.()
					if (view === 'info') activateCameraScope(this)
				}

				return result
			}

			prototype.showDialog = showDialog
			Object.defineProperty(prototype, DIALOG_PATCH, { value: true, configurable: true })
			undoPatches.push(() => {
				if (prototype.showDialog === showDialog) prototype.showDialog = originalShowDialog
				delete prototype[DIALOG_PATCH]
			})
		})
	}

	function calculateZoomState(state, rect, viewport, requestedScale, clientX, clientY) {
		const oldScale = Math.max(MIN_SCALE, state.scale || MIN_SCALE)
		const newScale = Math.max(MIN_SCALE, Number.isFinite(requestedScale) ? requestedScale : oldScale)
		const baseWidth = rect.width / oldScale
		const baseHeight = rect.height / oldScale
		const oldOffsetX = clientX - (rect.left + rect.width / 2)
		const oldOffsetY = clientY - (rect.top + rect.height / 2)
		const newOffsetX = (oldOffsetX / oldScale) * newScale
		const newOffsetY = (oldOffsetY / oldScale) * newScale
		const bounds = getPanBounds(baseWidth * newScale, baseHeight * newScale, viewport ?? { width: baseWidth, height: baseHeight })
		return calculatePanState({ ...state, scale: newScale }, bounds, oldOffsetX - newOffsetX, oldOffsetY - newOffsetY)
	}

	function getPanBounds(width, height, viewport) {
		return { x: Math.max(0, (width - (viewport?.width ?? width)) / 2), y: Math.max(0, (height - (viewport?.height ?? height)) / 2) }
	}

	function rubberBandPosition(from, delta, limit) {
		const startEdge = clamp(from, -limit, limit)
		const stretch = from - startEdge
		// Invert the compression if a new drag catches the image while stretched.
		const remaining = Math.max(1, RUBBER_BAND_LIMIT_PX - Math.abs(stretch))
		const start = startEdge + (RUBBER_BAND_LIMIT_PX * stretch) / (RUBBER_BAND_RESISTANCE * remaining)
		const moved = start + delta
		const edge = clamp(moved, -limit, limit)
		const overflow = (moved - edge) * RUBBER_BAND_RESISTANCE
		return edge + (overflow * RUBBER_BAND_LIMIT_PX) / (RUBBER_BAND_LIMIT_PX + Math.abs(overflow))
	}

	function calculatePanState(state, bounds, deltaX, deltaY, elastic = false) {
		return {
			scale: state.scale,
			x: elastic ? rubberBandPosition(state.x, deltaX, bounds.x) : clamp(state.x + deltaX, -bounds.x, bounds.x),
			y: elastic ? rubberBandPosition(state.y, deltaY, bounds.y) : clamp(state.y + deltaY, -bounds.y, bounds.y),
		}
	}

	function panMotionAxis(from, velocity, limit) {
		const edge = clamp(from, -limit, limit)
		if (from !== edge) {
			// A critically damped return keeps the image on the stretched side
			// of the edge and carries over some of the release velocity.
			const stretch = from - edge
			const distance = Math.abs(stretch)
			const direction = Math.sign(stretch)
			const rate = RUBBER_BAND_RETURN_PER_MS
			const outwardVelocity = clamp(velocity * direction, -rate * distance, rate * Math.min(distance, Math.max(0, RUBBER_BAND_LIMIT_PX - distance)))
			return { target: edge, at: (time) => edge + direction * (distance + (outwardVelocity + rate * distance) * time) * Math.exp(-rate * time) }
		}

		const projection = (velocity * PAN_DECELERATION_PER_MS) / (1 - PAN_DECELERATION_PER_MS)
		const target = clamp(from + projection, -limit, limit)
		const distance = target - from
		// Brake earlier when the edge is closer than the projected stopping point.
		// Scaling the decay preserves the launch speed without a hard clamp mid-flight.
		const rate = distance === 0 ? 0 : Math.log(PAN_DECELERATION_PER_MS) * Math.abs(projection / distance)
		return { target, at: (time) => target - distance * Math.exp(rate * time) }
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value))
	}

	function calculateContainedSize(containerWidth, containerHeight, aspectRatio) {
		if (!Number.isFinite(containerWidth) || !Number.isFinite(containerHeight) || !Number.isFinite(aspectRatio) || containerWidth <= 0 || containerHeight <= 0 || aspectRatio <= 0) {
			return { width: 0, height: 0 }
		}

		if (containerWidth / containerHeight > aspectRatio) {
			return {
				width: containerHeight * aspectRatio,
				height: containerHeight,
			}
		}

		return {
			width: containerWidth,
			height: containerWidth / aspectRatio,
		}
	}

	function getUsableMediaAspectRatio(media) {
		const intrinsicWidth = media.videoWidth || media.naturalWidth
		const intrinsicHeight = media.videoHeight || media.naturalHeight
		// Until metadata arrives, the element can be sized by its alt text or poster.
		const intrinsicAspectRatio = intrinsicWidth > 0 && intrinsicHeight > 0 ? intrinsicWidth / intrinsicHeight : 0
		if (media.tagName !== 'VIDEO') return intrinsicAspectRatio

		const dialog = findComposedAncestor(media, 'HA-MORE-INFO-DIALOG')
		const entityId = dialog?._entityId
		if (intrinsicAspectRatio > 0 && isCameraEntityId(entityId)) {
			cameraVideoAspectRatios.set(entityId, intrinsicAspectRatio)
		}

		return intrinsicAspectRatio || cameraVideoAspectRatios.get(entityId) || 0
	}

	function getCameraViewport(media) {
		const dialog = findComposedAncestor(media, 'HA-MORE-INFO-DIALOG')
		const content = dialog?.shadowRoot?.querySelector('.content.ha-scrollbar, .content')
		let rect = content?.getBoundingClientRect()
		if (content && rect?.width > 0) {
			const visualTop = window.visualViewport?.offsetTop ?? 0
			const visualHeight = window.visualViewport?.height ?? window.innerHeight
			let availableHeight = visualTop + visualHeight - rect.top
			const computedMaxHeight = getComputedStyle(content).maxHeight

			if (/^\d+(?:\.\d+)?px$/.test(computedMaxHeight)) {
				availableHeight = Math.min(availableHeight, parseFloat(computedMaxHeight))
			}

			if (availableHeight > 0) {
				const height = `${availableHeight}px`

				// Desktop HA derives dialog height from its contents. Give the
				// content area a real height before its inner stream becomes
				// absolutely positioned, otherwise only the header remains.
				content.style.setProperty('flex', `0 0 ${height}`, 'important')
				content.style.setProperty('height', height, 'important')
				content.style.setProperty('max-height', height, 'important')
				content.style.setProperty('min-height', height, 'important')
				rect = content.getBoundingClientRect()
			}

			if (rect.height > 0) return { element: content, rect }
		}

		const cameraControl = findComposedAncestor(media, 'MORE-INFO-CAMERA')
		const fallbackRect = cameraControl?.getBoundingClientRect()
		if (fallbackRect?.width > 0 && fallbackRect.height > 0) {
			return { element: cameraControl, rect: fallbackRect }
		}

		return null
	}

	function fitMediaToViewport(media) {
		const viewport = getCameraViewport(media)
		if (!viewport) return null

		const cameraControl = findComposedAncestor(media, 'MORE-INFO-CAMERA')
		const cameraStream = findComposedAncestor(media, 'HA-CAMERA-STREAM')
		const player = findComposedAncestor(media, 'HA-HLS-PLAYER') || findComposedAncestor(media, 'HA-WEB-RTC-PLAYER')
		for (const element of [media, cameraControl, cameraStream, player]) if (element) remember(element)
		const stageHeight = `${viewport.rect.height}px`

		// Explicit pixels break HA's circular percentage-height chain. Without
		// a definite stage height, a landscape dialog sizes a 4:3 image from
		// its width and merely clips the resulting excessive height.
		if (cameraControl) {
			cameraControl.style.setProperty('display', 'block', 'important')
			cameraControl.style.setProperty('flex', `0 0 ${stageHeight}`, 'important')
			cameraControl.style.setProperty('height', stageHeight, 'important')
			cameraControl.style.setProperty('max-height', stageHeight, 'important')
			cameraControl.style.setProperty('min-height', stageHeight, 'important')
			cameraControl.style.setProperty('overflow', 'hidden', 'important')
			cameraControl.style.setProperty('position', 'relative', 'important')
			cameraControl.style.setProperty('width', '100%', 'important')
		}

		if (cameraStream) {
			cameraStream.style.setProperty('align-items', 'center', 'important')
			cameraStream.style.setProperty('display', 'flex', 'important')
			cameraStream.style.setProperty('height', '100%', 'important')
			cameraStream.style.setProperty('inset', '0', 'important')
			cameraStream.style.setProperty('justify-content', 'center', 'important')
			cameraStream.style.setProperty('overflow', 'hidden', 'important')
			cameraStream.style.setProperty('position', 'absolute', 'important')
			cameraStream.style.setProperty('width', '100%', 'important')
		}

		if (player) {
			player.style.setProperty('align-items', 'center', 'important')
			player.style.setProperty('height', '100%', 'important')
			player.style.setProperty('justify-content', 'center', 'important')
			player.style.setProperty('overflow', 'hidden', 'important')
			player.style.setProperty('width', '100%', 'important')
		}

		const { width, height } = calculateContainedSize(viewport.rect.width, viewport.rect.height, getUsableMediaAspectRatio(media))

		if (!width || !height) {
			// Let object-fit contain the image or poster in the stage before its dimensions are known.
			const loadingSize = media.tagName === 'VIDEO' ? VIDEO_LOADING_SIZE : '100%'
			media.style.setProperty('display', 'block', 'important')
			media.style.setProperty('flex', '0 0 auto', 'important')
			media.style.setProperty('height', loadingSize, 'important')
			media.style.setProperty('max-height', '100%', 'important')
			media.style.setProperty('max-width', '100%', 'important')
			media.style.setProperty('object-fit', 'contain', 'important')
			media.style.setProperty('width', loadingSize, 'important')
			return viewport
		}

		media.style.setProperty('display', 'block', 'important')
		media.style.setProperty('flex', '0 0 auto', 'important')
		media.style.setProperty('height', `${height}px`, 'important')
		media.style.setProperty('max-height', '100%', 'important')
		media.style.setProperty('max-width', '100%', 'important')
		media.style.setProperty('object-fit', 'contain', 'important')
		media.style.setProperty('width', `${width}px`, 'important')
		return viewport
	}

	function zoomTransform(state) {
		// A 3D transform makes WKWebView reuse the media's pre-zoom raster,
		// which leaves enlarged camera pixels blurry despite a full-resolution source.
		const translation = IS_IOS_WEBKIT ? `translate(${state.x}px, ${state.y}px)` : `translate3d(${state.x}px, ${state.y}px, 0)`
		return `${translation} scale(${state.scale})`
	}

	function animationState(states, progress) {
		const index = clamp(progress, 0, 1) * (states.length - 1)
		const lower = Math.floor(index)
		const from = states[lower]
		const target = states[Math.ceil(index)]
		const fraction = index - lower
		return { scale: from.scale + (target.scale - from.scale) * fraction, x: from.x + (target.x - from.x) * fraction, y: from.y + (target.y - from.y) * fraction }
	}

	function hookMedia(media) {
		if (disposed || media.hasAttribute(VIDEO_PREVIEW_ATTRIBUTE)) return
		remember(media)
		if (media[MEDIA_HOOK]) {
			media[MEDIA_HOOK].refit()
			return
		}

		let mediaActive = true
		const events = new AbortController()
		const listen = (target, type, callback, options = {}) => target?.addEventListener(type, callback, { ...options, signal: events.signal })
		let state = { scale: MIN_SCALE, x: 0, y: 0 }
		let viewportRect = null
		let panOrigin = null
		let pinchDistance = null
		let tap = null
		let lastTap = null
		let lastPointerType = null
		let sheetTouch = null
		let motionFrame = null
		let transformAnimation = null
		let revealCheckTimer = null
		let revealWatchdogTimer = null
		let revealFrame = null
		let revealGeneration = 0
		let revealPending = false
		let revealStartedAt = 0
		const pointers = new Map()
		const mediaRoot = media.getRootNode()
		const previewRoot = IS_IOS_WEBKIT && media.tagName === 'VIDEO' && PLAYER_TAGS.has(mediaRoot.host?.tagName) ? mediaRoot : null
		const previewStream = previewRoot && findComposedAncestor(media, 'HA-CAMERA-STREAM')
		let previewImage

		const syncVideoPreview = () => {
			if (!previewRoot) return
			const liveVisible = media.style.getPropertyValue('visibility') === 'visible' && media.readyState >= media.HAVE_CURRENT_DATA && media.videoWidth > 0
			const source = media.getAttribute('poster') || previewStream?.stateObj?.attributes?.entity_picture
			if (liveVisible || !source) {
				previewImage?.remove()
				previewImage = undefined
				return
			}
			// WebKit hides the video's own poster together with the video layer.
			if (!previewImage) {
				previewImage = document.createElement('img')
				previewImage.alt = ''
				previewImage.setAttribute(VIDEO_PREVIEW_ATTRIBUTE, '')
				previewRoot.append(previewImage)
			}
			if (previewImage.getAttribute('src') !== source) previewImage.src = source
		}
		const posterObserver = previewRoot && new MutationObserver(syncVideoPreview)
		posterObserver?.observe(media, { attributes: true, attributeFilter: ['poster'] })

		media.style.touchAction = 'none'
		media.style.userSelect = 'none'
		media.style.cursor = 'grab'
		media.style.transformOrigin = '50% 50%'
		if (media.tagName === 'VIDEO' && !IS_IOS_WEBKIT) media.controls = false

		const renderState = () => {
			if (disposed || !mediaActive) return
			media.style.transform = zoomTransform(state)
		}

		const stopCameraMotion = (keepCurrent = true) => {
			if (motionFrame != null) cancelAnimationFrame(motionFrame)
			motionFrame = null
			if (!transformAnimation) return

			const { states, animation } = transformAnimation
			transformAnimation = null
			if (keepCurrent) state = animationState(states, animation.effect.getComputedTiming().progress ?? 0)
			animation.cancel()
			// The inline styles normally hold the destination. On interruption
			// commit the visible intermediate state before the next gesture reads it.
			if (keepCurrent) renderState()
		}

		const playCameraMotion = (states, duration, easing, { fallbackDuration = duration, onFinish } = {}) => {
			if (typeof media.animate === 'function') {
				const animation = media.animate(
					states.map((frame) => ({ transform: zoomTransform(frame) })),
					{ duration, easing, fill: 'both' }
				)
				transformAnimation = { states, animation, duration, easing }
				animation.onfinish = () => {
					if (transformAnimation?.animation !== animation) return
					stopCameraMotion(false)
					onFinish?.()
				}
				state = states.at(-1)
				renderState()
				return
			}

			const startedAt = performance.now()
			const advance = (now) => {
				const progress = clamp((now - startedAt) / fallbackDuration, 0, 1)
				// Keep the previous ease-out curve for the double-tap fallback.
				state = animationState(states, easing === 'ease-in-out' ? 1 - (1 - progress) ** 3 : progress)
				renderState()
				motionFrame = progress < 1 ? requestAnimationFrame(advance) : null
				if (progress === 1) onFinish?.()
			}
			motionFrame = requestAnimationFrame(advance)
		}

		const refit = () => {
			if (disposed || !mediaActive) return null
			const previousWidth = media.style.width
			const previousHeight = media.style.height
			const viewport = fitMediaToViewport(media)
			const nextRect = viewport?.rect ?? null
			const geometryChanged =
				media.style.width !== previousWidth || media.style.height !== previousHeight || viewportRect?.width !== nextRect?.width || viewportRect?.height !== nextRect?.height
			viewportRect = nextRect
			// Playback events also refit the media. Preserve ongoing motion unless
			// fitting changes the video size or the available travel at the edge.
			if (geometryChanged) {
				if (panOrigin) {
					panOrigin.bounds = null
					if (panOrigin.samples) panOrigin.samples.length = 0
				}
				stopCameraMotion()
			}
			if (!viewport || transformAnimation || motionFrame != null || (panOrigin && !geometryChanged)) return viewport?.element ?? null
			const rect = media.getBoundingClientRect()
			state = calculatePanState(state, getPanBounds(rect.width, rect.height, viewportRect), 0, 0)
			renderState()
			return viewport.element
		}

		const finishVideoReveal = (generation) => {
			if (!revealPending || generation !== revealGeneration) return
			revealPending = false
			clearTimeout(revealCheckTimer)
			clearTimeout(revealWatchdogTimer)
			refit()

			// Let WebKit commit the fitted box before its hardware-video layer
			// becomes visible. One frame was insufficient in the HA iOS app.
			revealFrame = requestAnimationFrame(() => {
				if (generation !== revealGeneration) return
				revealFrame = requestAnimationFrame(() => {
					if (generation !== revealGeneration) return
					media.style.setProperty('visibility', 'visible', 'important')
					syncVideoPreview()
					revealFrame = null
				})
			})
		}

		const checkVideoReveal = (generation) => {
			if (!revealPending || generation !== revealGeneration) return
			clearTimeout(revealCheckTimer)

			const elapsed = performance.now() - revealStartedAt
			const usableAspectRatio = getUsableMediaAspectRatio(media)
			if (elapsed >= VIDEO_MIN_REVEAL_DELAY_MS && usableAspectRatio > 0) {
				finishVideoReveal(generation)
				return
			}

			const delay = elapsed < VIDEO_MIN_REVEAL_DELAY_MS ? VIDEO_MIN_REVEAL_DELAY_MS - elapsed : 25
			revealCheckTimer = setTimeout(() => checkVideoReveal(generation), delay)
		}

		const scheduleVideoReveal = () => {
			if (media.tagName !== 'VIDEO' || !IS_IOS_WEBKIT) return

			revealGeneration += 1
			const generation = revealGeneration
			revealPending = true
			revealStartedAt = performance.now()
			clearTimeout(revealCheckTimer)
			clearTimeout(revealWatchdogTimer)
			if (revealFrame != null) cancelAnimationFrame(revealFrame)
			media.style.setProperty('visibility', 'hidden', 'important')
			syncVideoPreview()

			// The normal gate waits for both the short compositor-settle period
			// and a trustworthy current or cached aspect ratio. The watchdog is
			// intentionally only a fail-open escape hatch, never the normal path.
			revealCheckTimer = setTimeout(() => checkVideoReveal(generation), VIDEO_MIN_REVEAL_DELAY_MS)
			revealWatchdogTimer = setTimeout(() => finishVideoReveal(generation), VIDEO_REVEAL_WATCHDOG_MS)
		}

		media[MEDIA_HOOK] = { refit, scheduleVideoReveal }
		const viewport = refit()
		scheduleVideoReveal()

		const beginPan = (pointer) => {
			const elastic = pointer.pointerType === 'touch' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
			panOrigin = {
				clientX: pointer.clientX,
				clientY: pointer.clientY,
				state: { ...state },
				bounds: null,
				elastic,
				samples: elastic ? [{ x: state.x, y: state.y, timeStamp: pointer.timeStamp }] : null,
			}
			media.style.cursor = 'grabbing'
		}

		const settlePan = (releaseTime) => {
			const from = state
			let bounds = panOrigin?.bounds
			if (!bounds) {
				const rect = media.getBoundingClientRect()
				bounds = getPanBounds(rect.width, rect.height, viewportRect)
			}
			if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
				state = calculatePanState(from, bounds, 0, 0)
				renderState()
				return
			}

			const samples = releaseTime == null ? null : panOrigin?.samples
			const first = samples?.find((sample) => releaseTime - sample.timeStamp <= PAN_VELOCITY_WINDOW_MS)
			const last = samples?.at(-1)
			const elapsed = first && last && releaseTime - last.timeStamp <= PAN_RELEASE_MAX_GAP_MS ? releaseTime - first.timeStamp : 0
			const x = panMotionAxis(from.x, elapsed > 0 ? (last.x - first.x) / elapsed : 0, bounds.x)
			const y = panMotionAxis(from.y, elapsed > 0 ? (last.y - first.y) / elapsed : 0, bounds.y)
			const target = { scale: from.scale, x: x.target, y: y.target }
			if (Math.hypot(target.x - from.x, target.y - from.y) <= PAN_MOMENTUM_STOP_PX) {
				state = target
				renderState()
				return
			}

			// A linear transform animation between these samples runs without JS
			// on each frame. Both axes share a timeline but can settle separately.
			const states = [from]
			for (let step = 1; ; step++) {
				const next = { scale: from.scale, x: x.at(step * PAN_KEYFRAME_INTERVAL_MS), y: y.at(step * PAN_KEYFRAME_INTERVAL_MS) }
				if (Math.hypot(target.x - next.x, target.y - next.y) <= PAN_MOMENTUM_STOP_PX) {
					states.push(target)
					break
				}
				states.push(next)
			}
			playCameraMotion(states, (states.length - 1) * PAN_KEYFRAME_INTERVAL_MS, 'linear')
		}

		const beginPinch = () => {
			const [first, second] = [...pointers.values()]
			pinchDistance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
			panOrigin = null
		}

		const toggleZoom = (clientX, clientY) => {
			stopCameraMotion()
			const from = { ...state }
			const target = { scale: MIN_SCALE, x: 0, y: 0 }
			if (state.scale === MIN_SCALE) {
				const rect = media.getBoundingClientRect()
				const viewport = getCameraViewport(media)?.rect ?? rect
				// Cover both viewport dimensions, with the existing 2x zoom as a minimum.
				target.scale = rect.width > 0 && rect.height > 0 ? Math.max(DOUBLE_TAP_SCALE, viewport.width / rect.width, viewport.height / rect.height) : DOUBLE_TAP_SCALE
				// Center the tapped detail without exposing empty edges in the viewport.
				const bounds = getPanBounds(rect.width * target.scale, rect.height * target.scale, viewport)
				target.x = clamp((rect.left + rect.width / 2 - clientX) * target.scale, -bounds.x, bounds.x)
				target.y = clamp((rect.top + rect.height / 2 - clientY) * target.scale, -bounds.y, bounds.y)
			}
			if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
				state = target
				renderState()
			} else playCameraMotion([from, target], ZOOM_ANIMATION_MS, 'ease-in-out', { fallbackDuration: FALLBACK_ZOOM_ANIMATION_MS })
		}

		listen(media, 'pointerdown', (event) => {
			if (event.button !== 0) return
			event.preventDefault()
			event.stopPropagation()
			const coast = pointers.size === 0 && event.pointerType === 'touch' && transformAnimation?.easing === 'linear' ? transformAnimation : null
			const progress = coast?.animation.effect.getComputedTiming().progress
			stopCameraMotion()
			lastPointerType = event.pointerType
			pointers.set(event.pointerId, event)
			media.setPointerCapture?.(event.pointerId)

			if (pointers.size === 1) {
				tap = { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp }
				beginPan(event)
				if (coast && progress != null && panOrigin.elastic) {
					// This curve starts at twice the average speed and eases to rest.
					// Advance by half the braking time along the original trajectory.
					const target = animationState(coast.states, progress + PAN_GRAB_BRAKE_MS / (2 * coast.duration))
					if (Math.hypot(target.x - state.x, target.y - state.y) > PAN_MOMENTUM_STOP_PX) {
						panOrigin.braking = true
						playCameraMotion([state, target], PAN_GRAB_BRAKE_MS, 'cubic-bezier(0.25, 0.5, 0.5, 1)', {
							onFinish: () => {
								if (!pointers.size) settlePan(null)
							},
						})
					}
				}
			} else {
				tap = lastTap = null
				if (pointers.size === 2 && sheetTouch?.mode !== 'sheet') beginPinch()
			}
		})

		listen(media, 'pointermove', (event) => {
			const previousPointer = pointers.get(event.pointerId)
			if (!previousPointer) return
			event.preventDefault()
			event.stopPropagation()
			pointers.set(event.pointerId, event)
			if (tap && Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) > TAP_SLOP_PX) tap = lastTap = null
			if (sheetTouch?.mode === 'sheet') return

			if (pointers.size >= 2) {
				const [first, second] = [...pointers.values()]
				const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
				if (!pinchDistance || !distance) return

				const clientX = (first.clientX + second.clientX) / 2
				const clientY = (first.clientY + second.clientY) / 2
				state = calculateZoomState(state, media.getBoundingClientRect(), viewportRect, state.scale * (distance / pinchDistance), clientX, clientY)
				pinchDistance = distance
				renderState()
				return
			}

			if (panOrigin?.braking) {
				if (Math.hypot(event.clientX - panOrigin.clientX, event.clientY - panOrigin.clientY) <= PAN_GRAB_DRAG_SLOP_PX) return
				// A drag takes over from the currently displayed position.
				stopCameraMotion()
				beginPan(previousPointer)
			}
			if (!panOrigin || panOrigin.state.scale === MIN_SCALE) return
			// Translation leaves the box size unchanged. Reuse it until a refit,
			// unless another input changed the zoom since this drag began.
			const sameScale = state.scale === panOrigin.state.scale
			let bounds = sameScale ? panOrigin.bounds : null
			if (!bounds) {
				const rect = media.getBoundingClientRect()
				const scaleRatio = panOrigin.state.scale / state.scale
				bounds = getPanBounds(rect.width * scaleRatio, rect.height * scaleRatio, viewportRect)
				panOrigin.bounds = bounds
			}
			state = calculatePanState(panOrigin.state, bounds, event.clientX - panOrigin.clientX, event.clientY - panOrigin.clientY, panOrigin.elastic)
			const { samples } = panOrigin
			if (samples && state.scale > MIN_SCALE) {
				while (samples.length && event.timeStamp - samples[0].timeStamp > PAN_VELOCITY_WINDOW_MS) samples.shift()
				samples.push({ x: state.x, y: state.y, timeStamp: event.timeStamp })
			}
			renderState()
		})

		const endPointer = (event) => {
			if (!pointers.has(event.pointerId)) return
			event.stopPropagation()
			// Only short, stationary, completed single-pointer gestures count as taps.
			// Cancellation and a pinch's remaining finger must never complete a pair.
			if (
				event.type === 'pointerup' &&
				event.pointerType !== 'mouse' &&
				tap?.pointerId === event.pointerId &&
				event.timeStamp - tap.timeStamp <= DOUBLE_TAP_DELAY_MS &&
				Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) <= TAP_SLOP_PX
			) {
				if (
					lastTap &&
					lastTap.pointerType === event.pointerType &&
					tap.timeStamp - lastTap.timeStamp <= DOUBLE_TAP_DELAY_MS &&
					Math.hypot(event.clientX - lastTap.clientX, event.clientY - lastTap.clientY) <= DOUBLE_TAP_DISTANCE_PX
				) {
					toggleZoom(event.clientX, event.clientY)
					lastTap = null
				} else lastTap = { pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp }
			} else lastTap = null
			if (panOrigin && pointers.size === 1 && state.scale > MIN_SCALE && !transformAnimation && motionFrame == null) {
				const releaseTime = !tap && event.type === 'pointerup' && event.pointerType === 'touch' ? event.timeStamp : null
				settlePan(releaseTime)
			}
			tap = null
			pointers.delete(event.pointerId)
			pinchDistance = null

			if (pointers.size === 1) beginPan([...pointers.values()][0])
			else {
				panOrigin = null
				media.style.cursor = 'grab'
			}
		}

		listen(media, 'pointerup', endPointer)
		listen(media, 'pointercancel', endPointer)
		listen(media, 'lostpointercapture', endPointer)

		listen(media, 'dblclick', (event) => {
			// Native mouse timing follows the OS preference. Touch/pen pairs are
			// handled above, so their compatibility events must not toggle again.
			if (lastPointerType !== 'mouse' || event.button !== 0) return
			event.preventDefault()
			event.stopPropagation()
			tap = lastTap = null
			toggleZoom(event.clientX, event.clientY)
		})

		listen(
			media,
			'wheel',
			(event) => {
				event.preventDefault()
				event.stopPropagation()
				stopCameraMotion()
				tap = lastTap = null

				const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
				const factor = Math.exp(-event.deltaY * unit * 0.0015)
				state = calculateZoomState(state, media.getBoundingClientRect(), viewportRect, state.scale * factor, event.clientX, event.clientY)
				renderState()
			},
			{ passive: false }
		)

		// HA needs the original touchstart to track the drag on document. Forward
		// moves only once a single finger has committed to dragging the sheet down.
		for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
			listen(
				media,
				type,
				(event) => {
					if (type === 'touchstart') {
						if (
							!sheetTouch &&
							event.touches.length === 1 &&
							state.scale === MIN_SCALE &&
							!transformAnimation &&
							motionFrame == null &&
							event.composedPath().some((node) => node.tagName === 'HA-BOTTOM-SHEET')
						) {
							const { identifier, clientX, clientY } = event.touches[0]
							sheetTouch = { identifier, clientX, clientY, mode: 'pending' }
							return
						}
						if (sheetTouch?.mode === 'pending') sheetTouch.mode = 'camera'
					} else if (type === 'touchmove') {
						const touch = event.touches[0]
						if (event.touches.length === 1 && sheetTouch?.identifier === touch.identifier) {
							if (sheetTouch.mode === 'pending') {
								const dx = touch.clientX - sheetTouch.clientX
								const dy = touch.clientY - sheetTouch.clientY
								if (Math.hypot(dx, dy) > TAP_SLOP_PX) sheetTouch.mode = dy > Math.abs(dx) ? 'sheet' : 'camera'
							}
							if (sheetTouch.mode === 'sheet') return
						}
					} else if (sheetTouch && Array.from(event.changedTouches).some((touch) => touch.identifier === sheetTouch.identifier)) {
						// Release HA's document listeners even when this became a tap or pinch.
						sheetTouch = null
						return
					}
					event.stopPropagation()
					if (type === 'touchmove') event.preventDefault()
				},
				{ passive: false }
			)
		}

		listen(media, 'dragstart', (event) => event.preventDefault())
		for (const type of ['load', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'resize']) {
			listen(media, type, () => {
				refit()
				if (revealPending) checkVideoReveal(revealGeneration)
				syncVideoPreview()
			})
		}
		listen(media, 'loadstart', scheduleVideoReveal)

		const resize = () => {
			stopCameraMotion()
			refit()
		}
		const resizeObserver = viewport && typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
		if (resizeObserver) resizeObserver.observe(viewport)

		requestAnimationFrame(refit)
		listen(window, 'resize', resize)
		listen(window.visualViewport, 'resize', resize)

		const dialog = findComposedAncestor(media, 'HA-MORE-INFO-DIALOG')
		const cleanup = () => {
			mediaActive = false
			events.abort()
			stopCameraMotion(false)
			revealPending = false
			revealGeneration += 1
			clearTimeout(revealCheckTimer)
			clearTimeout(revealWatchdogTimer)
			if (revealFrame != null) cancelAnimationFrame(revealFrame)
			resizeObserver?.disconnect()
			posterObserver?.disconnect()
			previewImage?.remove()
			delete media[MEDIA_HOOK]
			restore(media)
			cleanups.delete(media)
		}
		cleanups.set(media, cleanup)
		listen(dialog, 'closed', cleanup, { once: true })
	}

	function handlePotentialMedia(media) {
		const cameraStream = findComposedAncestor(media, 'HA-CAMERA-STREAM')
		const dialog = findComposedAncestor(media, 'HA-MORE-INFO-DIALOG')
		if (!cameraStream || !dialog) return

		// The media itself is definitive evidence for older HA versions that do
		// not expose _entityId on the dialog instance.
		if (!shouldEnhanceDialog(dialog) && dialog._entityId != null) return

		activateCameraScope(dialog)
		remember(cameraStream)
		cameraStream.fitMode = 'contain'
		hookMedia(media)
	}

	patchPlayerDefinitions()
	patchAttachShadow()
	patchMoreInfoDialog()
	observeRoot(document.documentElement)
	scanNode(document.documentElement)

	return () => {
		if (disposed) return
		disposed = true
		observer.disconnect()
		for (const cleanup of [...cleanups.values()]) cleanup()
		for (const undo of undoPatches.reverse()) undo()
		for (const element of originals.keys()) restore(element)
		for (const host of scopedHosts) {
			host.removeAttribute(SCOPE_ATTRIBUTE)
			for (const style of host.shadowRoot?.querySelectorAll(`style[${STYLE_ATTRIBUTE}], style[${PREFLIGHT_STYLE_ATTRIBUTE}]`) ?? []) removeZoomStyle(host, style)
		}
		scopedHosts.clear()
		observedRoots.clear()
		cameraVideoAspectRatios.clear()
	}
}
