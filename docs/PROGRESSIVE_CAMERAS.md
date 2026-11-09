# Progressive Snapshot Cameras

**What is this?** A camera helper that shows a cached image as soon as a dashboard card opens. The card then displays the source camera's WebRTC stream or continues with JPEG updates, depending on what Home Assistant can play from that source. If the camera goes offline, the last cached image stays visible with a connection problem marker.

**When should you use this?** When opening a dashboard currently means staring at blank camera cards, although you only wanted a quick glance to see what's going on around the house.

**Why is this included in the toolbox?** Surprisingly, HA's default camera implementation does not provide instant preview images yet. Solving this on your own would require more than an automation that periodically saves snapshots: the cached image and subsequent updates need to be served through a camera entity that standard dashboard cards can use. You would also need to maintain background refreshes, shared live connections, and visible error indication yourself.

## Before you start

Install and configure the [toolbox integration](../README.md#installation) and keep the original camera entity enabled. The source needs to provide JPEG images for the preview, either from a snapshot endpoint or from a stream that Home Assistant can decode. You can also choose a separate camera entity for the preview.

## Setup

1. Under **Settings > Devices & services**, open the toolbox integration entry's three-dot menu and select **Add progressive snapshot camera**.
2. Enter a name, select the original camera as the source, and submit. Repeat for each source that needs a cached preview.
3. Select the new camera entity in an Area, Picture Glance, or Picture Entity card. Use `camera_view: live` to receive a fresh frame as soon as it is available.
4. Open the card and check that it shows an image. Once a frame has been fetched, later views can display it immediately from memory.

With `camera_view: auto`, Home Assistant still shows the cached image, but its normal still-image polling determines when the next image appears. Area cards choose a camera from the area automatically. Hide the original entity if the card should choose the progressive camera on the same source device. Keep that original entity enabled so the helper can fetch from it.

## Refresh behavior

Frames are held only in RAM. Restarting Home Assistant or reloading the integration clears the cache; automatic warmup starts after 30 seconds. Idle cameras refresh every 30 seconds through a staggered queue with at most two source snapshots in flight. Before the first successful fetch, there is no previous frame to show.

A live view first shows the cached frame. Home Assistant plays WebRTC when the source offers it, including any two-way audio supported by the source and enabled in Home Assistant. Other sources use JPEG updates. Native MJPEG sources share one upstream connection per progressive camera across all live cards. Still-only sources follow the source camera's snapshot interval. A failed source keeps its last frame with a connection problem marker until the next successful refresh.

Only JPEG snapshots and MJPEG streams containing complete JPEG frames are supported. MJPEG JPEG payloads are forwarded without decoding or recompression.

## Camera settings

Reconfigure a progressive camera to change its name, sources or optimizations. Existing entries pick up the default optimizations from their saved source. Reconfiguring reloads the integration and clears the RAM cache.

| Setting                            | Effect                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Separate preview camera            | Optional JPEG source. A low-resolution source can fill the cache faster. The helper uses the main source if the preview fails.   |
| Convert video to H.264 when needed | Offers H.264 to the browser for compatible RTSP sources served by go2rtc. An already compatible H.264 video track can be reused. |
| Smooth video delivery              | Paces frames from compatible RTSP sources. When combined with H.264 conversion, the encoder targets 20 frames per second.        |
| Apply PCMU audio compatibility     | Groups 8 kHz PCMU packets on the camera-facing RTSP audio return path. This adds up to about 128 ms of packet buffering.         |

The three optimizations are on by default. The RTSP options apply when the camera uses the go2rtc server managed by Home Assistant. Cameras with native WebRTC or an external WebRTC server use the source's own connection.

## Development: rebuilding the connection marker

The runtime uses [`custom_components/hippos_toolbox/assets/connection_problem.png`](../custom_components/hippos_toolbox/assets/connection_problem.png). Its editable source is [`assets/camera-overlay/connection_problem.svg`](../assets/camera-overlay/connection_problem.svg). After changing that SVG, regenerate the PNG with:

```sh
pnpm camera-overlay:render
```

The renderer is generic. Optional positional arguments select another SVG, output path, and square pixel size:

```sh
pnpm camera-overlay:render -- path/to/icon.svg path/to/icon.png 512
```
