#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from vyatsu_schedule import (
    DEFAULT_GROUP,
    DEFAULT_SCHEDULE_PAGE,
    build_schedule,
    discover_period_links,
    select_period,
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
        period = select_period(periods, args.target_date)

        pdf_response = client.get(period.url)
        pdf_response.raise_for_status()
        if not pdf_response.content.startswith(b"%PDF"):
            raise ValueError("Сервер ВятГУ вернул не PDF")

    schedule = build_schedule(
        pdf_bytes=pdf_response.content,
        period=period,
        group=args.group,
    )
    lessons = sum(len(day["lessons"]) for day in schedule["days"])
    if args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        comparable_keys = ("group", "source", "period", "days")
        if all(previous.get(key) == schedule.get(key) for key in comparable_keys):
            print(
                f"Без изменений: {args.group}, {len(schedule['days'])} дней, "
                f"{lessons} записей"
            )
            return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(schedule, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Обновлено: {args.group}, {len(schedule['days'])} дней, "
        f"{lessons} записей, {period.url}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Ошибка обновления: {error}", file=sys.stderr)
        raise
