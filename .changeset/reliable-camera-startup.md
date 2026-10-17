---
'hippos-home-assistant-toolbox': patch
---

Wait for Home Assistant's application and connection before initializing camera enhancements, including when its component registry changes during startup. This prevents early bundle loading from leaving enhancements inactive until another browser refresh.
