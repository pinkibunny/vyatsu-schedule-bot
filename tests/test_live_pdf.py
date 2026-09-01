from datetime import date
import httpx

from vyatsu_schedule import PeriodLink, parse_pdf


def test_current_pdf_layout() -> None:
    period = PeriodLink(
        "https://www.vyatsu.ru/reports/schedule/Group/26729_1_01092026_13092026.pdf",
        "26729",
        1,
        date(2026, 9, 1),
        date(2026, 9, 13),
    )
    response = httpx.get(period.url, follow_redirects=True, timeout=40)
    response.raise_for_status()
    pdf_bytes = response.content
    assert pdf_bytes.startswith(b"%PDF")
    days = parse_pdf(pdf_bytes, period=period)
    assert len(days) == 14
    assert days[1]["date"] == "2026-09-01"
    assert [lesson["subject"] for lesson in days[1]["lessons"]] == [
        "Специальные главы биохимии",
        "Специальные главы биохимии",
    ]
    thursday = days[3]["lessons"]
    assert any(lesson["subgroup"] == 1 for lesson in thursday)
    assert any(lesson["subgroup"] == 2 for lesson in thursday)
