# hippos-home-assistant-toolbox

## 0.12.4

### Patch Changes

- 97c1643: Document reusable monitoring dashboard cards with English status lines, known and resolved timestamps, and recovery countdowns based on the configured delay. Include a separate active-alarm list and explain retained incidents while source states are unknown or unavailable.

## 0.12.3

### Patch Changes

- b1d4697: Expose each pending solution's confirmation deadline so dashboards can show a countdown using the configured recovery delay.

## 0.12.2

### Patch Changes

- 9be08fc: Preserve the legacy warning and alarm counters' total state class so their existing long-term statistics continue after migration without repair warnings.

## 0.12.1

### Patch Changes

- a333b4b: Give monitoring its own device so adding the monitoring subentry preserves the toolbox update entities and registers all monitoring sensors and events.

## 0.12.0

### Minor Changes

- fdac28d: Add optional persistent problem monitoring with configurable warning and solution delays, label-based rules, and sensor/event entities. Preserve availability warnings for disconnected alarm entities with a separate configurable delay, and avoid repeating known problems after restarts or reloads. Expose immediate alarm events and an active-alarm sensor, retaining ongoing alarms through unknown/unavailable phases and restarts.

## 0.11.1

### Patch Changes

- bd2093a: Keep routine camera stream cleanup and controlled-stream resumption silent in the browser console. Continue reporting genuine recovery attempts and failures.
- dca5697: Wait for Home Assistant's application and connection before initializing camera enhancements, including when its component registry changes during startup. This prevents early bundle loading from leaving enhancements inactive until another browser refresh.

## 0.11.0

### Minor Changes

- beb1741: Add camera zoom, automatic stream recovery, and reliable cleanup of abandoned MJPEG responses. Enable all three by default with independent integration options, one bundled frontend module, and live configuration updates over Home Assistant's existing WebSocket connection.

### Patch Changes

- 6d0dc57: Keep normal MJPEG view setup silent instead of reporting it as stream recovery. Start the recovery attempt counter at the first actual recovery and distinguish initial opening failures from renewal failures.

## 0.10.0

### Minor Changes

- 766e5b3: Add `hippos_toolbox.announce_media` and `hippos_toolbox.announce_tts` with automatic audio duration, remaining-time waits, shared player queues, and optional announcement volume. TTS uses Home Assistant's existing speech generation and cache, supporting entity-based engines and legacy providers. Its engine picker lists registered engines by name and follows additions, renames, and removals.

## 0.9.1

### Patch Changes

- 8be3d47: Remove unsupported `none` and `query failed` error states from the cover automation blueprint to prevent Spook repair warnings. Continue ignoring `unknown` and `unavailable` states and waiting ten seconds after an input recovers.

## 0.9.0

### Minor Changes

- f1ed857: Warn before replacing a locally modified blueprint when existing automations are missing newly required inputs, and abort the Repair when compatibility cannot be checked safely.

## 0.8.0

### Minor Changes

- e94a162: Change the Push-Button Music Controller defaults to 50% start volume with a
  25–75% range, add optional shuffle for successfully started favorites, and map
  double-tap to next-track while moving favorite cycling to triple-tap.

## 0.7.0

### Minor Changes

- a5773f4: Add Hippo's Push-Button Music Controller blueprint with tap, double-tap,
  one- or two-button long-press volume fading, favorite failover, persistent
  sessions, and optional LED feedback.

### Patch Changes

- e4b7bd4: Show the Progressive Snapshot Camera's cached frame immediately before relaying
  a native MJPEG source, while sharing one upstream stream across all live cards
  and preserving the source JPEG payloads without recompression.
- 753a6fc: Explain when a reduced irrigation demand is already covered by watering completed earlier in the cycle, so the zone log states why no further run is needed.

## 0.6.0

### Minor Changes

- 5fd412c: Calculate irrigation climate and soil demand once per planning interval, conservatively reduce later-slot demand when the sliding rain credit rises, tighten future runs without changing an active run, and replace repetitive planning logs with rounded start and completion summaries.
- b19ddd8: Reduce future irrigation runs when soil-moisture readings accepted at slot boundaries prove that the original dryness adjustment is no longer needed, without sampling mid-window changes, increasing demand, or changing an active run. Keep recurring daily start times stable across daylight-saving changes, and keep complete zone state within the Text helper limit by writing timestamps as Unix seconds.

### Patch Changes

- 7770522: Keep the manual update-check button available after a catalog request fails, and record the failure in the Toolbox device Activity view with details remaining in the system log.

## 0.5.4

### Patch Changes

- 391b849: Preserve native MJPEG source frame rates when Progressive Snapshot Cameras switch from their cached preview to live video.

## 0.5.3

### Patch Changes

- 884288d: Keep the Progressive Snapshot Camera connection overlay transparent outside its icon and compact drop shadow.

## 0.5.2

### Patch Changes

- 4c40fb1: Keep Progressive Snapshot Camera thumbnail tokens valid across integration reloads and expose available sources before their first frame is cached.

## 0.5.1

### Patch Changes

- e7b3f9f: Hand Progressive Snapshot Camera live views from the immediate RAM cache to the source camera's native snapshot cadence while keeping idle refreshes staggered.

## 0.5.0

### Minor Changes

- 805557c: Add UI-configurable Progressive Snapshot Cameras with staggered RAM caching, adaptive refresh intervals, seamless live-card updates, and marked fallback frames when a source fails.

### Patch Changes

- 299f1af: Subtract a configurable percentage of detected rain minutes from adjusted irrigation demand and explain each runtime component in zone log messages.

## 0.4.0

### Minor Changes

- e1b9a5e: Add soil-moisture runtime adjustment, distribute limited irrigation runs across primary and secondary daily windows, keep zone-helper JSON within its known schema, document the complete irrigation setup and scheduling model in the UI, refresh the integration logo, check the Development channel every two hours, and list affected blueprint titles in update summaries.

## 0.3.0

### Minor Changes

- 84717ea: Add release-backed Stable blueprint updates and an opt-in Development channel
  that follows validated blueprint changes directly from `main`.

  The canonical local validation now synchronizes the blueprint catalog before
  checking it, preventing source changes and published hashes from drifting apart.
