# Camera Frontend Features

**What is this?** A set of enhancements for Home Assistant's standard camera viewer. You can zoom and pan in camera dialogs, interrupted streams are automatically retried when you return to a tab, and unused MJPEG connections close when you leave a view. Your existing camera cards use these features without a separate dashboard resource.

**When should you use this?** When you want a closer look at a camera image, or return to a camera view and have to reload the page before it works again.

**Why is this included in the toolbox?** HA's standard camera viewer can leave streams stuck after backgrounding or keep unused MJPEG connections open after navigation. Working around those cases yourself requires browser-side recovery and cleanup, and adding zoom requires viewer changes as well. You would need to maintain frontend extensions that work across tab changes and multiple views of the same camera.

## Setup

Install and configure the [toolbox integration](../README.md#installation). All three frontend features are enabled automatically. No separate camera helper, dashboard resource, or YAML configuration is needed for these features.

Open **Settings > Devices & services > Hippo's Home Assistant Toolbox > Configure** to review or disable individual features. Existing installations without saved camera options also use the enabled defaults.

| Option | Behavior |
| --- | --- |
| Camera zoom | Enlarges camera dialogs and enables double-tap zoom, mouse-wheel zoom, pinch zoom, and dragging. Includes the existing iOS aspect-ratio and video-display corrections. |
| Automatically restore camera streams | Renews expired HLS URLs after background cleanup and retries failed or initially blank MJPEG views with fresh signed URLs and retry backoff. |
| Reliably close abandoned camera streams | Gives each native MJPEG view its own controllable response and closes it on navigation, backgrounding, or WebSocket disconnect. Two views of the same camera remain independent. |

Changes apply to connected clients without reloading the integration or clearing the progressive-camera cache. Disabling a feature removes its frontend hooks. Stream cleanup can operate without error recovery; its own responses resume when the frontend becomes visible again. A client reload after upgrading the integration loads the new frontend bundle.

These features apply to Home Assistant's standard camera elements, including progressive cameras. Third-party camera cards that implement their own players are outside this scope. A stream that silently stops updating while retaining a valid decoded image cannot be reliably identified through a native MJPEG image element. Frontend extensions depend on HA internals; unsupported camera rendering falls back to HA's native path.

## Zooming in a camera dialog

Open a camera's standard more-info dialog and double-tap the detail you want to inspect. The view smoothly zooms to twice its initial size and centers that detail as far as the image edges allow. Double-tap again to return to the full image, including after zooming manually. A mouse double-click works the same way. Reduced-motion preferences skip the animation.

Drag to move around an enlarged view, pinch to adjust magnification, or use the mouse wheel. Single taps, long presses, dragging, and pinch gestures do not trigger double-tap zoom. After updating the integration, reload the client and try two double-taps to verify that the view enlarges and returns to the full image. The existing **Camera zoom** option controls this behavior; no additional configuration is needed.

## Loading and communication

The integration registers one content-versioned JavaScript bundle through HA's frontend extension API. There is no manual dashboard-resource registration or YAML configuration. Three booleans and a protocol version are published through `hippos_toolbox/frontend/subscribe` on the client's existing authenticated WebSocket: one initial snapshot and subsequent changes. The script establishes a new subscription after reconnecting. No config-entry data or credentials are included.

HA loads the bundle in parallel with its application. The script waits for HA's application component and connection promise before subscribing, checking the current component registry because HA replaces it during startup. These brief local checks make no server requests and stop once initialization begins. The settings timeout starts with the subscription, not while HA itself is still loading.

The watchdog checks local elements every two seconds; it does not poll the server. Opening a controlled MJPEG view adds one WebSocket request to reserve its signed URL, and closing it adds one stop request. Image bytes still use HA's native camera implementation. Each signed URL is single-use, expires after 30 seconds if unused, and belongs to the reserving WebSocket user. A client can stop only its own connection's views.

Console messages use the `[Hippo Camera Recovery]` prefix and identify the camera and reason without logging signed URLs or session IDs. Normal MJPEG opening, closing, and resuming after backgrounding or reconnection are silent and do not count as recovery attempts. Actual error recovery remains visible in the console; failed setup, renewal, or stream-stop confirmation produces a warning.

## When settings communication fails

Before the subscription is acknowledged and a valid settings snapshot arrives, all frontend extensions remain inactive and HA's native camera viewer continues to work. Enabled defaults are resolved by the integration; the script does not guess them before receiving the saved settings.

A connection interruption immediately disables the extensions and restores HA's original render methods and MJPEG request URLs. After reconnecting, only an acknowledged subscription with a compatible protocol and three boolean settings can reactivate them. A rejected subscription, malformed snapshot, incompatible protocol, or missing acknowledgement/snapshot after ten seconds leaves the native viewer active. Late replies from abandoned subscriptions are ignored. Failures produce an English console warning, not a frontend error or repeated polling. A new connection or frontend reload can retry; saved integration options are unchanged.

An old bundle left open in a browser can continue across compatible integration updates. Incompatible updates reject its protocol when it reconnects, so it stays on the native viewer until a reload loads the current bundle. Protocol versions describe the settings and controlled-stream API contract, not the integration's release number.

Failed, malformed, or timed-out controlled-stream reservations restore HA's native source for that view. A late reservation is released without opening its HTTP stream. A missing frontend bundle does not prevent the integration's backend from starting.

## Other camera extensions

If another dashboard resource modifies the same camera viewer behavior, disable the overlapping resource before enabling the corresponding toolbox feature. Multiple extensions can install conflicting hooks. The toolbox does not remove dashboard resources automatically.

## Development

Frontend sources are in [`frontend/cameras/`](../frontend/cameras/): the entrypoint handles the shared subscription, `zoom.js` owns viewer interaction, `recovery.js` owns recovery and the shared camera render hook, and `stream-cleanup.js` owns controlled MJPEG reservations. Recovery and cleanup share one HA render hook so they cannot overwrite each other's patches.

Keep `CAMERA_FRONTEND_PROTOCOL` in `const.py` and `PROTOCOL` in `index.js` in sync. Bump both for incompatible changes to settings, stream commands, or their responses. Keep the version unchanged for compatible releases so open browser tabs can reconnect safely.

Run `pnpm frontend:build` after frontend source edits. The generated file is `custom_components/hippos_toolbox/frontend/cameras.js` and is included in integration downloads. `pnpm frontend:check` checks freshness, and the unit suite also verifies that the committed bundle matches its sources.

Mark CSS template literals with `/* css */`, or `/* css declarations */` for inline declaration lists. The build minifies their whitespace with esbuild's CSS parser while preserving interpolated identifiers and values. Keep whole rules and declarations in separate templates instead of interpolating CSS fragments. Source templates remain readable; the generated bundle includes the compact CSS.
