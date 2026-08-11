"""Locate repository files from container-backed regression tests."""

from pathlib import Path


def find_repository_root(source: Path) -> Path:
    """Find the repository root without depending on the test directory depth."""

    for candidate in source.resolve().parents:
        if (candidate / "package.json").is_file() and (
            candidate / "custom_components" / "hippos_toolbox"
        ).is_dir():
            return candidate
    raise RuntimeError(f"Could not locate repository root from {source}")
