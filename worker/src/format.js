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

function filterLessons(lessons, subgroup) {
  if (subgroup === "all") return lessons;
  const selected = Number(subgroup);
  return lessons.filter(
    (lesson) => lesson.subgroup === null || lesson.subgroup === selected,
  );
}

function lessonLines(lesson) {
  const subject = escapeHtml(lesson.subject);
  const type = SHORT_TYPES.get(lesson.type) || lesson.type;
  const labels = [];
  if (type) labels.push(escapeHtml(type));
  if (lesson.subgroup !== null) labels.push(`${lesson.subgroup} подгруппа`);
  if (lesson.stream_code) labels.push(`секция ${escapeHtml(lesson.stream_code)}`);

  const place = [lesson.teacher, lesson.room].filter(Boolean).map(escapeHtml).join(" · ");
  const result = [`<b>${lesson.start}–${lesson.end}</b>  ${subject}`];
  if (labels.length) result.push(`<i>${labels.join(" · ")}</i>`);
  if (place) result.push(place);
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

export function formatRange(schedule, startIso, count, subgroup = "all") {
  const byDate = new Map(schedule.days.map((day) => [day.date, day]));
  const blocks = [];
  for (let offset = 0; offset < count; offset += 1) {
    const isoDate = addDays(startIso, offset);
    const day = byDate.get(isoDate);
    if (!day) continue;
    const lessons = filterLessons(day.lessons, subgroup);
    if (!lessons.length) continue;
    blocks.push(formatDay(day, subgroup));
  }
  if (!blocks.length) {
    return ["На выбранной неделе занятий нет или расписание ещё не опубликовано."];
  }
  return chunkBlocks(blocks);
}

export function chunkBlocks(blocks, maxLength = 3600) {
  const chunks = [];
  let current = "";
  for (const block of blocks) {
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

export function subgroupLabel(subgroup) {
  if (subgroup === "1") return "1 подгруппа";
  if (subgroup === "2") return "2 подгруппа";
  return "обе подгруппы";
}

