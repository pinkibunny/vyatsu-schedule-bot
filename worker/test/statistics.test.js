import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.js";
import {
  formatStatistics, formatStatisticsUsers, isStatisticsAdmin, readStatistics,
  readStatisticsUsers, recordStatistics, statisticsAction, statisticsEvent,
  statisticsUsersKeyboard,
} from "../src/statistics.js";

// Execute production SQL against SQLite, rather than mocking its query results.
function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = {
    failWrite: false,
    prepare(sql) {
      function statement(values = []) {
        return {
          bind: (...args) => statement(args),
          all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
          first: async () => sqlite.prepare(sql).get(...values) || null,
          execute: () => sqlite.prepare(sql).all(...values),
          sql,
        };
      }
      return statement();
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement, index) => {
          if (db.failWrite && index === 1 && statement.sql.startsWith("INSERT")) {
            db.failWrite = false;
            throw new Error("Simulated D1 failure");
          }
          return { results: statement.execute(), success: true };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    sqlite,
  };
  return db;
}

const baseEnv = {
  ADMIN_CHAT_ID: "999",
  BOT_TOKEN: "token",
  WEBHOOK_SECRET: "secret",
  SCHEDULE_URL: "https://example.test/schedule.json",
};
const today = new Date("2026-10-26T10:00:00Z");
function update(id = 1, userId = 123, data = null) {
  const from = { id: userId, is_bot: false, first_name: "Анна", last_name: "Иванова", username: "anna" };
  const message = { message_id: id, chat: { id: userId, type: "private" }, from, text: "/start" };
  return data === null
    ? { update_id: id, message }
    : { update_id: id, callback_query: { id: `callback-${id}`, from, data, message } };
}
const quiet = { logError: () => {} };

test("actor extraction counts Moscow days and distinguishes requests from navigation", () => {
  const midnight = new Date("2026-10-25T21:05:00Z");
  assert.equal(statisticsEvent(update(), midnight).day, "2026-10-26");
  for (const data of ["show:today:all", "show:nextweek:1", "date:2026-11-03:2"]) {
    assert.equal(statisticsEvent(update(1, 123, data), midnight).is_schedule, 1);
  }
  for (const data of ["set:1", "calendar:all", "status:all", "show:wrong:1", "date:2026-02-31:1"]) {
    assert.equal(statisticsEvent(update(1, 123, data), midnight).is_schedule, 0);
  }
  assert.equal(statisticsEvent(update(), midnight).is_schedule, 0); // /start
  assert.deepEqual(Object.keys(statisticsEvent(update(), midnight)).sort(), [
    "update_id", "user_id", "first_name", "last_name", "username", "day", "occurred_at", "is_schedule",
  ].sort());
});

test("group traffic, service updates, mismatched actors and anonymous feedback are excluded", () => {
  const group = update(); group.message.chat.type = "group";
  const mismatched = update(); mismatched.message.from.id = 456;
  const bot = update(); bot.message.from.is_bot = true;
  const reply = update(); reply.message.reply_to_message = {
    from: { is_bot: true }, text: "Администратор получит только текст — без имени",
  };
  const stats = update(); stats.message.text = "/stats";
  for (const event of [group, mismatched, bot, reply, stats, {},
    update(1, 123, "feedback:all"), update(1, 123, "stats:users:0")]) {
    assert.equal(statisticsEvent(event), null);
  }
});

test("admin permissions require the configured owner in their own private chat", () => {
  const owner = { id: 999 };
  assert.ok(isStatisticsAdmin(baseEnv, owner, { id: 999, type: "private" }));
  assert.ok(!isStatisticsAdmin(baseEnv, { id: 123 }, { id: 999, type: "private" }));
  assert.ok(!isStatisticsAdmin(baseEnv, owner, { id: -1, type: "group" }));
  assert.ok(!isStatisticsAdmin({ ADMIN_CHAT_ID: "-999" }, owner, { id: 999, type: "private" }));
  assert.ok(!isStatisticsAdmin({}, owner, { id: 999, type: "private" }));
  assert.ok(!isStatisticsAdmin({ ...baseEnv, STATS_ADMIN_ID: "123" }, owner, { id: 999, type: "private" }));
  assert.deepEqual(statisticsAction({ message: { text: "/users 2" } }), { kind: "users", page: 1 });
  assert.deepEqual(statisticsAction({ message: { text: "/STATS@ScheduleBTBbot" } }), { kind: "summary" });
});

test("duplicate events are counted once and do not move last activity or undo newer profiles", async (t) => {
  const env = { ...baseEnv, STATS_DB: database(t) };
  const first = update(1);
  await recordStatistics(env, first, { now: new Date("2026-10-24T10:00:00Z") });
  const renamed = update(2, 123, "show:today:all");
  renamed.callback_query.from.first_name = "Новое имя";
  delete renamed.callback_query.from.username;
  await recordStatistics(env, renamed, { now: new Date("2026-10-25T10:00:00Z") });
  await recordStatistics(env, first, { now: today });
  const report = await readStatistics(env, today);
  assert.equal(report.others.users, 1);
  assert.equal(report.others.interactions, 2);
  assert.equal(report.others.schedules, 1);
  const users = await readStatisticsUsers(env, 0, today);
  assert.equal(users.users[0].first_name, "Новое имя");
  assert.equal(users.users[0].username, null);
  assert.equal(users.users[0].last_seen, "2026-10-25T10:00:00.000Z");
  assert.equal(users.users[0].first_seen, "2026-10-24T10:00:00.000Z");
});

test("unique users and 7/30-day windows exclude the owner and use calendar boundaries", async (t) => {
  const env = { ...baseEnv, STATS_DB: database(t) };
  const entries = [
    [1, 123, "2026-10-26T10:00:00Z"],
    [2, 123, "2026-10-20T09:00:00Z"], // included in 7 days
    [3, 456, "2026-10-19T09:00:00Z"], // outside 7 days
    [4, 789, "2026-09-27T09:00:00Z"], // included in 30 days
    [5, 321, "2026-09-26T09:00:00Z"], // outside 30 days
    [6, 999, "2026-10-26T10:00:00Z"],
  ];
  for (const [id, user, date] of entries) await recordStatistics(env, update(id, user), { now: new Date(date) });
  const { others, owner } = await readStatistics(env, today);
  assert.equal(others.users, 4);
  assert.equal(others.active_today, 1);
  assert.equal(others.active_7, 1);
  assert.equal(others.active_30, 3);
  assert.equal(others.interactions_7, 2);
  assert.equal(others.interactions_30, 4);
  assert.equal(owner.users, 1);
  assert.equal(owner.interactions, 1);
  assert.match(formatStatistics(await readStatistics(env, today)), /Уникальных всего: 5/);
});

test("transaction failure rolls back the event, and retry can write it exactly once", async (t) => {
  const db = database(t);
  const env = { ...baseEnv, STATS_DB: db };
  db.failWrite = true;
  assert.equal(await recordStatistics(env, update(), quiet), false);
  assert.equal((await readStatistics(env)).others.interactions, 0);
  assert.equal(await recordStatistics(env, update()), true);
  assert.equal((await readStatistics(env)).others.interactions, 1);
});

test("schema initialization failure is retryable and missing/disabled bindings are harmless", async (t) => {
  const db = database(t);
  const goodBatch = db.batch;
  let fail = true;
  db.batch = async (statements) => {
    if (fail) { fail = false; throw new Error("temporarily unavailable"); }
    return goodBatch(statements);
  };
  const env = { ...baseEnv, STATS_DB: db };
  assert.equal(await recordStatistics(env, update(), quiet), false);
  assert.equal(await recordStatistics(env, update(), quiet), true);
  assert.equal(await recordStatistics(baseEnv, update()), false);
  assert.equal(await recordStatistics({ ...env, STATS_ENABLED: "false" }, update(2)), false);
  assert.equal((await readStatistics(env)).others.interactions, 1);
});

test("users list is sorted, paginated, bounded and escapes Telegram HTML", async (t) => {
  const env = { ...baseEnv, STATS_DB: database(t) };
  for (let id = 1; id <= 12; id += 1) {
    const event = update(id, id);
    event.message.from.first_name = "<&>".repeat(200);
    event.message.from.last_name = "&".repeat(200);
    await recordStatistics(env, event, { now: today });
  }
  await recordStatistics(env, update(100, 12), { now: today });
  const first = await readStatisticsUsers(env, 0, today);
  assert.equal(first.users[0].user_id, 12);
  assert.equal(first.users.length, 5);
  assert.equal(first.lastPage, 2);
  const text = formatStatisticsUsers(first);
  assert.match(text, /&lt;&amp;&gt;/);
  assert.ok(text.length < 4096);
  assert.equal(statisticsUsersKeyboard(first).inline_keyboard[0][0].callback_data, "stats:users:1");
  const last = await readStatisticsUsers(env, 999, today);
  assert.equal(last.page, 2);
  assert.equal(last.users.length, 2);
  assert.equal(statisticsUsersKeyboard(last).inline_keyboard[0].length, 1);
});

async function webhook(env, update) {
  let task;
  const response = await worker.fetch(new Request("https://bot.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify(update),
  }), env, { waitUntil: (promise) => { task = promise; } });
  return { response, task };
}

test("normal replies and HTTP acknowledgement do not wait for a stuck D1 write", async (t) => {
  const db = database(t);
  const originalBatch = db.batch;
  let release;
  db.batch = (statements) => new Promise((resolve, reject) => {
    release = () => originalBatch(statements).then(resolve, reject);
  });
  const env = { ...baseEnv, STATS_DB: db };
  const originalFetch = globalThis.fetch;
  let sent;
  const delivered = new Promise((resolve) => { sent = resolve; });
  globalThis.fetch = async (_url, options) => {
    sent(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { response, task } = await webhook(env, update());
  assert.equal(response.status, 200);
  assert.match((await delivered).text, /Выбери/);
  // Release schema initialization; subsequent write should not stay blocked.
  const releaseSchema = release;
  db.batch = originalBatch;
  releaseSchema();
  await task;
  assert.equal((await readStatistics(env)).others.interactions, 1);
});

test("private stats are denied before DB access, even with a forged owner chat ID", async (t) => {
  const originalFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { ...baseEnv, STATS_DB: { prepare: () => assert.fail("unauthorized DB access"), batch: () => assert.fail("unauthorized DB access") } };
  const outsider = update(); outsider.message.text = "/stats";
  outsider.message.chat.id = 999;
  await (await webhook(env, outsider)).task;
  assert.match(payloads[0].text, /только владельцу/);
  const group = update(2, 999); group.message.chat = { id: -123, type: "group" }; group.message.text = "/users";
  await (await webhook(env, group)).task;
  assert.equal(payloads.length, 1);
});

test("owner can view reports; stats commands are not counted as activity", async (t) => {
  const env = { ...baseEnv, STATS_DB: database(t) };
  await recordStatistics(env, update(), { now: today });
  const originalFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const summary = update(2, 999); summary.message.text = "/stats";
  await (await webhook(env, summary)).task;
  assert.match(payloads[0].text, /Статистика Telegram-бота/);
  const users = update(3, 999); users.message.text = "/users";
  await (await webhook(env, users)).task;
  assert.match(payloads[1].text, /Анна Иванова/);
  assert.match(payloads[1].text, /@anna/);
  assert.equal((await readStatistics(env)).owner.interactions, 0);
});

test("admin pagination is authorized per click and webhook authentication precedes all collection", async (t) => {
  const env = { ...baseEnv, STATS_DB: database(t) };
  for (let id = 1; id <= 6; id += 1) await recordStatistics(env, update(id, id));
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const click = update(100, 999, "stats:users:1");
  await (await webhook(env, click)).task;
  assert.match(sent[0].url, /answerCallbackQuery$/);
  assert.match(sent[1].url, /editMessageText$/);
  assert.match(sent[1].text, /Страница 2 из 2/);
  assert.equal((await readStatistics(env)).owner.interactions, 0);
  const denied = update(101, 123, "stats:users:0");
  await (await webhook(env, denied)).task;
  assert.match(sent.at(-1).url, /answerCallbackQuery$/);
  assert.match(sent.at(-1).text, /только владельцу/);
  let queued = false;
  const response = await worker.fetch(new Request("https://bot.test/telegram", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
    body: JSON.stringify(update(102, 456)),
  }), env, { waitUntil: () => { queued = true; } });
  assert.equal(response.status, 403);
  assert.equal(queued, false);
  assert.equal((await readStatistics(env)).others.users, 6);
});

test("recording failure is isolated from the normal bot response", async (t) => {
  const env = { ...baseEnv, STATS_DB: { prepare: () => { throw new Error("D1 offline"); } } };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const sent = [];
  const logged = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: true });
  };
  console.error = (...args) => logged.push(args);
  t.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });
  const { response, task } = await webhook(env, update());
  assert.equal(response.status, 200);
  await task;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Выбери/);
  assert.doesNotMatch(JSON.stringify(logged), /Анна|Иванова|anna/);
});
