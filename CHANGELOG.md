# hippos-home-assistant-toolbox

## 0.4.0

### Minor Changes

- e1b9a5e: Add soil-moisture runtime adjustment, distribute limited irrigation runs across primary and secondary daily windows, keep zone-helper JSON within its known schema, document the complete irrigation setup and scheduling model in the UI, refresh the integration logo, check the Development channel every two hours, and list affected blueprint titles in update summaries.

## 0.3.0

### Minor Changes

- 84717ea: Add release-backed Stable blueprint updates and an opt-in Development channel
  that follows validated blueprint changes directly from `main`.

  The canonical local validation now synchronizes the blueprint catalog before
  checking it, preventing source changes and published hashes from drifting apart.
