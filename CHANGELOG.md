# hippos-home-assistant-toolbox

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
