const START_TIMEOUT = 15000
const CONNECTION_TIMEOUT = 5000

export function watchVideoStart(player, onFailure) {
	let startedAt = Date.now()
	let peer
	let connected = false
	let started = false
	let failed = false

	function detachPeer() {
		peer?.removeEventListener('iceconnectionstatechange', check, true)
		peer?.removeEventListener('connectionstatechange', check, true)
	}

	function check() {
		if (!player.isConnected || document.hidden || navigator.onLine === false || player.classList.contains('hidden')) return
		if (peer !== player._peerConnection) {
			detachPeer()
			peer = player._peerConnection
			// Observe the state before HA's handler can replace a failed peer to retry.
			peer?.addEventListener('iceconnectionstatechange', check, true)
			peer?.addEventListener('connectionstatechange', check, true)
		}
		const iceState = peer?.iceConnectionState
		connected ||= iceState === 'connected' || iceState === 'completed'
		if (player.microphoneTrack || ['on', 'connecting'].includes(player.microphoneState)) return
		if (failed || player._error) {
			onFailure()
			return
		}
		const video = player.shadowRoot?.querySelector('video')
		if (video?.videoWidth > 0 && video.readyState >= 2) started = true
		if (started) return
		const elapsed = Date.now() - startedAt
		// ICE may keep checking without emitting a failure. Once it found a
		// route, give the camera longer to deliver the first decodable frame.
		if (iceState === 'failed' || peer?.connectionState === 'failed' || (peer && !connected && elapsed >= CONNECTION_TIMEOUT) || elapsed >= START_TIMEOUT) onFailure()
	}

	function onStreams(event) {
		if (event.detail?.hasVideo === false) failed = true
		else if (event.detail?.hasVideo === true) failed = false
		check()
	}
	player.addEventListener('streams', onStreams)

	return {
		player,
		check,
		resetDeadline() {
			startedAt = Date.now()
		},
		dispose() {
			player.removeEventListener('streams', onStreams)
			detachPeer()
		},
	}
}
