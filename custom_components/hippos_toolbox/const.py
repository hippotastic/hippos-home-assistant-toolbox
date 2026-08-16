"""Constants for Hippo's Home Assistant Toolbox."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "hippos_toolbox"
NAME = "Hippo's Home Assistant Toolbox"
MANAGED_DIRECTORY = "hippotastic"
ADOPTABLE_BLUEPRINT_DIRECTORIES = ("hippo",)
PLATFORMS: list[Platform] = [Platform.BUTTON, Platform.UPDATE]
UPDATE_INTERVAL = timedelta(days=1)
DEVELOPMENT_UPDATE_INTERVAL = timedelta(hours=2)

GITHUB_REPOSITORY = "hippotastic/hippos-home-assistant-toolbox"
GITHUB_API_ROOT = f"https://api.github.com/repos/{GITHUB_REPOSITORY}"
GITHUB_RAW_ROOT = f"https://raw.githubusercontent.com/{GITHUB_REPOSITORY}"
GITHUB_WEB_ROOT = f"https://github.com/{GITHUB_REPOSITORY}"
CATALOG_PATH = "blueprints/catalog.json"

CONF_UPDATE_CHANNEL = "update_channel"
UPDATE_CHANNEL_STABLE = "stable"
UPDATE_CHANNEL_DEVELOPMENT = "development"
DEFAULT_UPDATE_CHANNEL = UPDATE_CHANNEL_STABLE
UPDATE_CHANNELS = frozenset((UPDATE_CHANNEL_STABLE, UPDATE_CHANNEL_DEVELOPMENT))

DEVELOPMENT_BRANCH = "main"

CATALOG_SCHEMA_VERSION = 1
SUPPORTED_BLUEPRINT_DOMAINS = frozenset(("automation", "script", "template"))
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1
BACKUP_COUNT = 3


def normalize_update_channel(value: object) -> str:
    """Return a supported update channel or the stable default."""

    if isinstance(value, str) and value in UPDATE_CHANNELS:
        return value
    return DEFAULT_UPDATE_CHANNEL
