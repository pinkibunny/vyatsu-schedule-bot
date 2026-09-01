const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const SHORT_TYPES = new Map([
  ["Лекция", "лекция"],
  ["Практическое занятие", "практика"],
  ["Лабораторная работа", "лабораторная"],
  ["Контрольная работа", "контрольная"],
  ["Самостоятельная работа", "самостоятельная работа"],
  ["Курсовое проектирование", "курсовое проектирование"],
  ["Консультация", "консультация"],
  ["Экзамен", "экзамен"],
  ["Зачет", "зачёт"],
  ["Зачёт", "зачёт"],
]);

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function moscowIsoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(isoDate, amount) {
  const current = new Date(`${isoDate}T12:00:00Z`);
  current.setUTCDate(current.getUTCDate() + amount);
  return current.toISOString().slice(0, 10);
}

export function mondayOf(isoDate) {
  const current = new Date(`${isoDate}T12:00:00Z`);
  const weekday = current.getUTCDay() || 7;
  return addDays(isoDate, 1 - weekday);
}

function dateTitle(day) {
  const value = new Date(`${day.date}T12:00:00Z`);
  const dayNumber = value.getUTCDate();
  const month = MONTHS_RU[value.getUTCMonth()];
  const weekday = day.weekday[0].toUpperCase() + day.weekday.slice(1);
  return `<b>${escapeHtml(weekday)}, ${dayNumber} ${month}</b>`;
}

function shortText(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function sameLesson(left, right) {
  return ["start", "end", "subject", "type", "teacher", "room", "stream_code", "details"]
    .every((key) => (left[key] || null) === (right[key] || null));
}

export function collapseIdenticalSubgroups(lessons) {
  const result = [];
  const used = new Set();
  for (let index = 0; index < lessons.length; index += 1) {
    if (used.has(index)) continue;
    const lesson = lessons[index];
    if (lesson.subgroup !== 1 && lesson.subgroup !== 2) {
      result.push(lesson);
      continue;
    }
    const pairIndex = lessons.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        !used.has(candidateIndex) &&
        candidate.subgroup !== lesson.subgroup &&
        (candidate.subgroup === 1 || candidate.subgroup === 2) &&
        sameLesson(lesson, candidate),
    );
    if (pairIndex >= 0) {
      used.add(pairIndex);
      result.push({ ...lesson, subgroup: "all" });
    } else {
      result.push(lesson);
    }
  }
  return result;
}

function filterLessons(lessons, subgroup) {
  if (subgroup === "all") return collapseIdenticalSubgroups(lessons);
  const selected = Number(subgroup);
  return lessons.filter(
    (lesson) => lesson.subgroup === null || lesson.subgroup === selected,
  );
}

function lessonLines(lesson) {
  const subject = escapeHtml(shortText(lesson.subject, 900));
  const type = SHORT_TYPES.get(lesson.type) || lesson.type;
  const labels = [];
  if (type) labels.push(escapeHtml(type));
  if (lesson.subgroup === "all") labels.push("обе подгруппы");
  else if (lesson.subgroup !== null) labels.push(`${lesson.subgroup} подгруппа`);
  if (lesson.stream_code) {
    labels.push(`секция ${escapeHtml(shortText(lesson.stream_code, 100))}`);
  }

  const place = [
    shortText(lesson.teacher, 300),
    shortText(lesson.room, 150),
  ].filter(Boolean).map(escapeHtml).join(" · ");
  const result = [`<b>${lesson.start}–${lesson.end}</b>  ${subject}`];
  if (labels.length) result.push(`<i>${labels.join(" · ")}</i>`);
  if (place) result.push(place);
  else if (lesson.details) result.push(escapeHtml(shortText(lesson.details, 600)));
  return result.join("\n");
}

export function formatDay(day, subgroup = "all") {
  if (!day) {
    return "Расписания на эту дату в опубликованной двухнедельке пока нет.";
  }
  const lessons = filterLessons(day.lessons, subgroup);
  if (!lessons.length) return `${dateTitle(day)}\n\nЗанятий нет 🎉`;
  return `${dateTitle(day)}\n\n${lessons.map(lessonLines).join("\n\n")}`;
}

function plainDate(isoDate) {
  const value = new Date(`${isoDate}T12:00:00Z`);
  return `${value.getUTCDate()} ${MONTHS_RU[value.getUTCMonth()]}`;
}

function coverage(schedule) {
  const dates = schedule.days.map((day) => day.date).sort();
  return { start: dates[0], end: dates.at(-1) };
}

export function formatMissingDate(schedule, isoDate) {
  const { start, end } = coverage(schedule);
  if (isoDate > end) {
    return `Расписание на ${plainDate(isoDate)} ещё не опубликовано. Сейчас есть данные по ${plainDate(end)} включительно.`;
  }
  if (isoDate < start) {
    return `Дата ${plainDate(isoDate)} уже вне загруженного расписания. Данные начинаются с ${plainDate(start)}.`;
  }
  return `Расписание на ${plainDate(isoDate)} временно отсутствует в опубликованном периоде.`;
}

export function formatRange(schedule, startIso, count, subgroup = "all") {
  const byDate = new Map(schedule.days.map((day) => [day.date, day]));
  const blocks = [];
  let knownDays = 0;
  let missingDays = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const isoDate = addDays(startIso, offset);
    const day = byDate.get(isoDate);
    if (!day) {
      missingDays += 1;
      continue;
    }
    knownDays += 1;
    const lessons = filterLessons(day.lessons, subgroup);
    if (!lessons.length) continue;
    blocks.push(formatDay(day, subgroup));
  }
  if (!blocks.length) {
    if (knownDays === count) return ["На выбранной неделе занятий нет 🎉"];
    const lastDate = addDays(startIso, count - 1);
    if (knownDays === 0) return [formatMissingDate(schedule, lastDate)];
    return ["На опубликованной части недели занятий нет. Остальные дни ещё не загружены ВятГУ."];
  }
  if (missingDays) {
    const { end } = coverage(schedule);
    blocks.push(`<i>⚠️ Расписание опубликовано только по ${plainDate(end)} включительно.</i>`);
  }
  return chunkBlocks(blocks);
}

export function chunkBlocks(blocks, maxLength = 3600) {
  const normalizedBlocks = [];
  for (const block of blocks) {
    if (block.length <= maxLength) {
      normalizedBlocks.push(block);
      continue;
    }
    let part = "";
    const paragraphs = block.split("\n\n").flatMap((paragraph) => {
      if (paragraph.length <= maxLength) return [paragraph];
      const pieces = [];
      for (let offset = 0; offset < paragraph.length; offset += maxLength) {
        pieces.push(paragraph.slice(offset, offset + maxLength));
      }
      return pieces;
    });
    for (const paragraph of paragraphs) {
      const candidate = part ? `${part}\n\n${paragraph}` : paragraph;
      if (candidate.length <= maxLength) {
        part = candidate;
      } else {
        if (part) normalizedBlocks.push(part);
        part = paragraph;
      }
    }
    if (part) normalizedBlocks.push(part);
  }

  const chunks = [];
  let current = "";
  for (const block of normalizedBlocks) {
    const candidate = current ? `${current}\n\n──────────\n\n${block}` : block;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = block;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function formatDataStatus(schedule, today = moscowIsoDate()) {
  const { start, end } = coverage(schedule);
  const sourceCount = schedule.source?.pdfs?.length || 1;
  const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const generated = dateTimeFormatter.format(new Date(schedule.generated_at));
  const checkedDate = new Date(schedule.checked_at || schedule.generated_at);
  const checked = dateTimeFormatter.format(checkedDate);
  const nextWeekEnd = addDays(mondayOf(today), 13);
  const states = [end >= nextWeekEnd
    ? "✅ Текущая и следующая недели загружены."
    : `⚠️ Пока опубликованы данные только по ${plainDate(end)}.`];
  if (Date.now() - checkedDate.getTime() > 30 * 60 * 60 * 1000) {
    states.push("⚠️ Автоматическая проверка давно не подтверждалась.");
  }
  if (schedule._from_backup) {
    states.push("⚠️ Сейчас используется резервная копия: источник временно недоступен.");
  }
  return [
    "<b>Состояние расписания</b>",
    "",
    `Период: ${plainDate(start)} — ${plainDate(end)}`,
    `Загружено двухнедель: ${sourceCount}`,
    `Последнее изменение данных: ${generated}`,
    `Последняя успешная проверка: ${checked}`,
    "Проверка сайта ВятГУ выполняется каждый час.",
    "",
    ...states,
  ].join("\n");
}

export function subgroupLabel(subgroup) {
  if (subgroup === "1") return "1 подгруппа";
  if (subgroup === "2") return "2 подгруппа";
  return "обе подгруппы";
}
