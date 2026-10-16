"""Regression tests for closing native MJPEG requests without decoding them."""

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, ClientPayloadError, web

from homeassistant.components import camera
from homeassistant.components.http.const import KEY_AUTHENTICATED, KEY_HASS_USER

from custom_components.hippos_toolbox import camera_stream
from custom_components.hippos_toolbox.const import DATA_CAMERA_FRONTEND, CONF_CAMERA_STREAM_CLEANUP


class _Connection:
    def __init__(self, user_id="viewer", allowed=True):
        self.user = SimpleNamespace(
            id=user_id,
            permissions=SimpleNamespace(check_entity=lambda *_: allowed),
        )
        self.refresh_token_id = "test-refresh-token"
        self.subscriptions = {}
        self.results = {}
        self.errors = {}

    def send_result(self, message_id, result):
        self.results[message_id] = result

    def send_error(self, message_id, code, message):
        self.errors[message_id] = code


class _NativeCamera(camera.Camera):
    """A non-toolbox camera with its own streaming implementation."""

    def __init__(self):
        super().__init__()
        self.entity_id = "camera.front_door"
        self.queues = []
        self.finished = []

    async def handle_async_mjpeg_stream(self, request):
        queue = asyncio.Queue()
        self.queues.append(queue)
        response = web.StreamResponse(
            headers={"Content-Type": "multipart/x-mixed-replace; boundary=frame"}
        )
        await response.prepare(request)
        await response.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\ncached\r\n")
        try:
            while True:
                frame = await queue.get()
                await response.write(frame)
        finally:
            self.finished.append(queue)


class CameraStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.entity = _NativeCamera()
        self.connection = _Connection()
        self.request_user = self.connection.user
        self.commands = {}
        self.views = []
        self.hass = SimpleNamespace(
            loop=asyncio.get_running_loop(),
            data={camera.DATA_COMPONENT: SimpleNamespace(get_entity=lambda entity_id: self.entity if entity_id == self.entity.entity_id else None)},
            http=SimpleNamespace(register_view=self.views.append),
        )
        self.hass.data[DATA_CAMERA_FRONTEND] = SimpleNamespace(settings={CONF_CAMERA_STREAM_CLEANUP: True})
        with (
            patch.object(camera_stream.websocket_api, "async_register_command", side_effect=lambda _hass, handler: self.commands.__setitem__(handler._ws_command, handler)),
        ):
            camera_stream.async_setup_camera_streams(self.hass)
            camera_stream.async_setup_camera_streams(self.hass)
        self.assertEqual(len(self.views), 1)
        self.sessions = self.hass.data[camera_stream._DATA_KEY]
        self.view = self.views[0]
        app = web.Application()

        async def handle(request):
            request[KEY_AUTHENTICATED] = True
            request[KEY_HASS_USER] = self.request_user
            return await self.view.get(request, self.entity.entity_id)

        app.router.add_get(self.view.url, handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.base_url = f"http://127.0.0.1:{self.site._server.sockets[0].getsockname()[1]}"
        self.client = ClientSession()

    async def asyncTearDown(self):
        for stream_id in tuple(self.sessions):
            camera_stream._stop_session(self.sessions, stream_id)
        await self.client.close()
        await self.runner.cleanup()

    def open(self, message_id=1, connection=None, entity_id="camera.front_door"):
        connection = connection or self.connection
        with patch.object(camera_stream, "async_sign_path", side_effect=lambda _hass, path, *_args, **_kwargs: path):
            self.commands[camera_stream._OPEN_COMMAND](self.hass, connection, {"id": message_id, "type": camera_stream._OPEN_COMMAND, "entity_id": entity_id})
        return connection.results.get(message_id)

    def stop(self, stream_id, connection=None, message_id=20):
        connection = connection or self.connection
        self.commands[camera_stream._STOP_COMMAND](self.hass, connection, {"id": message_id, "type": camera_stream._STOP_COMMAND, "stream_id": stream_id})
        return connection.results.get(message_id)

    async def get(self, path):
        response = await self.client.get(self.base_url + path)
        self.addCleanup(response.close)
        return response

    async def test_stops_one_real_http_response_while_the_other_camera_view_continues(self):
        first = self.open(1)
        second = self.open(2)
        a = await self.get(first["path"])
        b = await self.get(second["path"])
        self.assertTrue(a.headers["Content-Type"].startswith("multipart/"))
        self.assertIn(b"cached", await a.content.read(1000))
        self.assertIn(b"cached", await b.content.read(1000))
        self.assertEqual(len(self.sessions), 2)
        self.assertTrue(self.stop(first["stream_id"])["stopped"])
        with self.assertRaises(ClientPayloadError):
            await asyncio.wait_for(a.content.read(), 1)
        await asyncio.sleep(0)
        self.assertEqual(self.entity.finished, [self.entity.queues[0]])
        self.entity.queues[1].put_nowait(b"fresh frame")
        self.assertEqual(await asyncio.wait_for(b.content.read(1000), 1), b"fresh frame")
        self.assertIn(second["stream_id"], self.sessions)

    async def test_stop_before_http_prevents_late_start_and_is_idempotent(self):
        opened = self.open()
        self.assertTrue(self.stop(opened["stream_id"])["stopped"])
        self.assertFalse(self.stop(opened["stream_id"])["stopped"])
        response = await self.get(opened["path"])
        self.assertEqual(response.status, 404)
        self.assertEqual(self.entity.queues, [])
        self.assertEqual(self.connection.subscriptions, {})

    async def test_a_different_browser_connection_cannot_stop_another_stream(self):
        opened = self.open()
        other = _Connection()
        self.stop(opened["stream_id"], other)
        self.assertEqual(other.errors[20], "unauthorized")
        self.assertIn(opened["stream_id"], self.sessions)

    async def test_websocket_close_stops_all_of_its_streams_without_mutating_iteration(self):
        self.open(1)
        self.open(2)
        for unsubscribe in self.connection.subscriptions.values():
            unsubscribe()
        self.connection.subscriptions.clear()
        self.assertEqual(self.sessions, {})

    async def test_unused_reservations_expire(self):
        opened = self.open()
        self.sessions[opened["stream_id"]].expires._run()
        self.assertEqual(self.sessions, {})
        self.assertEqual(self.connection.subscriptions, {})

    async def test_disable_closes_sessions_and_rejects_new_reservations(self):
        self.open()
        self.hass.data[DATA_CAMERA_FRONTEND].settings[CONF_CAMERA_STREAM_CLEANUP] = False
        camera_stream.async_stop_camera_streams(self.hass)
        self.assertEqual(self.sessions, {})
        self.assertIsNone(self.open(2))
        self.assertEqual(self.connection.errors[2], "feature_disabled")

    async def test_preserves_ha_still_stream_interval_in_the_signed_path(self):
        with patch.object(camera_stream, "async_sign_path", side_effect=lambda _hass, path, *_args, **_kwargs: path):
            self.commands[camera_stream._OPEN_COMMAND](self.hass, self.connection, {
                "id": 1, "type": camera_stream._OPEN_COMMAND,
                "entity_id": self.entity.entity_id, "interval": 2.0,
            })
        self.assertIn("&interval=2.0", self.connection.results[1]["path"])

    async def test_rejects_missing_cameras_and_missing_read_permissions(self):
        denied = _Connection(allowed=False)
        self.assertIsNone(self.open(connection=denied))
        self.assertEqual(denied.errors[1], "unauthorized")
        self.assertIsNone(self.open(entity_id="camera.missing"))
        self.assertEqual(self.connection.errors[1], "not_found")
        self.assertEqual(self.sessions, {})

    async def test_signed_stream_cannot_be_replayed_or_used_by_another_user(self):
        opened = self.open()
        response = await self.get(opened["path"])
        await response.content.read(1000)
        replay = await self.get(opened["path"])
        self.assertEqual(replay.status, 409)
        self.stop(opened["stream_id"])
        fresh = self.open(2)
        self.request_user = SimpleNamespace(id="someone-else")
        denied = await self.get(fresh["path"])
        self.assertEqual(denied.status, 404)


if __name__ == "__main__":
    unittest.main()
