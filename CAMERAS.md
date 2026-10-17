# Camera frontend features

Home Assistant's native camera viewer can resume an expired stream after a browser tab returns to the foreground. On iOS, abandoned MJPEG responses can also remain open after navigating away and block later images and page loads. The toolbox keeps HA's native image/video rendering while renewing interrupted streams and giving individual MJPEG responses an explicit server-side lifetime. Camera zoom adds an enlarged viewer with zoom, pan, and aspect-ratio corrections.

## Configuration

Open **Settings > Devices & services > Hippo's Home Assistant Toolbox > Configure**. All three camera options are enabled by default, including on existing installations that have never saved these options.

| Option                                  | Behavior                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera zoom                             | Enlarges camera dialogs and enables mouse-wheel zoom, pinch zoom, and dragging. Includes the existing iOS aspect-ratio and video-display corrections.                            |
| Automatically restore camera streams    | Renews expired HLS URLs after background cleanup and retries failed or initially blank MJPEG views with fresh signed URLs and retry backoff.                                     |
| Reliably close abandoned camera streams | Gives each native MJPEG view its own controllable response and closes it on navigation, backgrounding, or WebSocket disconnect. Two views of the same camera remain independent. |

Changes apply to connected clients without reloading the integration or clearing the progressive-camera cache. Disabling a feature removes its frontend hooks. Stream cleanup can operate without error recovery; its own responses resume when the frontend becomes visible again. A client reload after upgrading the integration loads the new frontend bundle.

These features apply to Home Assistant's standard camera elements, including progressive cameras. Third-party camera cards that implement their own players are outside this scope. A stream that silently stops updating while retaining a valid decoded image cannot be reliably identified through a native MJPEG image element. Frontend extensions depend on HA internals; unsupported camera rendering falls back to HA's native path.

## Loading and communication

The integration registers one content-versioned JavaScript bundle through HA's frontend extension API. There is no manual dashboard-resource registration or YAML configuration. Three booleans and a protocol version are published through `hippos_toolbox/frontend/subscribe` on the client's existing authenticated WebSocket: one initial snapshot and subsequent changes. The script establishes a new subscription after reconnecting. No config-entry data or credentials are included.

The watchdog checks local elements every two seconds; it does not poll the server. Opening a controlled MJPEG view adds one WebSocket request to reserve its signed URL, and closing it adds one stop request. Image bytes still use HA's native camera implementation. Each signed URL is single-use, expires after 30 seconds if unused, and belongs to the reserving WebSocket user. A client can stop only its own connection's views.

Console messages use the `[Hippo Camera Recovery]` prefix and identify the camera and reason without logging signed URLs or session IDs. Normal MJPEG opening, closing, and resuming after backgrounding or reconnection are silent and do not count as recovery attempts. Actual error recovery remains visible in the console; failed setup, renewal, or stream-stop confirmation produces a warning.

## When settings communication fails

Before the subscription is acknowledged and a valid settings snapshot arrives, all frontend extensions remain inactive and HA's native camera viewer continues to work. Enabled defaults are resolved by the integration; the script does not guess them before receiving the saved settings.

A connection interruption immediately disables the extensions and restores HA's original render methods and MJPEG request URLs. After reconnecting, only an acknowledged subscription with a compatible protocol and three boolean settings can reactivate them. A rejected subscription, malformed snapshot, incompatible protocol, or missing acknowledgement/snapshot after ten seconds leaves the native viewer active. Late replies from abandoned subscriptions are ignored. Failures produce an English console warning, not a frontend error or repeated polling. A new connection or frontend reload can retry; saved integration options are unchanged.

An old bundle left open in a browser can continue across compatible integration updates. Incompatible updates reject its protocol when it reconnects, so it stays on the native viewer until a reload loads the current bundle. Protocol versions describe the settings and controlled-stream API contract, not the integration's release number.

Failed, malformed, or timed-out controlled-stream reservations restore HA's native source for that view. A late reservation is released without opening its HTTP stream. A missing frontend bundle does not prevent the integration's backend from starting.

## Migrating local prototypes

Remove manually registered camera-zoom, camera-recovery, and temporary diagnostic resources before reloading the frontend with the integration-managed bundle. Keep the original files as a backup if desired. Running both copies can install overlapping hooks; the toolbox does not delete unrelated dashboard resources automatically.

## Development

Frontend sources are in `frontend/cameras/`: the entrypoint handles the shared subscription, `zoom.js` owns viewer interaction, `recovery.js` owns recovery and the shared camera render hook, and `stream-cleanup.js` owns controlled MJPEG reservations. Recovery and cleanup share one HA render hook so they cannot overwrite each other's patches.

Keep `CAMERA_FRONTEND_PROTOCOL` in `const.py` and `PROTOCOL` in `index.js` in sync. Bump both for incompatible changes to settings, stream commands, or their responses. Keep the version unchanged for compatible releases so open browser tabs can reconnect safely.

Run `pnpm frontend:build` after frontend source edits. The generated file is `custom_components/hippos_toolbox/frontend/cameras.js` and is included in integration downloads. `pnpm frontend:check` checks freshness, and the unit suite also verifies that the committed bundle matches its sources.

Mark CSS template literals with `/* css */`, or `/* css declarations */` for inline declaration lists. The build minifies their whitespace with esbuild's CSS parser while preserving interpolated identifiers and values. Keep whole rules and declarations in separate templates instead of interpolating CSS fragments. Source templates remain readable; the generated bundle includes the compact CSS.
