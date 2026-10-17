"""Persistent problem tracking driven by source changes and individual deadlines."""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from functools import partial
import math
from typing import Any

from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import (
    TrackStates,
    async_track_point_in_utc_time,
    async_track_state_change_filtered,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    ALARMS_UNIQUE_ID,
    CONF_ALARM_LABELS,
    CONF_ALARM_UNAVAILABLE_DELAY,
    CONF_BATTERY_CRITICAL_DELAY,
    CONF_BELOW_10_LABELS,
    CONF_BELOW_20_LABELS,
    CONF_BELOW_30_LABELS,
    CONF_IGNORED_LABELS,
    CONF_SOLVED_DELAY,
    CONF_TRIGGER_DELAY,
    CONF_WARNING_LABELS,
    DOMAIN,
    MONITORING_DELAY_DEFAULTS,
    PROBLEM_CHANGES_UNIQUE_ID,
    PROBLEMS_UNIQUE_ID,
)


@dataclass(slots=True)
class _Problem:
    entity_id: str
    name: str
    reason: str
    trigger_delay_since: datetime | None = None
    triggered_since: datetime | None = None
    solved_delay_since: datetime | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return the shared storage, sensor and event representation."""

        return {
            "entity_id": self.entity_id,
            "name": self.name,
            "reason": self.reason,
            "trigger_delay_since": self.trigger_delay_since.isoformat() if self.trigger_delay_since else None,
            "triggered_since": self.triggered_since.isoformat() if self.triggered_since else None,
            "solved_delay_since": self.solved_delay_since.isoformat() if self.solved_delay_since else None,
        }


@dataclass(frozen=True, slots=True)
class _Observation:
    active: bool | None
    name: str
    reason: str
    delay: timedelta
    alarm_active: bool | None = None


class _ProblemMonitor:
    """Own problem transitions, persistence and notification events."""

    def __init__(self, hass: HomeAssistant, entry, subentry) -> None:
        self._hass = hass
        self._entry = entry
        self._options = subentry.data
        self._registry = er.async_get(hass)
        self._store: Store[dict[str, Any]] = Store(
            hass, 1, f"{DOMAIN}.monitoring.{subentry.subentry_id}", atomic_writes=True
        )
        self._problems: dict[str, _Problem] = {}
        self._alarms: dict[str, _Problem] = {}
        self._state_listeners: set[Callable[[], None]] = set()
        self._event_listeners: set[Callable[[str, dict[str, Any]], None]] = set()
        self._unsubscribers: list[Callable[[], None]] = []
        self._tracker = None
        self._timer: Callable[[], None] | None = None
        self._tasks: set[asyncio.Task] = set()
        self._pending_entities: Counter[str] = Counter()
        self._lock = asyncio.Lock()
        self._stopped = False

    @property
    def problems(self) -> dict[str, dict[str, Any]]:
        problems = {}
        for key, value in sorted(self._problems.items()):
            problem = value.as_dict()
            # Derive the display deadline from the same configured delay used
            # for resolution; restored incidents never retain a stale countdown.
            problem["solved_delay_until"] = (
                (value.solved_delay_since + self._delay(CONF_SOLVED_DELAY)).isoformat()
                if value.solved_delay_since else None
            )
            problems[key] = problem
        return problems

    @property
    def alarms(self) -> dict[str, dict[str, Any]]:
        return {key: value.as_dict() for key, value in sorted(self._alarms.items())}

    def async_subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._state_listeners.add(listener)
        return lambda: self._state_listeners.discard(listener)

    def async_subscribe_events(
        self, listener: Callable[[str, dict[str, Any]], None]
    ) -> Callable[[], None]:
        self._event_listeners.add(listener)
        return lambda: self._event_listeners.discard(listener)

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if not isinstance(stored, dict):
            return
        for key, records in (("problems", self._problems), ("alarms", self._alarms)):
            if not isinstance(stored.get(key, {}), Mapping):
                continue
            for entity_id, data in stored.get(key, {}).items():
                if not isinstance(entity_id, str) or not isinstance(data, dict):
                    continue
                triggered = dt_util.parse_datetime(str(data.get("triggered_since")))
                if triggered is None or triggered.tzinfo is None:
                    continue
                # Downtime confirms neither a pending warning nor a solution.
                # Restored incidents must not emit their trigger a second time.
                records[entity_id] = _Problem(
                    entity_id, str(data.get("name", entity_id)),
                    str(data.get("reason", "problem")), triggered_since=triggered,
                )

    @callback
    def async_start(self) -> None:
        self._unsubscribers.append(async_at_started(self._hass, self._async_started))

    @callback
    def _async_started(self, _hass: HomeAssistant) -> None:
        if self._stopped:
            return
        self._tracker = async_track_state_change_filtered(
            self._hass, self._track_states(), self._async_source_changed
        )
        self._unsubscribers.extend((
            self._tracker.async_remove,
            self._hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, self._async_registry_changed),
        ))
        self._async_rescan()

    def _track_states(self) -> TrackStates:
        configured_labels = set().union(*(
            set(self._options.get(key, [])) for key in (
                CONF_ALARM_LABELS, CONF_WARNING_LABELS, CONF_BELOW_30_LABELS,
                CONF_BELOW_20_LABELS, CONF_BELOW_10_LABELS,
            )
        ))
        labelled = {
            item.entity_id for item in self._registry.entities.values()
            if item.labels & configured_labels
        }
        return TrackStates(False, labelled | self._problems.keys() | self._alarms.keys(), {"binary_sensor", "sensor"})

    @callback
    def _async_registry_changed(self, event: Event) -> None:
        if self._stopped:
            return
        if event.data.get("action") == "remove":
            # Explicitly deleting a source is different from a temporary loss
            # of its state. Retire that source without a misleading all-clear.
            self._async_queue(event.data["entity_id"], None)
        self._tracker.async_update_listeners(self._track_states())
        self._async_rescan()

    @callback
    def _async_rescan(self) -> None:
        entity_ids = set(self._problems) | self._alarms.keys()
        entity_ids.update(self._hass.states.async_entity_ids(("binary_sensor", "sensor")))
        entity_ids.update(self._track_states().entities)
        for entity_id in sorted(entity_ids):
            self._async_queue(entity_id, self._classify(entity_id, self._hass.states.get(entity_id)))

    @callback
    def _async_source_changed(self, event: Event) -> None:
        entity_id = event.data["entity_id"]
        observation = self._classify(entity_id, event.data["new_state"])
        if event.data["new_state"] is None and (old_state := event.data.get("old_state")) is not None:
            if (old := self._classify(entity_id, old_state)) is not None:
                observation = _Observation(None, old.name, old.reason, old.delay)
        self._async_queue(entity_id, observation)

    @callback
    def _async_queue(self, entity_id: str, observation: _Observation | None) -> None:
        if self._stopped:
            return
        # Capture each transition before awaiting disk I/O: off/on in one loop
        # turn must still cancel the pending trigger or solution deadline.
        if (
            (observation is None or observation.active is not True)
            and entity_id not in self._problems and entity_id not in self._alarms
            and (observation is None or observation.alarm_active is not True)
            and not self._pending_entities[entity_id]
        ):
            return
        self._pending_entities[entity_id] += 1
        task = self._entry.async_create_background_task(
            self._hass,
            self._async_observe(entity_id, observation, dt_util.utcnow()),
            f"monitor problem {entity_id}", eager_start=False,
        )
        self._tasks.add(task)
        task.add_done_callback(partial(self._async_observation_done, entity_id))

    @callback
    def _async_observation_done(self, entity_id: str, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        self._pending_entities[entity_id] -= 1
        if not self._pending_entities[entity_id]:
            del self._pending_entities[entity_id]

    def _delay(self, option: str) -> timedelta:
        return timedelta(minutes=float(self._options.get(option, MONITORING_DELAY_DEFAULTS[option])))

    def _classify(self, entity_id: str, state: State | None) -> _Observation | None:
        registration = self._registry.async_get(entity_id)
        if registration is not None and (
            registration.disabled_by is not None
            or registration.platform == DOMAIN
            and registration.unique_id in {PROBLEMS_UNIQUE_ID, ALARMS_UNIQUE_ID, PROBLEM_CHANGES_UNIQUE_ID}
        ):
            return None
        labels = registration.labels if registration else set()
        previous = self._problems.get(entity_id) or self._alarms.get(entity_id)
        value = state.state if state else None
        name = state.name if state else previous.name if previous else entity_id
        attributes = state.attributes if state else {}
        known = value not in {None, "unknown", "unavailable"}

        if labels & set(self._options.get(CONF_ALARM_LABELS, [])):
            # Alarm entities are excluded from ordinary problem rules. Their
            # unavailable state is itself a warning, with its own total delay.
            active = True if value == "unavailable" else False if known else None
            return _Observation(
                active, name, "unavailable", self._delay(CONF_ALARM_UNAVAILABLE_DELAY),
                value == "on" if known else None,
            )
        if labels & set(self._options.get(CONF_IGNORED_LABELS, [])):
            return None

        rules: list[tuple[bool | None, str, timedelta]] = []
        delay = self._delay(CONF_TRIGGER_DELAY)
        device_class = attributes.get("device_class")
        if device_class is None and registration is not None:
            device_class = registration.device_class or registration.original_device_class
        if entity_id.startswith("binary_sensor.") and device_class == "problem":
            rules.append((value == "on" if value in {"on", "off"} else None, "problem", delay))
        if labels & set(self._options.get(CONF_WARNING_LABELS, [])):
            rules.append((value == "on" if known else None, "problem", delay))
        if "battery_state" in attributes or (not known and previous is not None and previous.reason == "battery_critical"):
            rules.append((
                attributes.get("battery_state") == "critical" if known and "battery_state" in attributes else None,
                "battery_critical", self._delay(CONF_BATTERY_CRITICAL_DELAY),
            ))
        for option, threshold in ((CONF_BELOW_30_LABELS, 30), (CONF_BELOW_20_LABELS, 20), (CONF_BELOW_10_LABELS, 10)):
            if not labels & set(self._options.get(option, [])):
                continue
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                numeric = math.nan
            rules.append((numeric < threshold if math.isfinite(numeric) else None, "below_threshold", delay))
        active_rules = [rule for rule in rules if rule[0] is True]
        if active_rules:
            _, reason, trigger_delay = min(active_rules, key=lambda rule: rule[2])
            return _Observation(True, name, reason, trigger_delay)
        if rules:
            reason = previous.reason if previous else rules[0][1]
            return _Observation(None if any(rule[0] is None for rule in rules) else False, name, reason, delay)
        if state is None and previous is not None:
            return _Observation(None, name, previous.reason, delay)
        return None

    async def _async_observe(
        self, entity_id: str, observation: _Observation | None, observed_at: datetime
    ) -> None:
        async with self._lock:
            if self._stopped:
                return
            problem = self._problems.get(entity_id)
            rollback = replace(problem) if problem else None
            before = problem.as_dict() if problem else None
            alarm = self._alarms.get(entity_id)
            alarm_rollback = replace(alarm) if alarm else None
            alarm_before = alarm.as_dict() if alarm else None
            events: list[tuple[str, dict[str, Any]]] = []
            if observation is None or observation.reason != "unavailable":
                # Removing an alarm label is configuration, not an all-clear.
                self._alarms.pop(entity_id, None)
            elif observation.alarm_active is True:
                if alarm is None:
                    alarm = self._alarms[entity_id] = _Problem(
                        entity_id, observation.name, "alarm", triggered_since=observed_at,
                    )
                    events.append(("alarm_triggered", alarm.as_dict()))
                else:
                    alarm.name = observation.name
            elif observation.alarm_active is False and alarm is not None:
                # Actual alarms have no warning/recovery delay. Unknown or
                # unavailable states above never terminate an ongoing alarm.
                events.append(("alarm_solved", alarm.as_dict()))
                self._alarms.pop(entity_id)
            event_type: str | None = None
            event_problem: dict[str, Any] | None = None
            if observation is None:
                # Changing which sources are monitored is not a confirmed solution.
                self._problems.pop(entity_id, None)
            elif observation.active is None:
                if problem is not None:
                    if problem.triggered_since is None:
                        self._problems.pop(entity_id)
                    else:
                        problem.trigger_delay_since = None
                        problem.solved_delay_since = None
            elif observation.active:
                if problem is None:
                    problem = self._problems[entity_id] = _Problem(entity_id, observation.name, observation.reason)
                problem.name = observation.name
                problem.solved_delay_since = None
                if problem.triggered_since is None:
                    if problem.trigger_delay_since is None or problem.reason != observation.reason:
                        problem.trigger_delay_since = observed_at
                    problem.reason = observation.reason
                    if observed_at - problem.trigger_delay_since >= observation.delay:
                        problem.triggered_since = observed_at
                        problem.trigger_delay_since = None
                        event_type = "triggered"
                        event_problem = problem.as_dict()
            elif problem is not None:
                if problem.triggered_since is None:
                    self._problems.pop(entity_id)
                else:
                    problem.solved_delay_since = problem.solved_delay_since or observed_at
                    if observed_at - problem.solved_delay_since >= self._delay(CONF_SOLVED_DELAY):
                        event_type = "solved"
                        event_problem = problem.as_dict()
                        self._problems.pop(entity_id)
            after = self._problems[entity_id].as_dict() if entity_id in self._problems else None
            alarm_after = self._alarms[entity_id].as_dict() if entity_id in self._alarms else None
            if before != after or alarm_before != alarm_after:
                # Save before publishing an event so a normal reload cannot replay it.
                try:
                    await self._store.async_save({"problems": self.problems, "alarms": self.alarms})
                except (HomeAssistantError, OSError):
                    # An unsuccessful write must not mark an unsent event as done.
                    if rollback is None:
                        self._problems.pop(entity_id, None)
                    else:
                        self._problems[entity_id] = rollback
                    if alarm_rollback is None:
                        self._alarms.pop(entity_id, None)
                    else:
                        self._alarms[entity_id] = alarm_rollback
                    if self._timer is not None:
                        self._timer()
                    self._timer = async_track_point_in_utc_time(
                        self._hass, self._async_deadline, dt_util.utcnow() + timedelta(seconds=30)
                    )
                    raise
                for listener in tuple(self._state_listeners):
                    listener()
                if event_type is not None:
                    events.append((event_type, event_problem))
                for kind, record in events:
                    for listener in tuple(self._event_listeners):
                        listener(kind, record)
            self._async_schedule_deadline()

    @callback
    def _async_schedule_deadline(self) -> None:
        if self._timer is not None:
            self._timer()
            self._timer = None
        deadlines: list[datetime] = []
        for entity_id, problem in self._problems.items():
            observation = self._classify(entity_id, self._hass.states.get(entity_id))
            if observation is None:
                continue
            if observation.active and problem.trigger_delay_since is not None:
                deadlines.append(problem.trigger_delay_since + observation.delay)
            if observation.active is False and problem.solved_delay_since is not None:
                deadlines.append(problem.solved_delay_since + self._delay(CONF_SOLVED_DELAY))
        if deadlines and not self._stopped:
            self._timer = async_track_point_in_utc_time(self._hass, self._async_deadline, min(deadlines))

    @callback
    def _async_deadline(self, _now: datetime) -> None:
        self._timer = None
        self._async_rescan()

    async def async_stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        for unsubscribe in self._unsubscribers:
            unsubscribe()
        if self._timer is not None:
            self._timer()
            self._timer = None
        # Finish writes already in flight before releasing the old instance.
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
        self._state_listeners.clear()
        self._event_listeners.clear()
