---
"hippos-home-assistant-toolbox": patch
---

Remove unsupported `none` and `query failed` error states from the cover automation blueprint to prevent Spook repair warnings. Continue ignoring `unknown` and `unavailable` states and waiting ten seconds after an input recovers.
