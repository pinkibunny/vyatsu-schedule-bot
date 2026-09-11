import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addDays,
  chunkBlocks,
  collapseIdenticalSubgroups,
  formatDataStatus,
  formatDay,
  formatMissingDate,
  formatRange,
  mondayOf,
} from "../src/format.js";

const schedule = JSON.parse(
  await readFile(new URL("../../data/schedule.json", import.meta.url), "utf8"),
);

test("date helpers cross month boundaries", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(mondayOf("2026-09-03"), "2026-08-31");
});

test("day formatting includes lesson details", () => {
  const day = {
    date: "2026-09-01",
    weekday: "вторник",
    lessons: [{
      subject: "Специальные главы биохимии",
      type: "Лекция",
      teacher: "Лундовских И.А.",
      room: "1-242",
      subgroup: null,
      start: "14:00",
      end: "15:30",
    }],
  };
  const text = formatDay(day, "all");
  assert.match(text, /Специальные главы биохимии/);
  assert.match(text, /Лундовских И\.А\./);
  assert.match(text, /1-242/);
});

test("subgroup filter excludes the other subgroup", () => {
  const day = {
    date: "2026-09-03",
    weekday: "четверг",
    lessons: [
      { subject: "Биотехнология", type: "Лабораторная работа", subgroup: 1, start: "10:00", end: "11:30" },
      { subject: "Современные физико-химические методы", type: "Лабораторная работа", subgroup: 2, start: "10:00", end: "11:30" },
    ],
  };
  const text = formatDay(day, "1");
  assert.match(text, /Биотехнология/);
  assert.doesNotMatch(text, /Современные физико-химические методы/);
});

test("week output stays under Telegram message limit", () => {
  const firstPublishedDate = schedule.days.map((day) => day.date).sort()[0];
  const chunks = formatRange(schedule, firstPublishedDate, 7, "all");
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.length < 4096));
});

test("identical subgroup lessons are merged only for combined view", () => {
  const sharedLesson = {
    subject: "Биотехнология",
    type: "Лабораторная работа",
    teacher: "Преподаватель",
    room: "1-101",
    start: "14:00",
    end: "15:30",
  };
  const day = {
    date: "2026-09-04",
    weekday: "пятница",
    lessons: [
      { ...sharedLesson, subgroup: 1 },
      { ...sharedLesson, subgroup: 2 },
    ],
  };
  const combined = formatDay(day, "all");
  assert.match(combined, /обе подгруппы/);
  assert.equal((combined.match(/14:00–15:30/g) || []).length, 1);

  const first = formatDay(day, "1");
  assert.doesNotMatch(first, /обе подгруппы/);
  assert.match(first, /1 подгруппа/);
});

test("lessons at the same time share one time heading", () => {
  const text = formatDay({
    date: "2026-09-04",
    weekday: "пятница",
    lessons: [
      { subject: "Биотехнология", type: "Лабораторная работа", subgroup: 1, start: "14:00", end: "15:30" },
      { subject: "Физико-химические методы", type: "Лабораторная работа", subgroup: 2, start: "14:00", end: "15:30" },
    ],
  }, "all");
  assert.equal((text.match(/14:00–15:30/g) || []).length, 1);
  assert.match(text, /Биотехнология/);
  assert.match(text, /Физико-химические методы/);
});

test("lessons unique to one subgroup are not collapsed", () => {
  const lessons = [
    { subject: "A", subgroup: 1, start: "10:00", end: "11:30" },
    { subject: "B", subgroup: 2, start: "10:00", end: "11:30" },
  ];
  assert.deepEqual(collapseIdenticalSubgroups(lessons), lessons);
});

test("missing dates are distinguished from days without lessons", () => {
  const lastPublishedDate = schedule.days.map((day) => day.date).sort().at(-1);
  const firstUnpublishedDate = addDays(lastPublishedDate, 1);
  assert.match(formatMissingDate(schedule, firstUnpublishedDate), /ещё не опубликовано/);
  assert.match(formatRange(schedule, firstUnpublishedDate, 7, "all")[0], /ещё не опубликовано/);
});

test("long week output is split below the configured limit", () => {
  const paragraph = "Занятие ".repeat(150);
  const chunks = chunkBlocks([`${paragraph}\n\n${paragraph}\n\n${paragraph}`], 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
});

test("data status shows actual coverage and update cadence", () => {
  const dates = schedule.days.map((day) => day.date).sort();
  const formatDate = (isoDate) => new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(new Date(`${isoDate}T12:00:00Z`));
  const text = formatDataStatus(schedule, dates[0]);
  const expectedPeriod = `Период: ${formatDate(dates[0])} — ${formatDate(dates.at(-1))}`;
  const expectedSourceCount = schedule.source?.pdfs?.length || 1;
  assert.ok(text.includes(expectedPeriod));
  assert.ok(text.includes(`Загружено двухнедель: ${expectedSourceCount}`));
  assert.match(text, /каждый час/);
});
