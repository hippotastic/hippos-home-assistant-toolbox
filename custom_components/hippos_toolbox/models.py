"""Data models for Hippo's Home Assistant Toolbox."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """A published blueprint catalog entry."""

    id: str
    name: str
    domain: str
    path: str
    sha256: str
    status: str
    deprecated_message: str | None = None
    replacement: str | None = None


@dataclass(frozen=True, slots=True)
class RemoteSnapshot:
    """A catalog and all metadata needed to fetch its exact revision."""

    entries: tuple[CatalogEntry, ...]
    revision: str
    commit_sha: str
    release_url: str


@dataclass(frozen=True, slots=True)
class BlueprintState:
    """Evaluated local state of one active blueprint."""

    entry: CatalogEntry
    installed_path: str
    status: str


@dataclass(frozen=True, slots=True)
class CoordinatorData:
    """Current collection state exposed to Home Assistant entities."""

    snapshot: RemoteSnapshot
    blueprints: tuple[BlueprintState, ...]
    update_ids: tuple[str, ...]
    conflict_ids: tuple[str, ...]

    @property
    def update_available(self) -> bool:
        """Return whether at least one blueprint can be updated safely."""

        return bool(self.update_ids)
