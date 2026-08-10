from __future__ import annotations

import asyncio
import time
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback


DOMAIN = "blueprint_test"
MAX_EVENTS = 500


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    hass.data[DOMAIN] = {"events": []}
    for item in _config.get(DOMAIN, {}).get("states", []):
        hass.states.async_set(item["entity_id"], item["state"], item["attributes"])
    hass.bus.async_listen("call_service", lambda event: _record_event(hass, event))
    hass.bus.async_listen("state_changed", lambda event: _record_event(hass, event))
    hass.http.register_view(BlueprintTestView)
    return True


class BlueprintTestView(HomeAssistantView):
    url = "/api/blueprint-test/{command}"
    name = "api:blueprint_test"
    requires_auth = False

    async def get(self, request: web.Request, command: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]

        if command == "health":
            return web.json_response({"ok": True, "state": str(hass.state)})

        if command == "diagnostics":
            return web.json_response(_diagnostics(hass))

        return web.json_response({"error": "unknown command"}, status=404)

    async def post(self, request: web.Request, command: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        data = await request.json()

        if command == "call_service":
            await hass.services.async_call(
                data["domain"],
                data["service"],
                data.get("data") or {},
                blocking=True,
            )
            return web.json_response({"ok": True})

        if command == "clear_events":
            hass.data[DOMAIN]["events"] = []
            return web.json_response({"ok": True})

        if command == "set_state":
            timestamp = None
            if "last_changed_age_seconds" in data:
                timestamp = time.time() - float(data["last_changed_age_seconds"])
            hass.states.async_set(
                data["entity_id"],
                data["state"],
                data.get("attributes") or {},
                force_update=True,
                timestamp=timestamp,
            )
            return web.json_response({"ok": True})

        if command == "get_state":
            return web.json_response({"state": _serialized_state(hass, data["entity_id"])})

        if command == "events":
            return web.json_response({"events": hass.data[DOMAIN]["events"]})

        if command == "diagnostics":
            return web.json_response(_diagnostics(hass))

        if command == "wait_state":
            entity_id = data["entity_id"]
            expected_state = data["state"]
            timeout = float(data.get("timeout", 5))
            return web.json_response({"state": await _wait_state(hass, entity_id, expected_state, timeout)})

        return web.json_response({"error": "unknown command"}, status=404)


@callback
def _record_event(hass: HomeAssistant, event: Any) -> None:
    events = hass.data[DOMAIN]["events"]
    events.append(
        {
            "event_type": event.event_type,
            "data": _serializable(event.data),
            "time_fired": event.time_fired.isoformat(),
        }
    )
    del events[:-MAX_EVENTS]


def _diagnostics(hass: HomeAssistant) -> dict[str, Any]:
    return {
        "events": hass.data[DOMAIN]["events"],
        "states": [_serialized_state(hass, state.entity_id) for state in hass.states.async_all()],
    }


def _serializable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _serializable(item) for key, item in value.items()}

    if isinstance(value, list):
        return [_serializable(item) for item in value]

    if isinstance(value, tuple):
        return [_serializable(item) for item in value]

    if hasattr(value, "as_dict"):
        return _serializable(value.as_dict())

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    return str(value)


async def _wait_state(hass: HomeAssistant, entity_id: str, expected_state: str, timeout: float) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout

    while True:
        state = hass.states.get(entity_id)

        if state is not None and state.state == expected_state:
            return _serialized_state(hass, entity_id)

        if asyncio.get_running_loop().time() >= deadline:
            current = None if state is None else state.state
            raise web.HTTPRequestTimeout(text=f"{entity_id} did not become {expected_state}; current state is {current}")

        await asyncio.sleep(0.05)


def _serialized_state(hass: HomeAssistant, entity_id: str) -> dict[str, Any] | None:
    state = hass.states.get(entity_id)

    if state is None:
        return None

    return {
        "entity_id": state.entity_id,
        "state": state.state,
        "attributes": _serializable(dict(state.attributes)),
        "last_changed": state.last_changed.isoformat(),
        "last_updated": state.last_updated.isoformat(),
    }
