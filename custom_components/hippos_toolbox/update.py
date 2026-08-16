"""Blueprint collection update entity."""

from typing import Any

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import ToolboxCoordinator
from .entity import ToolboxEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the blueprint update entity."""

    async_add_entities([ToolboxBlueprintUpdate(entry.runtime_data.coordinator)])


class ToolboxBlueprintUpdate(ToolboxEntity, UpdateEntity):
    """Represent updates for the complete blueprint collection."""

    _attr_supported_features = UpdateEntityFeature.INSTALL
    _attr_translation_key = "blueprints"
    _attr_unique_id = "hippos_toolbox_blueprints"

    @property
    def installed_version(self) -> str:
        """Return the last installed revision, or current when no update exists."""

        data = self.coordinator.data
        if not data.update_available:
            return data.snapshot.revision
        return self.coordinator.manager.installed_revision or "Not installed"

    @property
    def latest_version(self) -> str:
        """Return the latest catalog revision."""

        return self.coordinator.data.snapshot.revision

    @property
    def release_url(self) -> str:
        """Return the GitHub commit represented by this update."""

        return self.coordinator.data.snapshot.release_url

    @property
    def release_summary(self) -> str | None:
        """Summarize the blueprints included in the update."""

        data = self.coordinator.data
        count = len(data.update_ids)
        if count == 0:
            return None

        update_ids = set(data.update_ids)
        blueprint_names = [
            state.entry.name
            for state in data.blueprints
            if state.entry.id in update_ids
        ]
        blueprint_list = "\n".join(f"- {name}" for name in blueprint_names)
        return (
            f"Updates {count} blueprint{'s' if count != 1 else ''}:"
            f"\n\n{blueprint_list}"
        )

    def version_is_newer(self, latest_version: str, installed_version: str) -> bool:
        """Treat different immutable catalog revisions as newer when updates exist."""

        return self.coordinator.data.update_available and latest_version != installed_version

    async def async_install(
        self,
        version: str | None,
        backup: bool,
        **kwargs: Any,
    ) -> None:
        """Install all conflict-free blueprint updates."""

        await self.coordinator.manager.async_install_updates(self.coordinator.data)
        await self.coordinator.async_request_refresh()
