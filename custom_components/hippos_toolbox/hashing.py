"""Canonical hashing shared by all managed blueprint comparisons."""

from hashlib import sha256


def canonicalize_blueprint_content(content: str) -> str:
    """Normalize transport-only differences without changing internal YAML."""

    return content.replace("\r\n", "\n").replace("\r", "\n").strip(" \t\n\f\v")


def blueprint_hash(content: str) -> str:
    """Return the SHA-256 hash of canonical blueprint content."""

    return sha256(canonicalize_blueprint_content(content).encode("utf-8")).hexdigest()
