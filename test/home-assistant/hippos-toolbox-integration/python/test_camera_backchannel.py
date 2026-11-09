"""Verify that only the negotiated PCMU speaker RTP channel is changed."""

import struct
import unittest

from custom_components.hippos_toolbox.camera_backchannel import _Backchannel, _RtspMessages


def _rtp(channel, sequence, timestamp, payload):
    return struct.pack(
        "!BBHBBHII", ord("$"), channel, len(payload) + 12, 0x80, 0, sequence, timestamp, 9
    ) + payload


class CameraBackchannelTests(unittest.TestCase):
    def test_repack_preserves_samples_and_leaves_other_channels_alone(self):
        proxy = _Backchannel()
        sdp = (
            b"v=0\r\nm=audio 0 RTP/AVP 0\r\na=recvonly\r\na=control:mic\r\n"
            b"m=audio 0 RTP/AVP 0\r\na=sendonly\r\na=control:speaker\r\n"
        )
        proxy.from_camera(b"RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\n\r\n" + sdp)
        setup = b"SETUP rtsp://example.test/speaker RTSP/1.0\r\nCSeq: 3\r\n\r\n"
        self.assertEqual(list(proxy.to_camera(setup)), [setup])
        proxy.from_camera(
            b"RTSP/1.0 200 OK\r\nCSeq: 3\r\n"
            b"Transport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n"
        )
        mic = _rtp(0, 1, 12, b"a" * 160)
        self.assertEqual(list(proxy.to_camera(mic)), [mic])
        outputs = [
            output
            for index in range(13)
            for output in proxy.to_camera(
                _rtp(2, 65534 + index if index < 2 else index - 2,
                     (0xFFFFFE00 + index * 160) & 0xFFFFFFFF, bytes((index,)) * 160)
            )
        ]
        self.assertEqual([len(packet[16:]) for packet in outputs], [1024, 1024])
        self.assertEqual(
            b"".join(packet[16:] for packet in outputs),
            b"".join(bytes((index,)) * 160 for index in range(13))[:2048],
        )
        timestamps = [struct.unpack_from("!I", packet, 8)[0] for packet in outputs]
        self.assertEqual((timestamps[1] - timestamps[0]) & 0xFFFFFFFF, 1024)

    def test_framer_handles_partial_rtp_and_multiple_messages_in_one_read(self):
        messages = _RtspMessages()
        rtsp = b"RTSP/1.0 200 OK\r\nContent-Length: 3\r\n\r\nSDP"
        packet = _rtp(0, 1, 2, b"data")
        self.assertEqual(list(messages.feed(rtsp[:-1])), [])
        self.assertEqual(list(messages.feed(rtsp[-1:] + packet[:3])), [rtsp])
        self.assertEqual(list(messages.feed(packet[3:] + rtsp)), [packet, rtsp])
