/* Camera dialog zoom, pan and aspect-ratio corrections. */
export function installCameraZoom() {
	const VERSION = 26
	let disposed = false
	const undoPatches = []
	const cleanups = new Map()
	const originals = new Map()
	const scopedHosts = new Set()

	function remember(element) {
		if (!originals.has(element))
			originals.set(element, {
				style: element.getAttribute('style'),
				controls: element.controls,
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
		if ('controls' in element) element.controls = saved.controls
		if ('fitMode' in element) element.fitMode = saved.fitMode
		if (element.tagName === 'HA-ADAPTIVE-DIALOG') element.width = saved.width
		if (element.tagName === 'HA-MORE-INFO-DIALOG') {
			element._fill = saved.fill
			element.requestUpdate?.()
		}
		originals.delete(element)
	}

	const MIN_SCALE = 1
	const VIDEO_MIN_REVEAL_DELAY_MS = 180
	const VIDEO_REVEAL_WATCHDOG_MS = 5000
	const IS_IOS_WEBKIT = /iP(?:ad|hone|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	const SCOPE_ATTRIBUTE = 'data-hippo-camera-zoom'
	const STYLE_ATTRIBUTE = 'data-hippo-camera-zoom-style'
	const PREFLIGHT_STYLE_ATTRIBUTE = 'data-hippo-camera-zoom-preflight-style'
	const MATTE_ATTRIBUTE = 'data-hippo-camera-zoom-matte'
	const PLAYER_TAGS = new Set(['HA-HLS-PLAYER', 'HA-WEB-RTC-PLAYER'])
	const MEDIA_HOOK = Symbol.for('hippo.cameraZoom.mediaHook')
	const DIALOG_PATCH = Symbol.for('hippo.cameraZoom.dialogPatch')
	const ATTACH_SHADOW_PATCH = Symbol.for('hippo.cameraZoom.attachShadowPatch')
	const CUSTOM_ELEMENTS_DEFINE_PATCH = Symbol.for('hippo.cameraZoom.customElementsDefinePatch')
	const PLAYER_CLASS_PATCH = Symbol.for('hippo.cameraZoom.playerClassPatch')
	const CAMERA_MATTE = Symbol.for('hippo.cameraZoom.cameraMatte')
	const cameraVideoAspectRatios = new Map()

	const shadowStyles = {
		'HA-MORE-INFO-DIALOG': /* css */ `
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
                height: auto !important;
                margin: auto;
                object-fit: contain !important;
                width: auto !important;
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
            :host([${SCOPE_ATTRIBUTE}]) {
                align-items: center;
                display: flex !important;
                height: 100%;
                justify-content: center;
                min-height: 0;
                overflow: hidden;
                width: 100%;
            }

            :host([${SCOPE_ATTRIBUTE}]) video {
                height: auto !important;
                margin: auto;
                max-height: 100% !important;
                max-width: 100% !important;
                object-fit: contain !important;
                width: auto !important;
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
		if (root.querySelector(`style[${STYLE_ATTRIBUTE}]`)) return

		const style = document.createElement('style')
		style.setAttribute(STYLE_ATTRIBUTE, '')
		style.textContent = css
		root.append(style)
	}

	function ensurePlayerPreflightStyle(host, root = host.shadowRoot) {
		if (!PLAYER_TAGS.has(host.tagName) || !root) return
		scopedHosts.add(host)
		if (root.querySelector?.(`style[${PREFLIGHT_STYLE_ATTRIBUTE}]`)) return

		const style = document.createElement('style')
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
		root.append(style)
	}

	function removePlayerPreflightStyle(host) {
		if (!PLAYER_TAGS.has(host.tagName)) return
		host.shadowRoot?.querySelector(`style[${PREFLIGHT_STYLE_ATTRIBUTE}]`)?.remove()
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
				node.shadowRoot?.querySelector(`style[${STYLE_ATTRIBUTE}]`)?.remove()
			}
		})
	}

	function processElement(element) {
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

			// This executes inside the player's constructor, before Lit can
			// render its first video frame. The MutationObserver path is too
			// late for WKWebView, which may paint the default stretched video.
			ensurePlayerPreflightStyle(this, root)
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

	function calculateZoomState(state, rect, requestedScale, clientX, clientY) {
		const oldScale = Math.max(MIN_SCALE, state.scale || MIN_SCALE)
		const newScale = Math.max(MIN_SCALE, Number.isFinite(requestedScale) ? requestedScale : oldScale)
		const baseWidth = rect.width / oldScale
		const baseHeight = rect.height / oldScale
		const oldOffsetX = clientX - (rect.left + rect.width / 2)
		const oldOffsetY = clientY - (rect.top + rect.height / 2)
		const newOffsetX = (oldOffsetX / oldScale) * newScale
		const newOffsetY = (oldOffsetY / oldScale) * newScale
		const maxX = Math.max(0, (baseWidth * (newScale - MIN_SCALE)) / 2)
		const maxY = Math.max(0, (baseHeight * (newScale - MIN_SCALE)) / 2)

		return {
			scale: newScale,
			x: clamp(state.x + oldOffsetX - newOffsetX, -maxX, maxX),
			y: clamp(state.y + oldOffsetY - newOffsetY, -maxY, maxY),
		}
	}

	function calculatePanState(state, rect, deltaX, deltaY) {
		const scale = Math.max(MIN_SCALE, state.scale || MIN_SCALE)
		const baseWidth = rect.width / scale
		const baseHeight = rect.height / scale
		const maxX = Math.max(0, (baseWidth * (scale - MIN_SCALE)) / 2)
		const maxY = Math.max(0, (baseHeight * (scale - MIN_SCALE)) / 2)

		return {
			scale,
			x: clamp(state.x + deltaX, -maxX, maxX),
			y: clamp(state.y + deltaY, -maxY, maxY),
		}
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

	function getMediaAspectRatio(media) {
		const intrinsicWidth = media.videoWidth || media.naturalWidth
		const intrinsicHeight = media.videoHeight || media.naturalHeight
		if (intrinsicWidth > 0 && intrinsicHeight > 0) {
			return intrinsicWidth / intrinsicHeight
		}

		// A temporary player box is not a trustworthy video aspect ratio.
		// Safari can render the stream while keeping these JS dimensions at 0.
		if (media.tagName === 'VIDEO') return 0

		const rect = media.getBoundingClientRect()
		return rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 16 / 9
	}

	function getUsableMediaAspectRatio(media) {
		const intrinsicAspectRatio = getMediaAspectRatio(media)
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
			player.style.setProperty('display', 'flex', 'important')
			player.style.setProperty('height', '100%', 'important')
			player.style.setProperty('justify-content', 'center', 'important')
			player.style.setProperty('overflow', 'hidden', 'important')
			player.style.setProperty('width', '100%', 'important')
		}

		const { width, height } = calculateContainedSize(viewport.rect.width, viewport.rect.height, getUsableMediaAspectRatio(media))

		if (!width || !height) {
			// Fail open on iOS: its media renderer still knows the decoded
			// aspect ratio even when videoWidth/videoHeight remain unavailable
			// to JavaScript. Let CSS contain that intrinsic image instead of
			// guessing from HA's briefly stretched full-height player box.
			media.style.setProperty('display', 'block', 'important')
			media.style.setProperty('flex', '0 0 auto', 'important')
			media.style.setProperty('height', 'auto', 'important')
			media.style.setProperty('max-height', '100%', 'important')
			media.style.setProperty('max-width', '100%', 'important')
			media.style.setProperty('object-fit', 'contain', 'important')
			media.style.setProperty('width', 'auto', 'important')
			return viewport.element
		}

		media.style.setProperty('display', 'block', 'important')
		media.style.setProperty('flex', '0 0 auto', 'important')
		media.style.setProperty('height', `${height}px`, 'important')
		media.style.setProperty('max-height', '100%', 'important')
		media.style.setProperty('max-width', '100%', 'important')
		media.style.setProperty('object-fit', 'contain', 'important')
		media.style.setProperty('width', `${width}px`, 'important')
		return viewport.element
	}

	function applyTransform(media, state) {
		media.style.transformOrigin = '50% 50%'
		// A 3D transform makes WKWebView reuse the media's pre-zoom raster,
		// which leaves enlarged camera pixels blurry despite a full-resolution source.
		const translation = IS_IOS_WEBKIT ? `translate(${state.x}px, ${state.y}px)` : `translate3d(${state.x}px, ${state.y}px, 0)`
		media.style.transform = `${translation} scale(${state.scale})`
	}

	function ensureCameraMatte(media) {
		if (!IS_IOS_WEBKIT) return null

		const cameraStream = findComposedAncestor(media, 'HA-CAMERA-STREAM')
		const root = cameraStream?.shadowRoot
		if (!cameraStream || !root) return null

		const existing = cameraStream[CAMERA_MATTE]
		if (existing?.container?.isConnected) return existing

		const container = document.createElement('div')
		container.setAttribute(MATTE_ATTRIBUTE, '')
		container.style.cssText = /* css declarations */ `
            contain: layout paint;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
            position: absolute;
            z-index: 10;
        `

		const createEdge = () => {
			const edge = document.createElement('div')
			edge.style.cssText = /* css declarations */ `
                background: var(--primary-background-color, #111111);
                position: absolute;
            `
			container.append(edge)
			return edge
		}

		const matte = {
			cameraStream,
			container,
			top: createEdge(),
			right: createEdge(),
			bottom: createEdge(),
			left: createEdge(),
		}
		root.append(container)
		cameraStream[CAMERA_MATTE] = matte
		return matte
	}

	function setMatteEdge(edge, left, top, width, height) {
		edge.style.left = `${left}px`
		edge.style.top = `${top}px`
		edge.style.width = `${Math.max(0, width)}px`
		edge.style.height = `${Math.max(0, height)}px`
	}

	function updateCameraMatte(media, matte) {
		if (!matte?.container?.isConnected) return

		const viewportRect = matte.cameraStream.getBoundingClientRect()
		const mediaRect = media.getBoundingClientRect()
		if (viewportRect.width <= 0 || viewportRect.height <= 0 || mediaRect.width <= 0 || mediaRect.height <= 0) {
			matte.container.style.display = 'none'
			return
		}

		matte.container.style.display = 'block'
		const overlap = 1 / Math.max(1, window.devicePixelRatio || 1)
		const mediaTop = clamp(mediaRect.top - viewportRect.top + overlap, 0, viewportRect.height)
		const mediaRight = clamp(mediaRect.right - viewportRect.left - overlap, 0, viewportRect.width)
		const mediaBottom = clamp(mediaRect.bottom - viewportRect.top - overlap, 0, viewportRect.height)
		const mediaLeft = clamp(mediaRect.left - viewportRect.left + overlap, 0, viewportRect.width)
		const middleHeight = Math.max(0, mediaBottom - mediaTop)

		// These four opaque edges cover WebKit's stale pixels without changing
		// the media geometry or intercepting the camera's zoom and pan gestures.
		setMatteEdge(matte.top, 0, 0, viewportRect.width, mediaTop)
		setMatteEdge(matte.right, mediaRight, mediaTop, viewportRect.width - mediaRight, middleHeight)
		setMatteEdge(matte.bottom, 0, mediaBottom, viewportRect.width, viewportRect.height - mediaBottom)
		setMatteEdge(matte.left, 0, mediaTop, mediaLeft, middleHeight)
	}

	function removeCameraMatte(matte) {
		if (!matte) return
		matte.container.remove()
		if (matte.cameraStream[CAMERA_MATTE] === matte) {
			delete matte.cameraStream[CAMERA_MATTE]
		}
	}

	function hookMedia(media) {
		if (disposed) return
		remember(media)
		if (media[MEDIA_HOOK]) {
			media[MEDIA_HOOK].refit()
			return
		}

		let mediaActive = true
		const events = new AbortController()
		const listen = (target, type, callback, options = {}) => target?.addEventListener(type, callback, { ...options, signal: events.signal })
		let state = { scale: MIN_SCALE, x: 0, y: 0 }
		let panOrigin = null
		let pinchDistance = null
		let revealCheckTimer = null
		let revealWatchdogTimer = null
		let revealFrame = null
		let revealGeneration = 0
		let revealPending = false
		let revealStartedAt = 0
		let cameraMatte = null
		let cameraMatteFrame = null
		const pointers = new Map()

		media.style.touchAction = 'none'
		media.style.userSelect = 'none'
		media.style.cursor = 'grab'
		if (media.tagName === 'VIDEO') media.controls = false

		const renderState = () => {
			if (disposed || !mediaActive) return
			applyTransform(media, state)
			if (!IS_IOS_WEBKIT || cameraMatteFrame != null) return

			// Pointer events may arrive faster than WebKit can paint. Updating
			// the matte once per display frame avoids redundant layout work.
			cameraMatteFrame = requestAnimationFrame(() => {
				cameraMatteFrame = null
				cameraMatte ??= ensureCameraMatte(media)
				updateCameraMatte(media, cameraMatte)
			})
		}

		const refit = () => {
			if (disposed || !mediaActive) return null
			const viewport = fitMediaToViewport(media)
			if (!viewport) return null
			state = calculatePanState(state, media.getBoundingClientRect(), 0, 0)
			renderState()
			return viewport
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
			panOrigin = {
				clientX: pointer.clientX,
				clientY: pointer.clientY,
				state: { ...state },
			}
			media.style.cursor = 'grabbing'
		}

		const beginPinch = () => {
			const [first, second] = [...pointers.values()]
			pinchDistance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
			panOrigin = null
		}

		listen(media, 'pointerdown', (event) => {
			event.preventDefault()
			event.stopPropagation()
			pointers.set(event.pointerId, event)
			media.setPointerCapture?.(event.pointerId)

			if (pointers.size === 1) beginPan(event)
			else if (pointers.size === 2) beginPinch()
		})

		listen(media, 'pointermove', (event) => {
			if (!pointers.has(event.pointerId)) return
			event.preventDefault()
			event.stopPropagation()
			pointers.set(event.pointerId, event)

			if (pointers.size >= 2) {
				const [first, second] = [...pointers.values()]
				const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
				if (!pinchDistance || !distance) return

				const clientX = (first.clientX + second.clientX) / 2
				const clientY = (first.clientY + second.clientY) / 2
				state = calculateZoomState(state, media.getBoundingClientRect(), state.scale * (distance / pinchDistance), clientX, clientY)
				pinchDistance = distance
				renderState()
				return
			}

			if (!panOrigin) return
			state = calculatePanState(panOrigin.state, media.getBoundingClientRect(), event.clientX - panOrigin.clientX, event.clientY - panOrigin.clientY)
			renderState()
		})

		const endPointer = (event) => {
			if (!pointers.has(event.pointerId)) return
			event.stopPropagation()
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

		listen(
			media,
			'wheel',
			(event) => {
				event.preventDefault()
				event.stopPropagation()

				const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
				const factor = Math.exp(-event.deltaY * unit * 0.0015)
				state = calculateZoomState(state, media.getBoundingClientRect(), state.scale * factor, event.clientX, event.clientY)
				renderState()
			},
			{ passive: false }
		)

		// HA's mobile bottom sheet listens for touch gestures on ancestors.
		// Keeping these events local prevents a pinch from also dragging the sheet.
		for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
			listen(
				media,
				type,
				(event) => {
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
			})
		}
		listen(media, 'loadstart', scheduleVideoReveal)

		const resizeObserver = viewport && typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null
		if (resizeObserver) resizeObserver.observe(viewport)

		requestAnimationFrame(refit)
		listen(window, 'resize', refit)
		listen(window.visualViewport, 'resize', refit)

		const dialog = findComposedAncestor(media, 'HA-MORE-INFO-DIALOG')
		const cleanup = () => {
			mediaActive = false
			events.abort()
			revealPending = false
			revealGeneration += 1
			clearTimeout(revealCheckTimer)
			clearTimeout(revealWatchdogTimer)
			if (revealFrame != null) cancelAnimationFrame(revealFrame)
			if (cameraMatteFrame != null) cancelAnimationFrame(cameraMatteFrame)
			resizeObserver?.disconnect()
			removeCameraMatte(cameraMatte)
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
			for (const style of host.shadowRoot?.querySelectorAll(`style[${STYLE_ATTRIBUTE}], style[${PREFLIGHT_STYLE_ATTRIBUTE}]`) ?? []) style.remove()
		}
		scopedHosts.clear()
		observedRoots.clear()
		cameraVideoAspectRatios.clear()
	}
}
