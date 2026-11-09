"""Start a local go2rtc relay when a progressive camera needs RTSP processing."""

import asyncio
from collections.abc import Mapping
from contextlib import suppress
import json
import logging
from pathlib import Path
import shutil
import socket
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit

from aiohttp import web

from homeassistant.core import HomeAssistant

from .camera_backchannel import _start_backchannel_tunnel
from .const import CONF_PACE_VIDEO, CONF_REPACK_PCMU, CONF_TRANSCODE_H264

_LOGGER = logging.getLogger(__name__)
_LOOPBACK = "127.0.0.1"


class _CameraRelay:
    """Own the private relay and its optional audio tunnel for one camera."""

    def __init__(self, hass: HomeAssistant, options: Mapping[str, Any]) -> None:
        self._hass = hass
        self._transcode = options.get(CONF_TRANSCODE_H264, True)
        self._pace = options.get(CONF_PACE_VIDEO, True)
        self._repack = options.get(CONF_REPACK_PCMU, True)
        self._lock = asyncio.Lock()
        self._input: tuple[str, bool] | None = None
        self._url: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._directory: TemporaryDirectory | None = None
        self._tunnel: web.AppRunner | None = None
        self._drain: asyncio.Task | None = None
        self._stopping = False

    async def async_get_url(self, source: str, two_way_audio: bool) -> str | None:
        """Return the processed stream, or allow the caller to use the original."""

        parsed = urlsplit(source)
        if parsed.scheme != "rtsp" or not parsed.hostname:
            return None
        raw_source, *fragments = source.split("#")
        transport = next(
            (fragment[10:] for fragment in fragments if fragment.startswith("transport=")),
            "tcp",
        )
        repack = self._repack and two_way_audio and transport == "tcp"
        if not (self._transcode or self._pace or repack):
            return None

        async with self._lock:
            if self._stopping:
                return None
            if (
                self._input == (source, two_way_audio)
                and self._process is not None
                and self._process.returncode is None
            ):
                return self._url
            await self._async_stop()
            binary = await self._hass.async_add_executor_job(shutil.which, "go2rtc")
            if binary is None:
                return None

            ready = False
            try:
                # Only the camera-facing producer requests the source backchannel.
                fragments = [item for item in fragments if not item.startswith("backchannel=")]
                fragments.append(f"backchannel={int(two_way_audio)}")
                if repack:
                    self._tunnel, tunnel_url = await _start_backchannel_tunnel(parsed)
                    fragments = [item for item in fragments if not item.startswith("transport=")]
                    fragments.append(f"transport={tunnel_url}")
                relay_source = "#".join((raw_source, *fragments))
                with socket.socket() as reservation:
                    reservation.bind((_LOOPBACK, 0))
                    port = reservation.getsockname()[1]
                    config, stream_url = _relay_config(
                        relay_source, port, self._transcode, self._pace, two_way_audio
                    )
                    self._directory = await self._hass.async_add_executor_job(
                        _write_config, config
                    )
                self._process = await asyncio.create_subprocess_exec(
                    binary,
                    "-config",
                    str(Path(self._directory.name) / "go2rtc.yaml"),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                stdout = self._process.stdout
                assert stdout is not None
                async with asyncio.timeout(3):
                    while line := await stdout.readline():
                        # Require our child's successful bind, even if another process
                        # took the port between releasing the socket and launching it.
                        if b'"message":"[rtsp] listen"' in line:
                            break
                    else:
                        raise OSError("Relay did not bind its RTSP listener")
                self._drain = self._hass.async_create_background_task(
                    _drain_output(stdout), "drain progressive camera relay"
                )
                self._input = (source, two_way_audio)
                self._url = stream_url
                ready = True
                return stream_url
            except (OSError, TimeoutError, ValueError):
                # Process output and source URLs can contain camera credentials.
                _LOGGER.warning("Could not start a camera relay, using the original stream")
                return None
            finally:
                if not ready:
                    await self._async_stop()

    async def async_stop(self) -> None:
        self._stopping = True
        async with self._lock:
            await self._async_stop()

    async def _async_stop(self) -> None:
        process, self._process = self._process, None
        tunnel, self._tunnel = self._tunnel, None
        directory, self._directory = self._directory, None
        drain, self._drain = self._drain, None
        self._input = self._url = None
        try:
            if process is not None and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
                try:
                    async with asyncio.timeout(3):
                        await process.wait()
                except TimeoutError:
                    with suppress(ProcessLookupError):
                        process.kill()
                    await process.wait()
        finally:
            if drain is not None:
                drain.cancel()
                await asyncio.gather(drain, return_exceptions=True)
            if tunnel is not None:
                await tunnel.cleanup()
            if directory is not None:
                await self._hass.async_add_executor_job(directory.cleanup)


def _relay_config(
    source: str, port: int, transcode: bool, pace: bool, two_way_audio: bool
) -> tuple[dict, str]:
    address = f"{_LOOPBACK}:{port}"
    base = f"rtsp://{address}"
    video = "video=h264" if transcode else "video"
    backchannel = f"&backchannel={int(two_way_audio)}"
    streams = {"input": [source]}
    if transcode:
        # Keep native H.264 when available, transcode only as a second producer.
        streams["input"].append("ffmpeg:input#video=h264")
    if transcode or pace:
        streams["input"].append("ffmpeg:input#audio=opus")
    audio = "audio=opus" if transcode or pace else "audio"
    output = f"{base}/input?{video}&{audio}{backchannel}"
    if pace:
        streams["paced"] = [
            f"ffmpeg:{base}/input?{video}#video=copy#input=pace",
            f"{base}/input?{audio}{backchannel}#backchannel={int(two_way_audio)}",
        ]
        output = f"{base}/paced?{video}&{audio}{backchannel}"
    h264 = (
        "-c:v libx264 -threads 4 -g 20 -profile:v high -level:v 5.1 "
        "-preset:v ultrafast -tune:v zerolatency -pix_fmt:v yuv420p "
        "-b:v 5M -maxrate 5M -bufsize 2M"
    )
    if pace:
        # Use reception time for the CFR encode, then pace the copied output.
        h264 += " -vf setpts=(RTCTIME-RTCSTART)/(TB*1000000),fps=20 -fps_mode cfr"
    return {
        "app": {"modules": ["api", "exec", "ffmpeg", "rtsp"]},
        "api": {"listen": ""},
        "exec": {"allow_paths": ["ffmpeg"]},
        "log": {"level": "error", "rtsp": "info", "format": "json", "output": "stdout"},
        "rtsp": {"listen": address},
        "streams": streams,
        "ffmpeg": {
            "rtsp": (
                "-timeout {timeout} -user_agent go2rtc/ffmpeg -rtsp_transport tcp "
                "-analyzeduration 1000000 -probesize 2000000 -i {input}"
            ),
            "pace": (
                "-readrate 1 -readrate_initial_burst 0 -readrate_catchup 1 "
                "-timeout {timeout} -rtsp_transport tcp -analyzeduration 650000 "
                "-probesize 2000000 -i {input}"
            ),
            "h264": h264,
            "opus": "-c:a libopus -application:a lowdelay -ar:a 48000 -ac:a 1 -af asetpts=N/SR/TB",
        },
    }, output


def _write_config(config: dict) -> TemporaryDirectory:
    directory = TemporaryDirectory(prefix="ha-progressive-camera-")
    try:
        path = Path(directory.name) / "go2rtc.yaml"
        path.touch(mode=0o600)
        path.write_text(json.dumps(config))
    except BaseException:
        directory.cleanup()
        raise
    return directory


async def _drain_output(reader: asyncio.StreamReader) -> None:
    while await reader.read(65536):
        pass
