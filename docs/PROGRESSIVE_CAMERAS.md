# Progressive Snapshot Cameras

**What is this?** A camera helper that shows a cached image as soon as a dashboard card opens. The card then displays the source camera's WebRTC stream or continues with JPEG updates, depending on what Home Assistant can play from that source. If the camera goes offline, the last cached image stays visible with a connection problem marker.

**When should you use this?** When opening a dashboard currently means staring at blank camera cards, although you only wanted a quick glance to see what's going on around the house.

**Why is this included in the toolbox?** Surprisingly, HA's default camera implementation does not provide instant preview images yet. Solving this on your own would require more than an automation that periodically saves snapshots: the cached image and subsequent updates need to be served through a camera entity that standard dashboard cards can use. You would also need to maintain background refreshes, shared live connections, and visible error indication yourself.

## Before you start

Install and configure the [toolbox integration](../README.md#installation) and keep the original camera entity enabled. The source needs a video stream that Home Assistant can capture as JPEG, a native MJPEG stream, or JPEG snapshots for a still-only camera.

## Setup

1. Under **Settings > Devices & services**, open the toolbox integration entry's three-dot menu and select **Add progressive snapshot camera**.
2. Enter a name, select the original camera as the source, and submit. Repeat for each source that needs a cached preview.
3. Select the new camera entity in an Area, Picture Glance, or Picture Entity card. Use `camera_view: live` to receive a fresh frame as soon as it is available.
4. Open the card and check that it shows an image. Once a frame has been fetched, later views can display it immediately from memory.

With `camera_view: auto`, Home Assistant still shows the cached image, but its normal still-image polling determines when the next image appears. Area cards choose a camera from the area automatically. Hide the original entity if the card should choose the progressive camera on the same source device. Keep that original entity enabled so the helper can fetch from it.

## Refresh behavior

Frames are held only in RAM. Restarting Home Assistant or reloading the integration clears the cache. Automatic warmup starts after 30 seconds. Idle cameras refresh every 30 seconds through a staggered queue with at most two background fetches in flight. The first preview appears once the first frame arrives.

For cameras with a video stream that Home Assistant can decode, the cache uses a JPEG from that stream so the preview is closer to the live picture. Native MJPEG and still-only sources use the JPEG images provided by their Home Assistant camera entity. When capture fails, the last successful frame remains available with a connection problem marker until capture recovers.

A live view first shows the cached frame. Home Assistant plays WebRTC when the source offers it, including any two-way audio supported by the source and enabled in Home Assistant. Other sources use JPEG updates. Native MJPEG sources share one upstream connection per progressive camera across all live cards. Still-only sources follow the source camera's snapshot interval.

Live dashboard cards request a preview sized for the card and the display's pixel density. With **Automatically restore camera streams** enabled in the toolbox options, the More Info dialog also uses the cached image while its video player starts. MJPEG JPEG payloads are forwarded without decoding or recompression.

## Camera settings

Reconfigure a progressive camera to change its name, sources or optimizations. Reconfiguring reloads the integration and clears the RAM cache.

| Setting                        | Effect                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Replacement camera             | Optional camera to show if the main video fails. It can provide live video or snapshots.                                 |
| Apply PCMU audio compatibility | Groups 8 kHz PCMU packets on the main camera's RTSP audio return path. This adds up to about 128 ms of packet buffering. |

When the main camera's WebRTC player reports a failure or cannot display its first frame within 15 seconds, the affected view opens the replacement camera with Home Assistant's normal player. You can select a lower-resolution stream, a snapshot entity, or another camera that covers the same area. The replacement uses its own playback options. Reopen the card or dialog to try the main stream again.

The Toolbox passes through the camera's video codec. If a browser cannot play the main stream, you can choose a replacement camera with a compatible stream or JPEG updates.

Audio compatibility is on by default for compatible RTSP sources with Home Assistant's managed go2rtc. Sources with native WebRTC or an external WebRTC server use their own connection.

## Development: rebuilding the connection marker

The runtime uses [`custom_components/hippos_toolbox/assets/connection_problem.png`](../custom_components/hippos_toolbox/assets/connection_problem.png). Its editable source is [`assets/camera-overlay/connection_problem.svg`](../assets/camera-overlay/connection_problem.svg). After changing that SVG, regenerate the PNG with:

```sh
pnpm camera-overlay:render
```

The renderer is generic. Optional positional arguments select another SVG, output path, and square pixel size:

```sh
pnpm camera-overlay:render -- path/to/icon.svg path/to/icon.png 512
```
