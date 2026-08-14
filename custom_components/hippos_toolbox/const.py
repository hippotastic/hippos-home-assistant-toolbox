"""Constants for Hippo's Home Assistant Toolbox."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "hippos_toolbox"
NAME = "Hippo's Home Assistant Toolbox"
MANAGED_DIRECTORY = "hippotastic"
ADOPTABLE_BLUEPRINT_DIRECTORIES = ("hippo",)
PLATFORMS: list[Platform] = [Platform.BUTTON, Platform.UPDATE]
UPDATE_INTERVAL = timedelta(days=1)

GITHUB_REPOSITORY = "hippotastic/hippos-home-assistant-toolbox"
GITHUB_API_ROOT = f"https://api.github.com/repos/{GITHUB_REPOSITORY}"
GITHUB_RAW_ROOT = f"https://raw.githubusercontent.com/{GITHUB_REPOSITORY}"
GITHUB_WEB_ROOT = f"https://github.com/{GITHUB_REPOSITORY}"
CATALOG_PATH = "blueprints/catalog.json"

CONF_RELEASE_CHANNEL = "release_channel"
RELEASE_CHANNEL_STABLE = "stable"
RELEASE_CHANNEL_BETA = "beta"
DEFAULT_RELEASE_CHANNEL = RELEASE_CHANNEL_STABLE
RELEASE_CHANNEL_BRANCHES = {
    RELEASE_CHANNEL_STABLE: "main",
    RELEASE_CHANNEL_BETA: "beta",
}

CATALOG_SCHEMA_VERSION = 1
SUPPORTED_BLUEPRINT_DOMAINS = frozenset(("automation", "script", "template"))
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1
BACKUP_COUNT = 3
