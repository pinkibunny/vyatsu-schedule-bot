from datetime import date
from pathlib import Path

import pytest

from vyatsu_schedule import PeriodLink, parse_pdf


@pytest.mark.skipif(
    not Path("../tmp/pdfs/vyatsu_schedule.pdf").exists(),
    reason="локальный PDF для интеграционного теста отсутствует",
)
def test_current_pdf_layout() -> None:
    pdf_bytes = Path("../tmp/pdfs/vyatsu_schedule.pdf").read_bytes()
    period = PeriodLink(
        "https://www.vyatsu.ru/reports/schedule/Group/26729_1_01092026_13092026.pdf",
        "26729",
        1,
        date(2026, 9, 1),
        date(2026, 9, 13),
    )
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

