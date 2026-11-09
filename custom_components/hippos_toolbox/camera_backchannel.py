"""Repacketize PCMU on the camera-facing side of a local go2rtc RTSP relay."""

import asyncio
from collections.abc import Iterator
from contextlib import suppress
import re
from secrets import token_urlsafe
import struct
from urllib.parse import SplitResult

from aiohttp import WSMsgType, web

_LOOPBACK = "127.0.0.1"
_INTERLEAVED = re.compile(rb"(?:^|;)\s*interleaved=(\d+)-\d+", re.IGNORECASE)
_MAX_RTSP_MESSAGE = 1024 * 1024
_PCMU_PACKET_SAMPLES = 1024


def _headers(message: bytes) -> dict[bytes, bytes]:
    headers = {}
    for line in message.split(b"\r\n")[1:]:
        key, separator, value = line.partition(b":")
        if separator:
            headers[key.lower()] = value.strip()
    return headers


class _RtspMessages:
    """Split TCP data into RTSP messages and interleaved RTP/RTCP frames."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> Iterator[bytes]:
        self._buffer.extend(data)
        while self._buffer:
            if self._buffer[0] == ord("$"):
                if len(self._buffer) < 4:
                    return
                length = 4 + int.from_bytes(self._buffer[2:4], "big")
            else:
                header_end = self._buffer.find(b"\r\n\r\n")
                if header_end < 0:
                    if len(self._buffer) > _MAX_RTSP_MESSAGE:
                        raise ValueError("RTSP header exceeds size limit")
                    return
                headers = _headers(bytes(self._buffer[:header_end]))
                length = header_end + 4 + int(headers.get(b"content-length", b"0"))
                if not header_end + 4 <= length <= _MAX_RTSP_MESSAGE:
                    raise ValueError("Invalid RTSP message size")
            if len(self._buffer) < length:
                return
            message = bytes(self._buffer[:length])
            del self._buffer[:length]
            yield message


class _PcmuPackets:
    """Send 1024 samples at a time with advancing RTP timestamps."""

    def __init__(self, payload_type: int) -> None:
        self._payload_type = payload_type
        self._samples = bytearray()
        self._ssrc: int | None = None
        self._sequence = self._timestamp = 0

    def feed(self, frame: bytes) -> Iterator[bytes]:
        if (
            len(frame) < 16
            or frame[4] != 0x80
            or frame[5] & 0x7F != self._payload_type
        ):
            yield frame
            return

        sequence, timestamp, ssrc = struct.unpack_from("!HII", frame, 6)
        if self._ssrc != ssrc:
            self._samples.clear()
            self._ssrc = ssrc
            self._sequence, self._timestamp = sequence, timestamp

        self._samples.extend(frame[16:])
        while len(self._samples) >= _PCMU_PACKET_SAMPLES:
            yield struct.pack(
                "!BBHBBHII",
                ord("$"), frame[1], 12 + _PCMU_PACKET_SAMPLES,
                0x80, 0x80 | self._payload_type, self._sequence,
                self._timestamp, ssrc,
            ) + bytes(self._samples[:_PCMU_PACKET_SAMPLES])
            del self._samples[:_PCMU_PACKET_SAMPLES]
            self._sequence = (self._sequence + 1) & 0xFFFF
            self._timestamp = (self._timestamp + _PCMU_PACKET_SAMPLES) & 0xFFFFFFFF


class _Backchannel:
    """Use the SDP and SETUP response to identify the PCMU RTP channel."""

    def __init__(self) -> None:
        self._tracks: dict[bytes, int] = {}
        self._pending: dict[bytes, int] = {}
        self._channels: dict[int, _PcmuPackets] = {}

    def from_camera(self, message: bytes) -> None:
        if message.startswith(b"$"):
            return
        header, _, body = message.partition(b"\r\n\r\n")
        headers = _headers(header)
        payload = self._pending.pop(headers.get(b"cseq", b""), None)
        if not header.startswith(b"RTSP/1.0 200 "):
            return
        if payload is not None and (
            channel := _INTERLEAVED.search(headers.get(b"transport", b""))
        ):
            self._channels[int(channel[1])] = _PcmuPackets(payload)
        if headers.get(b"content-type", b"").lower().startswith(b"application/sdp"):
            self._read_sdp(body)

    def _read_sdp(self, body: bytes) -> None:
        self._tracks.clear()
        for section in re.split(rb"(?=^m=)", body, flags=re.MULTILINE):
            lines = section.splitlines()
            if not section.startswith(b"m=audio ") or b"a=sendonly" not in lines:
                continue
            control = next(
                (line[10:] for line in lines if line.startswith(b"a=control:")), None
            )
            if not control:
                continue
            payloads = lines[0].split()[3:]
            for payload in payloads:
                prefix = b"a=rtpmap:" + payload + b" "
                codec = next(
                    (line[len(prefix):].upper() for line in lines if line.startswith(prefix)),
                    b"PCMU/8000" if payload == b"0" else b"",
                )
                if codec in (b"PCMU/8000", b"PCMU/8000/1"):
                    self._tracks[control] = int(payload)
                    break

    def to_camera(self, message: bytes) -> Iterator[bytes]:
        if message.startswith(b"$"):
            if packer := self._channels.get(message[1]):
                yield from packer.feed(message)
                return
        elif message.startswith(b"SETUP "):
            target = message.split(b" ", 2)[1]
            for control, payload in self._tracks.items():
                if target == control or target.endswith(b"/" + control):
                    headers = _headers(message.partition(b"\r\n\r\n")[0])
                    self._pending[headers[b"cseq"]] = payload
                    break
        yield message


async def _start_backchannel_tunnel(source: SplitResult) -> tuple[web.AppRunner, str]:
    """Open a local RTSP-over-WebSocket tunnel to one fixed camera endpoint."""

    async def proxy(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(protocols=("binary",))
        async with asyncio.timeout(5):
            reader, writer = await asyncio.open_connection(source.hostname, source.port or 554)
        try:
            await ws.prepare(request)
            backchannel = _Backchannel()

            async def read_camera() -> None:
                messages = _RtspMessages()
                while data := await reader.read(65536):
                    for message in messages.feed(data):
                        backchannel.from_camera(message)
                        await ws.send_bytes(message)

            async def write_camera() -> None:
                messages = _RtspMessages()
                async for item in ws:
                    if item.type != WSMsgType.BINARY:
                        return
                    for message in messages.feed(item.data):
                        for output in backchannel.to_camera(message):
                            writer.write(output)
                    await writer.drain()

            tasks = (asyncio.create_task(read_camera()), asyncio.create_task(write_camera()))
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()
            await ws.close()
        return ws

    path = "/" + token_urlsafe(24)
    app = web.Application()
    app.router.add_get(path, proxy)
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=1)
    await runner.setup()
    try:
        await web.TCPSite(runner, _LOOPBACK, 0).start()
        port = runner.addresses[0][1]
    except BaseException:
        await runner.cleanup()
        raise
    return runner, f"ws://{_LOOPBACK}:{port}{path}"
