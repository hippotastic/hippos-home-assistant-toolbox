from __future__ import annotations

import asyncio
from pathlib import Path
import time
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.util import dt as dt_util


DOMAIN = "blueprint_test"
MAX_EVENTS = 5000


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    hass.data[DOMAIN] = {"events": [], "next_event_id": 1}
    for item in _config.get(DOMAIN, {}).get("states", []):
        hass.states.async_set(item["entity_id"], item["state"], item["attributes"])

    @callback
    def record_event(event: Any) -> None:
        _record_event(hass, event)

    hass.bus.async_listen("call_service", record_event)
    hass.bus.async_listen("state_changed", record_event)
    hass.bus.async_listen("automation_triggered", record_event)
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

        if command == "blueprint_adoption_result":
            return web.json_response(hass.data[DOMAIN]["blueprint_adoption_result"])

        return web.json_response({"error": "unknown command"}, status=404)

    async def post(self, request: web.Request, command: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        data = await request.json()

        if command == "call_service":
            context = Context()
            await hass.services.async_call(
                data["domain"],
                data["service"],
                data.get("data") or {},
                blocking=True,
                context=context,
            )
            return web.json_response({"context_id": context.id, "ok": True})

        if command == "clear_events":
            hass.data[DOMAIN]["events"] = []
            return web.json_response({"ok": True})

        if command == "event_cursor":
            return web.json_response({"event_cursor": _latest_event_id(hass)})

        if command == "fire_event":
            hass.bus.async_fire(data["event_type"], data.get("data") or {})
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return web.json_response({"ok": True})

        if command == "set_state":
            timestamp = None
            if "last_changed_age_seconds" in data:
                timestamp = time.time() - float(data["last_changed_age_seconds"])
            context = Context()
            hass.states.async_set(
                data["entity_id"],
                data["state"],
                data.get("attributes") or {},
                context=context,
                force_update=True,
                timestamp=timestamp,
            )
            return web.json_response({"context_id": context.id, "ok": True})

        if command == "get_state":
            return web.json_response({"state": _serialized_state(hass, data["entity_id"])})

        if command == "events":
            return web.json_response(_event_window(hass, int(data.get("after_event_id", 0))))

        if command == "settle_action":
            return web.json_response(
                await _settle_action(
                    hass,
                    set(data["automation_entity_ids"]),
                    int(data["after_event_id"]),
                    float(data.get("timeout", 0.5)),
                )
            )

        if command == "fire_scheduled_time":
            target = dt_util.parse_time(data["time"])
            if target is None:
                return web.json_response({"error": "invalid time"}, status=400)

            fired = 0
            # HA time triggers are loop timers; invoke only jobs registered for the requested wall time.
            for handle in list(hass.loop._scheduled):
                timer = handle._callback
                point = getattr(timer, "utc_point_in_time", None)
                job = getattr(timer, "job", None)
                if (
                    point is None
                    or job is None
                    or dt_util.as_local(point).time().replace(microsecond=0) != target
                ):
                    continue
                timer.async_cancel()
                hass.async_run_hass_job(job, point)
                fired += 1

            # Let the timer jobs start without waiting for their automation delays.
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            return web.json_response({"fired": fired})

        if command == "run_blueprint_adoption":
            result = await _run_blueprint_adoption(hass)
            hass.data[DOMAIN]["blueprint_adoption_result"] = result
            return web.json_response(result)

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
    domain_data = hass.data[DOMAIN]
    events = domain_data["events"]
    events.append(
        {
            "context": {
                "id": event.context.id,
                "parent_id": event.context.parent_id,
                "user_id": event.context.user_id,
            },
            "event_type": event.event_type,
            "data": _serializable(event.data),
            "id": domain_data["next_event_id"],
            "time_fired": event.time_fired.isoformat(),
        }
    )
    domain_data["next_event_id"] += 1
    del events[:-MAX_EVENTS]


def _latest_event_id(hass: HomeAssistant) -> int:
    return hass.data[DOMAIN]["next_event_id"] - 1


def _event_window(hass: HomeAssistant, after_event_id: int) -> dict[str, Any]:
    events = hass.data[DOMAIN]["events"]
    oldest_event_id = events[0]["id"] if events else _latest_event_id(hass) + 1
    if after_event_id < oldest_event_id - 1:
        raise web.HTTPConflict(
            text=(
                f"Event cursor {after_event_id} is older than retained event "
                f"{oldest_event_id}; the test can no longer observe every event"
            )
        )

    return {
        "events": [event for event in events if event["id"] > after_event_id],
        "latest_event_id": _latest_event_id(hass),
        "oldest_event_id": oldest_event_id,
    }


async def _settle_action(
    hass: HomeAssistant,
    automation_entity_ids: set[str],
    after_event_id: int,
    timeout: float,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    stable_turns = 0
    last_relevant_event_id = after_event_id

    while True:
        await asyncio.sleep(0)
        relevant_events = [
            event
            for event in _event_window(hass, after_event_id)["events"]
            if _event_belongs_to_automation(event, automation_entity_ids)
        ]
        relevant_event_id = relevant_events[-1]["id"] if relevant_events else after_event_id
        running = [
            entity_id
            for entity_id in automation_entity_ids
            if (state := hass.states.get(entity_id)) is not None
            and int(state.attributes.get("current", 0)) > 0
        ]

        if not running and relevant_event_id == last_relevant_event_id:
            stable_turns += 1
        else:
            stable_turns = 0
            last_relevant_event_id = relevant_event_id

        if stable_turns >= 3:
            return {
                "event_cursor": _latest_event_id(hass),
                "relevant_event_count": len(relevant_events),
            }

        if asyncio.get_running_loop().time() >= deadline:
            raise web.HTTPRequestTimeout(
                text=(
                    "Scenario action did not settle; running automations: "
                    f"{', '.join(running) if running else 'none'}"
                )
            )


def _event_belongs_to_automation(
    event: dict[str, Any], automation_entity_ids: set[str]
) -> bool:
    if event["event_type"] == "automation_triggered":
        return event["data"].get("entity_id") in automation_entity_ids

    if event["event_type"] == "state_changed":
        return event["data"].get("entity_id") in automation_entity_ids

    return False


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


async def _run_blueprint_adoption(hass: HomeAssistant) -> dict[str, Any]:
    """Exercise production adoption against a loaded legacy automation."""

    from custom_components.hippos_toolbox.hashing import blueprint_hash
    from custom_components.hippos_toolbox.manager import BlueprintManager
    from custom_components.hippos_toolbox.models import CatalogEntry, RemoteSnapshot

    blueprint_id = "cover_automation"
    legacy_reference = "hippo/cover_automation.yaml"
    managed_reference = "hippotastic/cover_automation.yaml"
    legacy_path = Path(
        hass.config.path("blueprints", "automation", legacy_reference)
    )
    managed_path = Path(
        hass.config.path("blueprints", "automation", managed_reference)
    )
    source = await hass.async_add_executor_job(_read_utf8, managed_path)
    entry = CatalogEntry(
        id=blueprint_id,
        name="Hippo's Cover Automation",
        domain="automation",
        path="blueprints/automation/cover_automation.yaml",
        sha256=blueprint_hash(source),
        status="active",
    )
    snapshot = RemoteSnapshot(
        entries=(entry,),
        revision="integration-test",
        commit_sha="a" * 40,
        release_url="https://example.invalid/integration-test",
    )
    automation_component = hass.data["automation"]
    automation_entity_ids = (
        "automation.fixture_legacy_blueprint_adoption_one",
        "automation.fixture_legacy_blueprint_adoption_two",
    )

    class StaticApi:
        async def async_fetch_blueprint(
            self, _snapshot: RemoteSnapshot, _entry: CatalogEntry
        ) -> str:
            return source

    def referenced_blueprints() -> list[str | None]:
        entities = (
            automation_component.get_entity(entity_id)
            for entity_id in automation_entity_ids
        )
        return [
            None if entity is None else entity.referenced_blueprint
            for entity in entities
        ]

    def in_use(reference: str) -> int:
        return sum(
            entity.referenced_blueprint == reference
            for entity in automation_component.entities
        )

    before_states = [hass.states.get(entity_id) for entity_id in automation_entity_ids]
    assert all(state is not None for state in before_states)
    before = {
        "automation_states": [state.state for state in before_states],
        "legacy_in_use": in_use(legacy_reference),
        "managed_in_use": in_use(managed_reference),
        "references": referenced_blueprints(),
    }
    manager = BlueprintManager(hass, StaticApi())
    manager.snapshot = snapshot
    restored = await manager.async_restore_blueprint(blueprint_id)
    automations_path = Path(hass.config.path("automations.yaml"))
    automations_source = await hass.async_add_executor_job(
        _read_utf8, automations_path
    )
    after_states = [hass.states.get(entity_id) for entity_id in automation_entity_ids]
    assert all(state is not None for state in after_states)
    after = {
        "automation_states": [state.state for state in after_states],
        "legacy_in_use": in_use(legacy_reference),
        "managed_in_use": in_use(managed_reference),
        "references": referenced_blueprints(),
    }
    return {
        "after": after,
        "automations_use_legacy_path": legacy_reference in automations_source,
        "automations_use_managed_path": managed_reference in automations_source,
        "before": before,
        "legacy_file_exists": await hass.async_add_executor_job(legacy_path.exists),
        "managed_file_exists": await hass.async_add_executor_job(managed_path.exists),
        "restored": restored,
    }


def _read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8")


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
