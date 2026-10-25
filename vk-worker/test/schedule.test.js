import assert from "node:assert/strict";
import test from "node:test";
import { addDays } from "../../worker/src/format.js";
import {
  buildReplies, handleRequest, messageAction, plainText, replyRandomId,
} from "../src/index.js";

const env = {
  VK_GROUP_ID: "242581427",
  VK_TOKEN: "test-token",
  VK_CALLBACK_SECRET: "test-secret",
  VK_CONFIRMATION_CODE: "test-confirmation",
  SCHEDULE_URL: "https://example.test/schedule.json",
};
const weekday = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const shared = { subject: "Общая лекция", type: "Лекция", teacher: "Иванов И.И.", room: "1-101", start: "10:00", end: "11:30", subgroup: null };
const schedule = {
  schema_version: 1,
  group: "БТб-3101-03-00",
  generated_at: "2026-10-25T12:00:00Z",
  checked_at: "2026-10-25T12:00:00Z",
  source: { pdfs: [{}, {}] },
  period: { schedule_start: "2026-10-12", schedule_end: "2026-11-08" },
  days: Array.from({ length: 28 }, (_, index) => {
    const date = addDays("2026-10-12", index);
    return {
      date,
      weekday: weekday[new Date(`${date}T12:00:00Z`).getUTCDay()],
      lessons: [
        shared,
        { ...shared, subject: "Лабораторная для первой", subgroup: 1, start: "14:00", end: "15:30" },
        { ...shared, subject: "Лабораторная для второй", subgroup: 2, start: "14:00", end: "15:30" },
      ],
    };
  }),
};

const now = new Date("2026-10-25T21:30:00Z"); // Monday 26 October in Moscow.
function options(data = schedule) {
  return {
    now, cache: null, logInfo: () => {},
    fetchImpl: async (url) => {
      assert.equal(url, env.SCHEDULE_URL);
      return Response.json(data);
    },
  };
}
function message(action) {
  return { payload: JSON.stringify({ action }) };
}
function actions(reply) {
  return reply.keyboard.buttons.flat().filter((button) => button.action.payload)
    .map((button) => JSON.parse(button.action.payload).action);
}

test("start and subgroup menu do not need the schedule service", async () => {
  const unavailable = { fetchImpl: () => assert.fail("menu must not load data") };
  const start = await buildReplies(env, { text: "Начать" }, unavailable);
  assert.deepEqual(actions(start[0]), ["set:1", "set:2", "set:all"]);
  const menu = await buildReplies(env, message("set:2"), unavailable);
  assert.match(menu[0].text, /2 подгруппа/);
  assert.ok(actions(menu[0]).includes("show:aftertomorrow:2"));
});

test("typed commands ask for subgroup and carry the chosen date", async () => {
  assert.equal(messageAction({ text: "неделя" }), "pick:week");
  assert.equal(messageAction({ text: "26.10.2026" }), "pick:2026-10-26");
  const replies = await buildReplies(env, { text: "26.10.2026" });
  assert.ok(actions(replies[0]).includes("show:2026-10-26:1"));
});

test("day and subgroup filters use Moscow dates and one heading per time", async () => {
  const replies = await buildReplies(env, message("show:today:1"), options());
  assert.match(replies[0].text, /Понедельник, 26 октября/);
  assert.match(replies[0].text, /Общая лекция/);
  assert.match(replies[0].text, /Лабораторная для первой/);
  assert.doesNotMatch(replies[0].text, /Лабораторная для второй|<b>|<i>/);
  const combined = await buildReplies(env, message("show:today:all"), options());
  assert.equal((combined[0].text.match(/14:00–15:30/g) || []).length, 1);
  assert.match(combined[0].text, /Лабораторная для второй/);
});

test("tomorrow and aftertomorrow cross month boundaries", async () => {
  const opts = { ...options(), now: new Date("2026-10-31T09:00:00Z") };
  const tomorrow = await buildReplies(env, message("show:tomorrow:all"), opts);
  const after = await buildReplies(env, message("show:aftertomorrow:all"), opts);
  assert.match(tomorrow[0].text, /Воскресенье, 1 ноября/);
  assert.match(after[0].text, /Понедельник, 2 ноября/);
});

test("week messages fit VK length and retain subgroup in the final menu", async () => {
  const replies = await buildReplies(env, message("show:nextweek:2"), options());
  const all = replies.map((reply) => reply.text).join("\n");
  assert.match(all, /Понедельник, 2 ноября/);
  assert.match(all, /Воскресенье, 8 ноября/);
  assert.doesNotMatch(all, /Лабораторная для первой/);
  assert.ok(replies.every((reply) => reply.text.length <= 3600));
  assert.ok(actions(replies.at(-1)).includes("show:today:2"));
});

test("calendar exposes only published dates and keeps subgroup across pages", async () => {
  const [reply] = await buildReplies(env, message("calendar:2"), options());
  const callbackActions = actions(reply);
  assert.ok(callbackActions.includes("date:2026-10-26:2"));
  assert.ok(callbackActions.includes("calendar:2026-11-02:2"));
  assert.ok(callbackActions.includes("set:2"));
  assert.ok(reply.keyboard.buttons.length <= 10);
  const [last] = await buildReplies(env, message("calendar:2026-11-02:2"), options());
  assert.ok(!actions(last).some((action) => action.includes("2026-11-09")));
  const [selected] = await buildReplies(env, message("date:2026-11-03:2"), options());
  assert.match(selected.text, /Вторник, 3 ноября/);
});

test("no lessons and unpublished dates remain distinct", async () => {
  const data = structuredClone(schedule);
  data.days.find((day) => day.date === "2026-10-26").lessons = [];
  const [empty] = await buildReplies(env, message("show:today:all"), options(data));
  assert.match(empty.text, /Занятий нет/);
  const [missing] = await buildReplies(env, message("date:2026-11-09:all"), options(data));
  assert.match(missing.text, /ещё не опубликовано/);
});

test("invalid dates and payloads never reach the schedule service", async () => {
  const opts = { fetchImpl: () => assert.fail("invalid action must not load data") };
  for (const input of [
    message("show:2026-02-31:all"), message("show:today:99"),
    message("date:2026-13-01:1"), { payload: "{broken" }, { payload: "null" },
  ]) {
    const replies = await buildReplies(env, input, opts);
    assert.match(replies[0].text, /Жми кнопки/);
  }
});

test("data status uses the same source coverage as Telegram", async () => {
  const [reply] = await buildReplies(env, message("status:1"), options());
  assert.match(reply.text, /12 октября — 8 ноября/);
  assert.match(reply.text, /Загружено двухнедель: 2/);
  assert.match(reply.text, /каждый час/);
  assert.doesNotMatch(reply.text, /<b>/);
});

test("schedule failure falls back to stored data and marks it clearly", async () => {
  let stored;
  const cache = {
    put: async (_request, response) => { stored = response; },
    match: async () => stored?.clone(),
  };
  await buildReplies(env, message("show:today:all"), { ...options(), cache });
  const [reply] = await buildReplies(env, message("show:today:all"), {
    ...options(), cache, fetchImpl: async () => { throw new Error("unavailable"); },
  });
  assert.match(reply.text, /Общая лекция/);
  assert.match(reply.text, /последняя сохранённая копия/);
});

test("unavailable schedule without backup gives an actionable reply", async () => {
  const [reply] = await buildReplies(env, message("show:today:1"), {
    ...options(), fetchImpl: async () => new Response("Unavailable", { status: 503 }),
  });
  assert.match(reply.text, /Попробуй ещё раз/);
  assert.ok(actions(reply).includes("show:today:1"));
});

test("feedback uses existing anonymous Telegram flow and does not promise VK anonymity", async () => {
  const [reply] = await buildReplies(env, message("feedback:2"));
  assert.match(reply.text, /администраторы сообщества видят отправителя/);
  assert.equal(reply.keyboard.buttons[0][0].action.link, "https://t.me/ScheduleBTBbot");
  assert.ok(actions(reply).includes("set:2"));
});

test("formatting decodes escaped subjects once without dropping literal HTML-like text", () => {
  assert.equal(plainText("<b>&lt;b&gt; &amp;lt; &amp; &gt;</b>"), "<b> &lt; & >");
});

test("long week delivery uses distinct stable IDs for each chunk", async () => {
  const data = structuredClone(schedule);
  for (const day of data.days) day.lessons[0].subject = "Очень длинное занятие ".repeat(50);
  const update = {
    group_id: 242581427, secret: "test-secret", type: "message_new", event_id: "long-week",
    object: { message: { id: 20, conversation_message_id: 10, from_id: 123, peer_id: 123, out: 0, ...message("show:week:all") } },
  };
  const sent = [];
  const opts = {
    ...options(data),
    fetchImpl: async (url, init) => {
      if (url === env.SCHEDULE_URL) return Response.json(data);
      sent.push(init.body);
      return Response.json({ response: sent.length });
    },
  };
  const request = new Request("https://example.test/vk", { method: "POST", body: JSON.stringify(update) });
  const response = await handleRequest(request, env, opts);
  assert.equal(await response.text(), "ok");
  assert.ok(sent.length > 1);
  assert.equal(new Set(sent.map((body) => body.get("random_id"))).size, sent.length);
  assert.equal(sent[1].get("random_id"), String(replyRandomId(update, 1)));
  assert.ok(sent.every((body) => body.get("message").length <= 3600));
  assert.ok(sent.at(-1).get("keyboard"));
});
