from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Sequence
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
CLOCK_RE = re.compile(r"^\d{2}:\d{2}$")
TIME_RE = re.compile(r"^(?P<start>\d{2}:\d{2})-(?P<end>\d{2}:\d{2})$")
GROUP_PREFIX_RE_TEMPLATE = r"{group}\s*,?\s*0?(?P<subgroup>[12])\s+подгруппа\s+"
LESSON_TYPES = (
    "Практическое занятие",
    "Лабораторная работа",
    "Контрольная работа",
    "Самостоятельная работа",
    "Курсовое проектирование",
    "Консультация",
    "Экзамен",
    "Зачет",
    "Зачёт",
    "Лекция",
)
TEACHER_ROOM_RE = re.compile(
    r"^(?P<teacher>[А-ЯЁ][А-Яа-яЁё-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)\s+"
    r"(?P<room>\d{1,2}-[0-9А-Яа-яA-Za-z,_-]+|[^\s]+)$"
)
ROOM_RE = re.compile(
    r"^(?:\d{1,2}-[0-9А-Яа-яA-Za-z,_-]+|ДОТ|спортзал|актовый\s+зал)$",
    re.IGNORECASE,
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


def select_periods(
    periods: Iterable[PeriodLink],
    target: date,
    *,
    limit: int = 2,
) -> list[PeriodLink]:
    """Select the active period and the next published period, when available."""

    if limit < 1:
        raise ValueError("Количество периодов должно быть положительным")
    items = sorted(periods, key=lambda item: (item.schedule_start, item.end, item.url))
    primary = select_period(items, target)
    result = [primary]
    for item in items:
        if item.schedule_start <= primary.schedule_start:
            continue
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _clean_cell(value: str | None) -> str:
    if not value:
        return ""
    text = value.replace("\u00a0", " ").replace("\r", " ")
    text = re.sub(r"(?<=\d)-\s*\n\s*(?=\d)", "-", text)
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text.rstrip("_")


def _split_cell_entries(text: str, group: str) -> list[str]:
    prefix = re.escape(group) + r"\s*,?\s*0?[12]\s+подгруппа"
    starts = [match.start() for match in re.finditer(prefix, text)]
    if len(starts) <= 1:
        return [text]
    return [
        text[start : starts[index + 1] if index + 1 < len(starts) else None].strip()
        for index, start in enumerate(starts)
    ]


def _split_teacher_room(tail: str) -> tuple[str, str]:
    cleaned = tail.strip()
    match = TEACHER_ROOM_RE.match(cleaned)
    if match:
        teacher = re.sub(r"\s+", " ", match.group("teacher"))
        room = match.group("room").rstrip("_")
        return teacher, room

    parts = cleaned.rsplit(maxsplit=1)
    if len(parts) == 2 and ROOM_RE.fullmatch(parts[1]):
        return re.sub(r"\s+", " ", parts[0]), parts[1].rstrip("_")
    return "", ""


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
        tail = sport_match.group("tail").strip()
        teacher, room = _split_teacher_room(tail)
        lesson = {
            "subject": sport_match.group("subject"),
            "type": "Практическое занятие",
            "teacher": teacher,
            "room": room,
            "subgroup": subgroup,
            "stream_code": sport_match.group("stream").strip(),
            "raw": _clean_cell(raw),
        }
        if tail and not teacher and not room:
            lesson["details"] = tail
        return lesson

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
    lesson = {
        "subject": subject,
        "type": lesson_type,
        "teacher": teacher,
        "room": room,
        "subgroup": subgroup,
        "stream_code": None,
        "raw": _clean_cell(raw),
    }
    if tail and not teacher and not room:
        lesson["details"] = tail
    return lesson


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
    page_url: str = DEFAULT_SCHEDULE_PAGE,
) -> dict[str, Any]:
    generated_at = generated_at or datetime.now(timezone.utc)
    days = parse_pdf(pdf_bytes, period=period, group=group)
    return {
        "schema_version": 1,
        "group": group,
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "source": {
            "page_url": page_url,
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


def validate_schedule(schedule: dict[str, Any]) -> None:
    """Reject structurally incomplete data before it can replace the working JSON."""

    if schedule.get("schema_version") != 1:
        raise ValueError("Неподдерживаемая версия JSON расписания")
    if not schedule.get("group"):
        raise ValueError("В расписании отсутствует группа")
    days = schedule.get("days")
    if not isinstance(days, list) or not days:
        raise ValueError("В расписании отсутствуют дни")

    dates: list[date] = []
    lesson_count = 0
    typed_lessons = 0
    for day in days:
        try:
            current_date = date.fromisoformat(day["date"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("В расписании найдена некорректная дата") from error
        dates.append(current_date)
        if day.get("weekday") != WEEKDAYS_RU[current_date.weekday()]:
            raise ValueError(f"У дня {current_date} неверно указана неделя")
        lessons = day.get("lessons")
        if not isinstance(lessons, list):
            raise ValueError(f"У дня {current_date} отсутствует список занятий")
        for lesson in lessons:
            lesson_count += 1
            if lesson.get("type"):
                typed_lessons += 1
            if not str(lesson.get("subject", "")).strip():
                raise ValueError(f"У занятия {current_date} отсутствует название")
            if not CLOCK_RE.fullmatch(str(lesson.get("start", ""))):
                raise ValueError(f"У занятия {current_date} некорректное время начала")
            if not CLOCK_RE.fullmatch(str(lesson.get("end", ""))):
                raise ValueError(f"У занятия {current_date} некорректное время окончания")
            if lesson.get("start") >= lesson.get("end"):
                raise ValueError(f"У занятия {current_date} перепутано время")
            if lesson.get("subgroup") not in (None, 1, 2):
                raise ValueError(f"У занятия {current_date} некорректная подгруппа")
            if "подгруппа" in str(lesson.get("raw", "")).lower() and lesson.get("subgroup") is None:
                raise ValueError(f"Не удалось распознать подгруппу у занятия {current_date}")

    if dates != sorted(dates) or len(dates) != len(set(dates)):
        raise ValueError("Даты расписания повторяются или идут не по порядку")
    if lesson_count == 0:
        raise ValueError("В расписании нет ни одного занятия")
    if typed_lessons * 2 < lesson_count:
        raise ValueError("Не удалось распознать тип у большинства занятий")

    period = schedule.get("period", {})
    if period.get("schedule_start") != dates[0].isoformat():
        raise ValueError("Начало периода не совпадает с первым днём")
    if period.get("schedule_end") != dates[-1].isoformat():
        raise ValueError("Конец периода не совпадает с последним днём")


def merge_schedules(
    schedules: Sequence[dict[str, Any]],
    *,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    """Merge the active and next two-week PDFs into one backward-compatible JSON."""

    if not schedules:
        raise ValueError("Нечего объединять")
    for schedule in schedules:
        validate_schedule(schedule)

    group = schedules[0]["group"]
    if any(schedule["group"] != group for schedule in schedules):
        raise ValueError("Нельзя объединить расписания разных групп")

    by_date: dict[str, dict[str, Any]] = {}
    period_sources: list[dict[str, Any]] = []
    for schedule in schedules:
        source = schedule["source"]
        period = schedule["period"]
        period_sources.append(
            {
                "pdf_url": source["pdf_url"],
                "pdf_sha256": source["pdf_sha256"],
                **period,
            }
        )
        for day in schedule["days"]:
            by_date[day["date"]] = day

    days = [by_date[key] for key in sorted(by_date)]
    generated_at = generated_at or datetime.now(timezone.utc)
    first_source = schedules[0]["source"]
    result = {
        "schema_version": 1,
        "group": group,
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "checked_at": generated_at.astimezone(timezone.utc).isoformat(),
        "source": {
            "page_url": first_source["page_url"],
            "pdf_url": first_source["pdf_url"],
            "pdf_sha256": first_source["pdf_sha256"],
            "pdfs": period_sources,
        },
        "period": {
            "published_start": min(item["published_start"] for item in period_sources),
            "published_end": max(item["published_end"] for item in period_sources),
            "schedule_start": days[0]["date"],
            "schedule_end": days[-1]["date"],
        },
        "days": days,
    }
    validate_schedule(result)
    return result
