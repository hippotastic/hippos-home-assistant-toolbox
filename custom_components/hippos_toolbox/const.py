"""Constants for Hippo's Home Assistant Toolbox."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "hippos_toolbox"
NAME = "Hippo's Home Assistant Toolbox"
MANAGED_DIRECTORY = "hippotastic"
ADOPTABLE_BLUEPRINT_DIRECTORIES = ("hippo",)
PLATFORMS: list[Platform] = [Platform.BUTTON, Platform.CAMERA, Platform.EVENT, Platform.SENSOR, Platform.UPDATE]
UPDATE_INTERVAL = timedelta(days=1)
DEVELOPMENT_UPDATE_INTERVAL = timedelta(hours=2)

GITHUB_REPOSITORY = "hippotastic/hippos-home-assistant-toolbox"
GITHUB_API_ROOT = f"https://api.github.com/repos/{GITHUB_REPOSITORY}"
GITHUB_RAW_ROOT = f"https://raw.githubusercontent.com/{GITHUB_REPOSITORY}"
GITHUB_WEB_ROOT = f"https://github.com/{GITHUB_REPOSITORY}"
CATALOG_PATH = "blueprints/catalog.json"

CONF_UPDATE_CHANNEL = "update_channel"
CONF_SOURCE_ENTITY_ID = "source_entity_id"
CONF_CAMERA_ZOOM = "camera_zoom"
CONF_CAMERA_RECOVERY = "camera_recovery"
CONF_CAMERA_STREAM_CLEANUP = "camera_stream_cleanup"
CAMERA_FRONTEND_OPTIONS = (
    CONF_CAMERA_ZOOM,
    CONF_CAMERA_RECOVERY,
    CONF_CAMERA_STREAM_CLEANUP,
)
# Keep compatible releases on the same protocol, even when the bundle changes.
CAMERA_FRONTEND_PROTOCOL = 1
DATA_CAMERA_FRONTEND = f"{DOMAIN}.frontend"
UPDATE_CHANNEL_STABLE = "stable"
UPDATE_CHANNEL_DEVELOPMENT = "development"
DEFAULT_UPDATE_CHANNEL = UPDATE_CHANNEL_STABLE
UPDATE_CHANNELS = frozenset((UPDATE_CHANNEL_STABLE, UPDATE_CHANNEL_DEVELOPMENT))

DEVELOPMENT_BRANCH = "main"

PROGRESSIVE_CAMERA_SUBENTRY_TYPE = "progressive_camera"
MONITORING_SUBENTRY_TYPE = "monitoring"
PROBLEMS_UNIQUE_ID = f"{DOMAIN}_problems"
ALARMS_UNIQUE_ID = f"{DOMAIN}_alarms"
PROBLEM_CHANGES_UNIQUE_ID = f"{DOMAIN}_problem_changes"

CONF_TRIGGER_DELAY = "trigger_delay_minutes"
CONF_SOLVED_DELAY = "solved_delay_minutes"
CONF_ALARM_UNAVAILABLE_DELAY = "alarm_unavailable_delay_minutes"
CONF_BATTERY_CRITICAL_DELAY = "battery_critical_delay_minutes"
CONF_MONITOR_PROBLEM_SENSORS = "monitor_problem_sensors"
CONF_MONITOR_CRITICAL_BATTERIES = "monitor_critical_batteries"
CONF_WARNING_LABELS = "warning_labels"
CONF_ALARM_LABELS = "alarm_labels"
CONF_IGNORED_LABELS = "ignored_labels"
CONF_BELOW_30_LABELS = "below_30_labels"
CONF_BELOW_20_LABELS = "below_20_labels"
CONF_BELOW_10_LABELS = "below_10_labels"

MONITORING_AUTOMATIC_OPTIONS = (
    CONF_MONITOR_PROBLEM_SENSORS,
    CONF_MONITOR_CRITICAL_BATTERIES,
)
MONITORING_DELAY_DEFAULTS = {
    CONF_TRIGGER_DELAY: 1,
    CONF_SOLVED_DELAY: 10,
    CONF_ALARM_UNAVAILABLE_DELAY: 5,
    CONF_BATTERY_CRITICAL_DELAY: 30,
}
MONITORING_LABEL_OPTIONS = (
    CONF_WARNING_LABELS,
    CONF_ALARM_LABELS,
    CONF_IGNORED_LABELS,
    CONF_BELOW_30_LABELS,
    CONF_BELOW_20_LABELS,
    CONF_BELOW_10_LABELS,
)
CONF_WARNING_NOTIFICATIONS = "warning_notifications"
CONF_ALARM_NOTIFICATIONS = "alarm_notifications"
MONITORING_NOTIFICATION_DEFAULTS = {
    CONF_WARNING_NOTIFICATIONS: {
        "recipients": [],
        "title": "{{ 'Problem resolved' if resolved else 'Warning' }}",
        "message": (
            "{{ problem.name }}: {% if resolved %}problem resolved."
            "{% elif problem.reason == 'unavailable' %}unavailable."
            "{% elif problem.reason == 'battery_critical' %}critical battery."
            "{% elif problem.reason == 'below_threshold' %}below the configured threshold."
            "{% else %}problem detected.{% endif %}"
        ),
    },
    CONF_ALARM_NOTIFICATIONS: {
        "recipients": [],
        "title": "{{ 'Alarm ended' if resolved else 'Alarm' }}",
        "message": "{{ problem.name }}: {{ 'alarm ended.' if resolved else 'alarm detected.' }}",
    },
}

BLUEPRINT_UPDATE_UNIQUE_ID = "hippos_toolbox_blueprints"
CHECK_UPDATES_UNIQUE_ID = "hippos_toolbox_check_for_updates"

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
