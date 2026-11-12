"""Relay RTSP for cameras that need PCMU return-audio compatibility."""

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
from .const import CONF_REPACK_PCMU

_LOGGER = logging.getLogger(__name__)
_LOOPBACK = "127.0.0.1"


class _CameraRelay:
    """Own the private relay and audio tunnel for one camera."""

    def __init__(self, hass: HomeAssistant, options: Mapping[str, Any]) -> None:
        self._hass = hass
        self._repack = options.get(CONF_REPACK_PCMU, True)
        self._lock = asyncio.Lock()
        self._source: str | None = None
        self._url: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._directory: TemporaryDirectory | None = None
        self._tunnel: web.AppRunner | None = None
        self._drain: asyncio.Task | None = None
        self._stopping = False

    async def async_get_url(self, source: str, two_way_audio: bool) -> str | None:
        """Return a relay URL for a compatible audio backchannel."""

        if not self._repack or not two_way_audio:
            return None
        parsed = urlsplit(source)
        if parsed.scheme != "rtsp" or not parsed.hostname:
            return None
        raw_source, *fragments = source.split("#")
        transport = next(
            (fragment[10:] for fragment in fragments if fragment.startswith("transport=")),
            "tcp",
        )
        if transport != "tcp":
            return None

        async with self._lock:
            if self._stopping:
                return None
            if (
                self._source == source
                and self._url is not None
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
                self._tunnel, tunnel_url = await _start_backchannel_tunnel(parsed)
                fragments = [item for item in fragments if not item.startswith(("backchannel=", "transport="))]
                relay_source = "#".join((raw_source, *fragments, "backchannel=1", f"transport={tunnel_url}"))
                with socket.socket() as reservation:
                    reservation.bind((_LOOPBACK, 0))
                    port = reservation.getsockname()[1]
                    config = _relay_config(relay_source, port)
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
                self._source = source
                self._url = f"rtsp://{_LOOPBACK}:{port}/input?video&audio&backchannel=1"
                ready = True
                return self._url
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
        self._source = self._url = None
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


def _relay_config(source: str, port: int) -> dict:
    return {
        "app": {"modules": ["api", "rtsp"]},
        "api": {"listen": ""},
        "log": {"level": "error", "rtsp": "info", "format": "json", "output": "stdout"},
        "rtsp": {"listen": f"{_LOOPBACK}:{port}"},
        "streams": {"input": [source]},
    }


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
