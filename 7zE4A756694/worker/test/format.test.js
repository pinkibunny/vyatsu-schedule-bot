import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addDays,
  formatDay,
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

test("day formatting includes real lesson data", () => {
  const day = schedule.days.find((item) => item.date === "2026-09-01");
  const text = formatDay(day, "all");
  assert.match(text, /Специальные главы биохимии/);
  assert.match(text, /Лундовских И\.А\./);
  assert.match(text, /1-242/);
});

test("subgroup filter excludes the other subgroup", () => {
  const day = schedule.days.find((item) => item.date === "2026-09-03");
  const text = formatDay(day, "1");
  assert.match(text, /Биотехнология/);
  assert.doesNotMatch(text, /Современные физико-химические методы/);
});

test("week output stays under Telegram message limit", () => {
  const chunks = formatRange(schedule, "2026-08-31", 7, "all");
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.length < 4096));
});

