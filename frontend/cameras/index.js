import { installCameraRecovery } from './recovery.js'
import { installCameraZoom } from './zoom.js'

// Bump together with CAMERA_FRONTEND_PROTOCOL for incompatible API changes.
const PROTOCOL = 1
const SETTINGS_TIMEOUT = 10000
const INSTALL_KEY = Symbol.for('hippo.toolbox.cameras')
globalThis[INSTALL_KEY]?.dispose()

let disposed = false
let unsubscribe
let stopStreams
let stopZoom
let settings
let connection
let generation = 0
let settingsTimer

function useNativeViewer(warn = false) {
	// Invalidate callbacks before restoring hooks: late replies from an old
	// connection or a timed-out subscription must never reactivate features.
	generation++
	clearTimeout(settingsTimer)
	const stopSubscription = unsubscribe
	unsubscribe = undefined
	if (stopSubscription)
		Promise.resolve()
			.then(stopSubscription)
			.catch(() => {})
	const disposers = [stopZoom, stopStreams]
	stopZoom = stopStreams = settings = undefined
	for (const stop of disposers) {
		try {
			stop?.()
		} catch {
			// A failed optional feature must not prevent the other from restoring HA.
		}
	}
	if (warn) console.warn("Hippo's Toolbox: camera extensions disabled; using the native viewer because backend communication failed or is incompatible.")
}

function disconnected() {
	useNativeViewer()
}

function applySettings(next) {
	const recovery = next.camera_recovery
	const cleanup = next.camera_stream_cleanup
	const zoom = next.camera_zoom
	if (!settings || settings.recovery !== recovery || settings.cleanup !== cleanup) {
		stopStreams?.()
		stopStreams = recovery || cleanup ? installCameraRecovery({ recovery, cleanup }) : undefined
	}
	if (!settings || settings.zoom !== zoom) {
		stopZoom?.()
		stopZoom = zoom ? installCameraZoom() : undefined
	}
	settings = { recovery, cleanup, zoom }
}

async function subscribe() {
	if (disposed) return
	useNativeViewer()
	const attempt = generation
	let acknowledged = false
	let snapshot
	settingsTimer = setTimeout(() => {
		if (attempt === generation && !disposed) useNativeViewer(true)
	}, SETTINGS_TIMEOUT)
	const receive = (next) => {
		if (disposed || attempt !== generation) return
		try {
			if (!next || next.protocol !== PROTOCOL || ['camera_zoom', 'camera_recovery', 'camera_stream_cleanup'].some((key) => typeof next[key] !== 'boolean')) {
				useNativeViewer(true)
				return
			}
			snapshot = next
			if (acknowledged) {
				applySettings(snapshot)
				clearTimeout(settingsTimer)
			}
		} catch {
			// HA invokes subscription callbacks directly. Never throw into its socket.
			useNativeViewer(true)
		}
	}
	try {
		// Own reconnect handling so a rejected resubscription is caught as well.
		const stop = await connection.subscribeMessage(receive, { type: 'hippos_toolbox/frontend/subscribe', protocol: PROTOCOL }, { resubscribe: false })
		if (disposed || attempt !== generation) {
			await stop()
			return
		}
		unsubscribe = stop
		acknowledged = true
		if (snapshot) receive(snapshot)
	} catch {
		if (!disposed && attempt === generation) useNativeViewer(true)
	}
}

function dispose() {
	if (disposed) return
	disposed = true
	useNativeViewer()
	connection?.removeEventListener('disconnected', disconnected)
	connection?.removeEventListener('ready', subscribe)
	if (globalThis[INSTALL_KEY]?.dispose === dispose) delete globalThis[INSTALL_KEY]
}

globalThis[INSTALL_KEY] = { dispose }

async function connect() {
	// Extra modules can run before the app entrypoint. HA initializes this
	// promise before defining home-assistant; no auth token or new socket is needed.
	if (!window.hassConnection) await customElements.whenDefined('home-assistant')
	const { conn } = await window.hassConnection
	if (disposed) return
	connection = conn
	connection.addEventListener('disconnected', disconnected)
	connection.addEventListener('ready', subscribe)
	if (connection.connected !== false) await subscribe()
}

connect().catch(() => {
	if (!disposed) useNativeViewer(true)
})
