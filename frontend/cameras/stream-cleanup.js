/* Native image rendering with a server-controlled response lifetime. */

function stopReservation(stream, streamId, camera) {
	return Promise.resolve()
		.then(() => stream._api.callWS({ type: 'hippos_toolbox/camera_stream/stop', stream_id: streamId }))
		.then((result) => {
			if (typeof result?.stopped !== 'boolean') throw new Error('Invalid camera stream stop response')
		})
		.catch(() => console.warn('[Hippo Camera Recovery] Could not confirm MJPEG stream stop', { camera }))
}

export function stopControlledStream(stream, state) {
	const streamId = state.streamId
	const camera = state.managedEntity
	state.streamId = null
	state.streamUrl = null
	state.generation++
	state.refreshing = false
	state.nextRetryAt = 0
	if (!streamId) return
	stopReservation(stream, streamId, camera)
}

export async function openControlledStream(stream, state, image, isActive) {
	const generation = state.generation
	const camera = state.managedEntity
	let timedOut = false
	let timer
	const request = Promise.resolve().then(() =>
		stream._api.callWS({
			type: 'hippos_toolbox/camera_stream/open',
			entity_id: camera,
			...(state.interval === null ? {} : { interval: state.interval }),
		})
	)
	// A timeout restores the native view. A reservation arriving later still
	// needs releasing, without ever assigning its URL to the image.
	request
		.then((opened) => {
			if (timedOut && typeof opened?.stream_id === 'string' && opened.stream_id) stopReservation(stream, opened.stream_id, camera)
		})
		.catch(() => {})
	let opened
	try {
		opened = await Promise.race([
			request,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true
					reject(new Error('Camera stream reservation timed out'))
				}, 10000)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
	if (typeof opened?.stream_id !== 'string' || !opened.stream_id) throw new Error('Invalid camera stream reservation')
	if (typeof opened.path !== 'string' || !opened.path.startsWith(`/api/hippos_toolbox/camera_stream/${camera}?`)) {
		stopReservation(stream, opened.stream_id, camera)
		throw new Error('Invalid camera stream path')
	}
	// The reservation may finish after closing, hiding, disabling or replacing
	// the view. Stop it before its HTTP response can be opened.
	if (!isActive() || document.hidden || navigator.onLine === false || !stream.isConnected || state.generation !== generation || stream.shadowRoot?.querySelector('img') !== image) {
		await stopReservation(stream, opened.stream_id, camera)
		return
	}
	state.streamId = opened.stream_id
	state.streamUrl = stream._connection.hassUrl(opened.path)
	// Lit owns the one assignment to .src; assigning twice creates duplicate
	// multipart image requests in WebKit.
	stream.requestUpdate()
}
