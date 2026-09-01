"""VyatSU schedule downloader and parser."""

from .parser import (
    DEFAULT_GROUP,
    DEFAULT_SCHEDULE_PAGE,
    PeriodLink,
    build_schedule,
    discover_period_links,
    merge_schedules,
    parse_pdf,
    select_period,
    select_periods,
    validate_schedule,
)

__all__ = [
    "DEFAULT_GROUP",
    "DEFAULT_SCHEDULE_PAGE",
    "PeriodLink",
    "build_schedule",
    "discover_period_links",
    "merge_schedules",
    "parse_pdf",
    "select_period",
    "select_periods",
    "validate_schedule",
]
