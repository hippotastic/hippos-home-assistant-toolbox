"""Regression tests for the blueprint update entity."""

from types import SimpleNamespace
import unittest

from custom_components.hippos_toolbox.update import ToolboxBlueprintUpdate


def update_entity(
    blueprints: tuple[tuple[str, str], ...],
    update_ids: tuple[str, ...],
) -> ToolboxBlueprintUpdate:
    """Create an update entity with minimal coordinator data."""

    entity = object.__new__(ToolboxBlueprintUpdate)
    entity.coordinator = SimpleNamespace(
        data=SimpleNamespace(
            blueprints=tuple(
                SimpleNamespace(entry=SimpleNamespace(id=blueprint_id, name=name))
                for blueprint_id, name in blueprints
            ),
            update_ids=update_ids,
        )
    )
    return entity


class ToolboxBlueprintUpdateTests(unittest.TestCase):
    """Verify user-facing update summaries."""

    def test_omits_summary_without_updates(self) -> None:
        entity = update_entity((), ())

        self.assertIsNone(entity.release_summary)

    def test_lists_one_blueprint_title(self) -> None:
        entity = update_entity(
            (("cover", "Hippo's Cover Automation"),),
            ("cover",),
        )

        self.assertEqual(
            entity.release_summary,
            "Updates 1 blueprint:\n\n- Hippo's Cover Automation",
        )

    def test_lists_updated_titles_in_catalog_order(self) -> None:
        entity = update_entity(
            (
                ("cover", "Hippo's Cover Automation"),
                ("scheduler", "Hippo's Irrigation Scheduler"),
                ("calculation", "Hippo's Irrigation Zone Calculation"),
            ),
            ("calculation", "scheduler"),
        )

        self.assertEqual(
            entity.release_summary,
            "Updates 2 blueprints:\n\n"
            "- Hippo's Irrigation Scheduler\n"
            "- Hippo's Irrigation Zone Calculation",
        )


if __name__ == "__main__":
    unittest.main()
