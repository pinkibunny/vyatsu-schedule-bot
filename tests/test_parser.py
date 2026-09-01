from datetime import date, datetime, timezone

from vyatsu_schedule.parser import (
    DEFAULT_GROUP,
    PeriodLink,
    _parse_entry,
    discover_period_links,
    merge_schedules,
    select_period,
    select_periods,
    validate_schedule,
)


def test_discover_group_period() -> None:
    html = f"""
    <div class="grpPeriod" data-grp_period_id="267291"> {DEFAULT_GROUP} </div>
    <div class="listPeriod" id="listPeriod_267291">
      <a href="/reports/schedule/Group/26729_1_01092026_13092026.pdf">
        c 01 09 2026 по 13 09 2026
      </a>
    </div>
    """
    periods = discover_period_links(html)
    assert len(periods) == 1
    assert periods[0].group_id == "26729"
    assert periods[0].start == date(2026, 9, 1)
    assert periods[0].schedule_start == date(2026, 8, 31)


def test_select_period_prefers_containing_date() -> None:
    first = PeriodLink("https://example/1.pdf", "26729", 1, date(2026, 9, 1), date(2026, 9, 13))
    second = PeriodLink("https://example/2.pdf", "26729", 1, date(2026, 9, 14), date(2026, 9, 27))
    assert select_period([first, second], date(2026, 9, 10)) == first
    assert select_period([first, second], date(2026, 9, 20)) == second


def test_select_periods_includes_next_published_period() -> None:
    first = PeriodLink("https://example/1.pdf", "26729", 1, date(2026, 9, 1), date(2026, 9, 13))
    second = PeriodLink("https://example/2.pdf", "26729", 1, date(2026, 9, 14), date(2026, 9, 27))
    third = PeriodLink("https://example/3.pdf", "26729", 1, date(2026, 9, 28), date(2026, 10, 11))
    assert select_periods([first, second, third], date(2026, 9, 10)) == [first, second]
    assert select_periods([first, second, third], date(2026, 9, 20)) == [second, third]


def test_parse_regular_entry() -> None:
    lesson = _parse_entry(
        "БТб-3101-03-00, 01 подгруппа Биотехнология "
        "Лабораторная работа Злобин А.А. 1-328",
        group=DEFAULT_GROUP,
    )
    assert lesson["subject"] == "Биотехнология"
    assert lesson["type"] == "Лабораторная работа"
    assert lesson["teacher"] == "Злобин А.А."
    assert lesson["room"] == "1-328"
    assert lesson["subgroup"] == 1


def test_parse_sport_entry() -> None:
    lesson = _parse_entry(
        "БТб-3101-03-00, 02 подгруппа Элективные дисциплины (модули) "
        "по физической культуре и спорту Практическое занятие (11 126) "
        "Практическое занятие Пластинина В.Б. 9-208",
        group=DEFAULT_GROUP,
    )
    assert lesson["stream_code"] == "11 126"
    assert lesson["teacher"] == "Пластинина В.Б."
    assert lesson["room"] == "9-208"
    assert lesson["subgroup"] == 2


def test_parse_subgroup_without_leading_zero_and_multiple_teachers() -> None:
    lesson = _parse_entry(
        "БТб-3101-03-00, 1 подгруппа Биотехнология "
        "Лабораторная работа Иванов И.И., Петров П.П. 1-328",
        group=DEFAULT_GROUP,
    )
    assert lesson["subgroup"] == 1
    assert lesson["teacher"] == "Иванов И.И., Петров П.П."
    assert lesson["room"] == "1-328"


def test_merge_schedules_keeps_current_and_next_period() -> None:
    first_period = PeriodLink(
        "https://example/1.pdf", "26729", 1, date(2026, 9, 1), date(2026, 9, 13)
    )
    second_period = PeriodLink(
        "https://example/2.pdf", "26729", 1, date(2026, 9, 14), date(2026, 9, 27)
    )
    generated_at = datetime(2026, 9, 1, tzinfo=timezone.utc)

    def fake_schedule(period: PeriodLink, subject: str) -> dict:
        weekdays = (
            "понедельник",
            "вторник",
            "среда",
            "четверг",
            "пятница",
            "суббота",
            "воскресенье",
        )
        days = []
        current = period.schedule_start
        while current <= period.schedule_end:
            days.append(
                {
                    "date": current.isoformat(),
                    "weekday": weekdays[current.weekday()],
                    "lessons": [
                        {
                            "subject": subject,
                            "type": "Лекция",
                            "teacher": "Иванов И.И.",
                            "room": "1-100",
                            "subgroup": None,
                            "stream_code": None,
                            "raw": subject,
                            "start": "10:00",
                            "end": "11:30",
                        }
                    ],
                }
            )
            current = date.fromordinal(current.toordinal() + 1)
        return {
            "schema_version": 1,
            "group": DEFAULT_GROUP,
            "generated_at": generated_at.isoformat(),
            "source": {
                "page_url": "https://example/page",
                "pdf_url": period.url,
                "pdf_sha256": subject,
            },
            "period": {
                "published_start": period.start.isoformat(),
                "published_end": period.end.isoformat(),
                "schedule_start": period.schedule_start.isoformat(),
                "schedule_end": period.schedule_end.isoformat(),
            },
            "days": days,
        }

    merged = merge_schedules(
        [fake_schedule(first_period, "Первая"), fake_schedule(second_period, "Вторая")],
        generated_at=generated_at,
    )
    validate_schedule(merged)
    assert len(merged["days"]) == 28
    assert merged["period"]["schedule_end"] == "2026-09-27"
    assert len(merged["source"]["pdfs"]) == 2
