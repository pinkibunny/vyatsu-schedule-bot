#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from vyatsu_schedule import (
    DEFAULT_GROUP,
    DEFAULT_SCHEDULE_PAGE,
    build_schedule,
    discover_period_links,
    merge_schedules,
    select_periods,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Обновить JSON расписания ВятГУ")
    parser.add_argument("--group", default=DEFAULT_GROUP)
    parser.add_argument("--page-url", default=DEFAULT_SCHEDULE_PAGE)
    parser.add_argument(
        "--target-date",
        type=date.fromisoformat,
        default=datetime.now(ZoneInfo("Europe/Moscow")).date(),
    )
    parser.add_argument("--output", type=Path, default=Path("data/schedule.json"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    headers = {"User-Agent": "VyatSU-Schedule-Bot/0.1 (+student hobby project)"}
    with httpx.Client(
        headers=headers,
        follow_redirects=True,
        timeout=40,
    ) as client:
        page_response = client.get(args.page_url)
        page_response.raise_for_status()
        periods = discover_period_links(
            page_response.text,
            group=args.group,
            base_url=args.page_url,
        )
        selected_periods = select_periods(periods, args.target_date, limit=2)
        schedules = []
        for period in selected_periods:
            pdf_response = client.get(period.url)
            pdf_response.raise_for_status()
            if not pdf_response.content.startswith(b"%PDF"):
                raise ValueError(f"Сервер ВятГУ вернул не PDF: {period.url}")
            schedules.append(
                build_schedule(
                    pdf_bytes=pdf_response.content,
                    period=period,
                    group=args.group,
                    page_url=args.page_url,
                )
            )

    checked_at = datetime.now(timezone.utc)
    schedule = merge_schedules(schedules, generated_at=checked_at)
    lessons = sum(len(day["lessons"]) for day in schedule["days"])
    content_changed = True
    if args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        comparable_keys = ("group", "source", "period", "days")
        if all(previous.get(key) == schedule.get(key) for key in comparable_keys):
            content_changed = False
            schedule["generated_at"] = previous.get(
                "generated_at", schedule["generated_at"]
            )
            try:
                previous_check = datetime.fromisoformat(previous["checked_at"])
                checked_today = (
                    previous_check.astimezone(ZoneInfo("Europe/Moscow")).date()
                    == checked_at.astimezone(ZoneInfo("Europe/Moscow")).date()
                )
            except (KeyError, TypeError, ValueError):
                checked_today = False
            if checked_today:
                print(
                    f"Без изменений: {args.group}, {len(schedule['days'])} дней, "
                    f"{lessons} записей, {len(selected_periods)} PDF"
                )
                return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(schedule, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    action = "Обновлено расписание" if content_changed else "Обновлена отметка проверки"
    print(
        f"{action}: {args.group}, {len(schedule['days'])} дней, "
        f"{lessons} записей, {len(selected_periods)} PDF"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Ошибка обновления: {error}", file=sys.stderr)
        raise
