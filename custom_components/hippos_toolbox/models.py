"""Data models for Hippo's Home Assistant Toolbox."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """An entry in the bundled blueprint catalog."""

    id: str
    name: str
    domain: str
    path: str
    sha256: str
    status: str
    deprecated_message: str | None = None
    replacement: str | None = None


@dataclass(frozen=True, slots=True)
class BlueprintState:
    """Evaluated local state of one active blueprint."""

    entry: CatalogEntry
    installed_path: str
    status: str


@dataclass(frozen=True, slots=True)
class AffectedAutomation:
    """Describe one automation incompatible with a blueprint replacement."""

    name: str
    automation_id: str | None
    missing_inputs: tuple[str, ...]
