# Progressive Snapshot Cameras

**What is this?** A camera wrapper that enhances any existing (M)JPEG snapshot camera with an in-memory image cache. Allows your existing dashboard camera cards to instantly display a periodically refreshed cached snapshot before seamlessly transitioning to the live image. Cameras that are temporarily unavailable still display the last image with a helpful connection problem overlay.

**When should you use this?** When opening a dashboard currently means staring at blank camera cards, although you only wanted a quick glance to see what's going on around the house.

**Why is this included in the toolbox?** Surprisingly, HA's default camera implementation does not provide instant preview images yet. Solving this on your own would require more than an automation that periodically saves snapshots: the cached image and subsequent updates need to be served through a camera entity that standard dashboard cards can use. You would also need to maintain background refreshes, shared live connections, and visible error indication yourself.

## Before you start

Install and configure the [toolbox integration](../README.md#installation). You need an existing camera entity that provides JPEG snapshots. The helper wraps that source; keep the original entity enabled.

## Setup

1. Under **Settings > Devices & services**, open the toolbox integration entry's three-dot menu and select **Add progressive snapshot camera**.
2. Enter a name, select the original camera as the source, and submit. Repeat for each source that needs a cached preview.
3. Select the new camera entity in an Area, Picture Glance, or Picture Entity card. Use `camera_view: live` to receive a fresh frame as soon as it is available.
4. Open the card and check that it shows an image. Once a frame has been fetched, later views can display it immediately from memory.

With `camera_view: auto`, Home Assistant still shows the cached image, but its normal still-image polling determines when the next image appears. Area cards choose a camera from the area automatically: hide the original entity if the card should choose the progressive camera on the same source device. Keep that original entity enabled so the helper can fetch from it.

## Refresh behavior

Frames are held only in RAM. Restarting Home Assistant or reloading the integration clears the cache; automatic warmup starts after 30 seconds. Idle cameras refresh every 30 seconds through a staggered queue with at most two source snapshots in flight. Before the first successful fetch, there is no previous frame to show.

A live view first shows the cached frame and then follows its source. Native MJPEG sources share one upstream connection per progressive camera across all live cards. Still-only sources follow the source camera's snapshot interval. A failed source keeps its last frame with a connection-problem marker until the next successful refresh. The cached image can therefore be older than the current scene; the marker indicates a failed refresh.

Only JPEG snapshots and MJPEG streams containing complete JPEG frames are supported. MJPEG JPEG payloads are forwarded without decoding or recompression.

## Change the source

Reconfigure the progressive camera entry to change its name or source. Changing the source clears its RAM cache when the integration reloads.

## Development: rebuilding the connection marker

The runtime uses [`custom_components/hippos_toolbox/assets/connection_problem.png`](../custom_components/hippos_toolbox/assets/connection_problem.png). Its editable source is [`assets/camera-overlay/connection_problem.svg`](../assets/camera-overlay/connection_problem.svg). After changing that SVG, regenerate the PNG with:

```sh
pnpm camera-overlay:render
```

The renderer is generic. Optional positional arguments select another SVG, output path, and square pixel size:

```sh
pnpm camera-overlay:render -- path/to/icon.svg path/to/icon.png 512
```
