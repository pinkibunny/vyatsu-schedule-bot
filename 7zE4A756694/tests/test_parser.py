from datetime import date

from vyatsu_schedule.parser import (
    DEFAULT_GROUP,
    PeriodLink,
    _parse_entry,
    discover_period_links,
    select_period,
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

