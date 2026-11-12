const START_TIMEOUT = 15000

// A slow handshake can still succeed, so wait for playable video or a terminal error.
export function watchVideoStart(player, onFailure) {
	let deadline = Date.now() + START_TIMEOUT
	let started = false
	let failed = false

	function check() {
		if (!player.isConnected || document.hidden || navigator.onLine === false || player.classList.contains('hidden')) return
		if (player.microphoneTrack || ['on', 'connecting'].includes(player.microphoneState)) return
		if (failed || player._error) {
			onFailure()
			return
		}
		const video = player.shadowRoot?.querySelector('video')
		if (video?.videoWidth > 0 && video.readyState >= 2) started = true
		if (!started && Date.now() >= deadline) onFailure()
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
			deadline = Date.now() + START_TIMEOUT
		},
		dispose() {
			player.removeEventListener('streams', onStreams)
		},
	}
}
