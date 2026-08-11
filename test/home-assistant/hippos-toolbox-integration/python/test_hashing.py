"""Tests for cross-runtime blueprint hash normalization."""

import importlib.util
from pathlib import Path
import unittest

from repository import find_repository_root


MODULE_PATH = (
    find_repository_root(Path(__file__))
    / "custom_components"
    / "hippos_toolbox"
    / "hashing.py"
)
SPEC = importlib.util.spec_from_file_location("hippos_toolbox_hashing", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
HASHING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HASHING)


class BlueprintHashTests(unittest.TestCase):
    """Verify the catalog's canonical hash contract."""

    def test_normalizes_line_endings_and_boundary_whitespace(self) -> None:
        """Transport-only differences produce the same hash."""

        self.assertEqual(
            HASHING.blueprint_hash(" \t\r\nblueprint:\r\n  name: Test\r\n\r\n"),
            HASHING.blueprint_hash("blueprint:\n  name: Test"),
        )

    def test_keeps_internal_whitespace_significant(self) -> None:
        """Whitespace inside the YAML document remains part of the hash."""

        self.assertNotEqual(
            HASHING.blueprint_hash("value: one  \nnext: two"),
            HASHING.blueprint_hash("value: one\nnext: two"),
        )


if __name__ == "__main__":
    unittest.main()
