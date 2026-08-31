from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable
from urllib.parse import urljoin

import pdfplumber
from bs4 import BeautifulSoup


DEFAULT_GROUP = "БТб-3101-03-00"
DEFAULT_SCHEDULE_PAGE = (
    "https://www.vyatsu.ru/studentu-1/spravochnaya-informatsiya/"
    "raspisanie-zanyatiy-dlya-studentov.html"
)

PERIOD_RE = re.compile(
    r"/reports/schedule/Group/"
    r"(?P<group_id>\d+)_(?P<semester>\d+)_"
    r"(?P<start>\d{8})_(?P<end>\d{8})\.pdf(?:\?.*)?$"
)
TIME_RE = re.compile(r"^(?P<start>\d{2}:\d{2})-(?P<end>\d{2}:\d{2})$")
GROUP_PREFIX_RE_TEMPLATE = r"{group},\s*0(?P<subgroup>[12])\s+подгруппа\s+"
LESSON_TYPES = ("Практическое занятие", "Лабораторная работа", "Лекция")
TEACHER_ROOM_RE = re.compile(
    r"^(?P<teacher>[А-ЯЁ][А-Яа-яЁё-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)\s+"
    r"(?P<room>\d{1,2}-\d{1,4}[А-Яа-яA-Za-z_]*|[^\s]+)$"
)
SPORT_RE = re.compile(
    r"^(?P<subject>Элективные дисциплины \(модули\) по физической культуре и спорту)\s+"
    r"Практическое занятие\s+\((?P<stream>[^)]+)\)\s+"
    r"Практическое занятие\s+(?P<tail>.+)$"
)

WEEKDAYS_RU = (
    "понедельник",
    "вторник",
    "среда",
    "четверг",
    "пятница",
    "суббота",
    "воскресенье",
)


@dataclass(frozen=True, slots=True)
class PeriodLink:
    url: str
    group_id: str
    semester: int
    start: date
    end: date

    @property
    def schedule_start(self) -> date:
        return self.start - timedelta(days=self.start.weekday())

    @property
    def schedule_end(self) -> date:
        return self.end


def _parse_ddmmyyyy(value: str) -> date:
    return datetime.strptime(value, "%d%m%Y").date()


def discover_period_links(
    html: str,
    *,
    group: str = DEFAULT_GROUP,
    base_url: str = DEFAULT_SCHEDULE_PAGE,
) -> list[PeriodLink]:
    """Find every official PDF period linked under one group entry."""

    soup = BeautifulSoup(html, "html.parser")
    group_node = next(
        (
            node
            for node in soup.select("div.grpPeriod")
            if " ".join(node.get_text(" ", strip=True).split()) == group
        ),
        None,
    )
    if group_node is None:
        raise ValueError(f"Группа {group!r} не найдена на странице ВятГУ")

    period_box = group_node.find_next_sibling("div", class_="listPeriod")
    if period_box is None:
        raise ValueError(f"У группы {group!r} отсутствует блок периодов")

    result: list[PeriodLink] = []
    seen: set[str] = set()
    for anchor in period_box.find_all("a", href=True):
        url = urljoin(base_url, anchor["href"])
        match = PERIOD_RE.search(url)
        if not match or url in seen:
            continue
        seen.add(url)
        result.append(
            PeriodLink(
                url=url,
                group_id=match.group("group_id"),
                semester=int(match.group("semester")),
                start=_parse_ddmmyyyy(match.group("start")),
                end=_parse_ddmmyyyy(match.group("end")),
            )
        )

    if not result:
        raise ValueError(f"Для группы {group!r} не найдено ни одной ссылки на PDF")
    return sorted(result, key=lambda item: (item.start, item.end, item.url))


def select_period(periods: Iterable[PeriodLink], target: date) -> PeriodLink:
    """Select the period containing target, then nearest future, then latest past."""

    items = sorted(periods, key=lambda item: (item.schedule_start, item.end))
    if not items:
        raise ValueError("Список периодов пуст")

    containing = [item for item in items if item.schedule_start <= target <= item.end]
    if containing:
        return containing[-1]

    future = [item for item in items if item.schedule_start > target]
    if future:
        return future[0]
    return items[-1]


def _clean_cell(value: str | None) -> str:
    if not value:
        return ""
    text = value.replace("\u00a0", " ").replace("\r", " ")
    text = re.sub(r"(?<=\d)-\s*\n\s*(?=\d)", "-", text)
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text.rstrip("_")


def _split_cell_entries(text: str, group: str) -> list[str]:
    prefix = re.escape(group) + r",\s*0[12]\s+подгруппа"
    starts = [match.start() for match in re.finditer(prefix, text)]
    if len(starts) <= 1:
        return [text]
    return [
        text[start : starts[index + 1] if index + 1 < len(starts) else None].strip()
        for index, start in enumerate(starts)
    ]


def _split_teacher_room(tail: str) -> tuple[str, str]:
    match = TEACHER_ROOM_RE.match(tail.strip())
    if not match:
        return "", ""
    teacher = re.sub(r"\s+", " ", match.group("teacher"))
    room = match.group("room").rstrip("_")
    return teacher, room


def _parse_entry(raw: str, *, group: str) -> dict[str, Any]:
    text = _clean_cell(raw)
    subgroup: int | None = None
    prefix_re = re.compile(GROUP_PREFIX_RE_TEMPLATE.format(group=re.escape(group)))
    prefix_match = prefix_re.match(text)
    if prefix_match:
        subgroup = int(prefix_match.group("subgroup"))
        text = text[prefix_match.end() :].strip()

    sport_match = SPORT_RE.match(text)
    if sport_match:
        teacher, room = _split_teacher_room(sport_match.group("tail"))
        return {
            "subject": sport_match.group("subject"),
            "type": "Практическое занятие",
            "teacher": teacher,
            "room": room,
            "subgroup": subgroup,
            "stream_code": sport_match.group("stream").strip(),
            "raw": _clean_cell(raw),
        }

    type_match: tuple[int, str] | None = None
    for lesson_type in LESSON_TYPES:
        index = text.find(lesson_type)
        if index >= 0 and (type_match is None or index < type_match[0]):
            type_match = (index, lesson_type)

    if type_match is None:
        return {
            "subject": text,
            "type": "",
            "teacher": "",
            "room": "",
            "subgroup": subgroup,
            "stream_code": None,
            "raw": _clean_cell(raw),
        }

    index, lesson_type = type_match
    subject = text[:index].strip()
    tail = text[index + len(lesson_type) :].strip()
    teacher, room = _split_teacher_room(tail)
    return {
        "subject": subject,
        "type": lesson_type,
        "teacher": teacher,
        "room": room,
        "subgroup": subgroup,
        "stream_code": None,
        "raw": _clean_cell(raw),
    }


def parse_pdf(
    pdf_bytes: bytes,
    *,
    period: PeriodLink,
    group: str = DEFAULT_GROUP,
) -> list[dict[str, Any]]:
    """Parse Excel-exported VyatSU PDF tables into fourteen normalized days."""

    total_days = (period.schedule_end - period.schedule_start).days + 1
    if total_days <= 0:
        raise ValueError("Некорректный диапазон дат в ссылке расписания")

    days = [
        {
            "date": (period.schedule_start + timedelta(days=offset)).isoformat(),
            "weekday": WEEKDAYS_RU[(period.schedule_start + timedelta(days=offset)).weekday()],
            "lessons": [],
        }
        for offset in range(total_days)
    ]

    day_index = -1
    current_time: tuple[str, str] | None = None
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            table = page.extract_table()
            if not table:
                continue
            for row in table:
                if len(row) < 3:
                    continue
                day_cell, time_cell, content_cell = row[0], row[1], row[2]
                if _clean_cell(day_cell) == "День":
                    continue

                if day_cell:
                    day_index += 1
                    current_time = None
                    if day_index >= len(days):
                        raise ValueError(
                            "В PDF найдено больше дневных блоков, чем следует из периода"
                        )

                time_text = _clean_cell(time_cell)
                time_match = TIME_RE.match(time_text)
                if time_match:
                    current_time = (time_match.group("start"), time_match.group("end"))

                content = _clean_cell(content_cell)
                if not content:
                    continue
                if day_index < 0 or current_time is None:
                    raise ValueError("Занятие найдено вне дневного или временного блока")

                for entry in _split_cell_entries(content, group):
                    lesson = _parse_entry(entry, group=group)
                    lesson["start"] = current_time[0]
                    lesson["end"] = current_time[1]
                    days[day_index]["lessons"].append(lesson)

    if day_index + 1 != len(days):
        raise ValueError(
            f"Ожидалось {len(days)} дневных блоков, найдено {day_index + 1}"
        )
    if not any(day["lessons"] for day in days):
        raise ValueError("В PDF не найдено ни одного занятия")
    return days


def build_schedule(
    *,
    pdf_bytes: bytes,
    period: PeriodLink,
    group: str = DEFAULT_GROUP,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    generated_at = generated_at or datetime.now(timezone.utc)
    days = parse_pdf(pdf_bytes, period=period, group=group)
    return {
        "schema_version": 1,
        "group": group,
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "source": {
            "page_url": DEFAULT_SCHEDULE_PAGE,
            "pdf_url": period.url,
            "pdf_sha256": hashlib.sha256(pdf_bytes).hexdigest(),
        },
        "period": {
            "published_start": period.start.isoformat(),
            "published_end": period.end.isoformat(),
            "schedule_start": period.schedule_start.isoformat(),
            "schedule_end": period.schedule_end.isoformat(),
        },
        "days": days,
    }

