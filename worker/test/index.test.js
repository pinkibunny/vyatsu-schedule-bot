import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  FEEDBACK_PROMPT,
  calendarKeyboard,
  calendarPageStart,
  chooseKeyboard,
  loadSchedule,
  mainKeyboard,
  telegramApi,
} from "../src/index.js";

const env = {
  BOT_TOKEN: "test-token",
  SCHEDULE_URL: "https://example.test/schedule.json",
};

const schedule = {
  schema_version: 1,
  group: "БТб-3101-03-00",
  generated_at: "2026-09-01T00:00:00Z",
  period: {
    schedule_start: "2026-08-31",
    schedule_end: "2026-09-13",
  },
  days: [{ date: "2026-09-01", weekday: "вторник", lessons: [] }],
};

test("Telegram 429 response is retried after retry_after", async () => {
  const responses = [
    new Response(JSON.stringify({
      ok: false,
      description: "Too Many Requests",
      parameters: { retry_after: 2 },
    }), { status: 429 }),
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
  ];
  const waits = [];
  let calls = 0;
  const result = await telegramApi(env, "sendMessage", { chat_id: 1 }, {
    fetchImpl: async () => responses[calls++],
    sleepImpl: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test("period command keyboard keeps the requested scope", () => {
  const keyboard = chooseKeyboard("tomorrow");
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "show:tomorrow:1");
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, "show:tomorrow:all");
});

test("main keyboard includes subgroup and data status", () => {
  const keyboard = mainKeyboard("2");
  assert.equal(keyboard.inline_keyboard[0][2].callback_data, "show:aftertomorrow:2");
  assert.equal(keyboard.inline_keyboard[2][0].callback_data, "calendar:2");
  assert.match(keyboard.inline_keyboard[3][0].text, /2 подгруппа/);
  assert.equal(keyboard.inline_keyboard[3][1].callback_data, "status:2");
});

test("feedback button is shown only after admin setup", () => {
  const disabled = mainKeyboard("all", false);
  assert.ok(!disabled.inline_keyboard.flat().some((button) =>
    button.callback_data?.startsWith("feedback:")));

  const enabled = mainKeyboard("all", true);
  assert.equal(enabled.inline_keyboard.at(-1)[0].text, "💡 Отзыв / идея");
  assert.equal(enabled.inline_keyboard.at(-1)[0].callback_data, "feedback:all");
});

test("calendar shows known dates and keeps subgroup", () => {
  const twoWeeks = {
    ...schedule,
    days: Array.from({ length: 14 }, (_, offset) => ({
      date: new Date(Date.UTC(2026, 7, 31 + offset)).toISOString().slice(0, 10),
      weekday: "день",
      lessons: [],
    })),
  };
  assert.equal(calendarPageStart(twoWeeks, "2026-09-02"), "2026-08-31");
  const keyboard = calendarKeyboard(twoWeeks, "1", "2026-09-02");
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "date:2026-08-31:1");
  assert.ok(keyboard.inline_keyboard.flat().some((button) =>
    button.callback_data === "calendar:2026-09-07:1"));
  assert.equal(keyboard.inline_keyboard.at(-1)[0].callback_data, "set:1");
});

test("last successful schedule is used when the source is unavailable", async () => {
  let stored;
  const cache = {
    async put(_request, response) {
      stored = response.clone();
    },
    async match() {
      return stored?.clone();
    },
  };
  const live = await loadSchedule(env, {
    cache,
    fetchImpl: async () => new Response(JSON.stringify(schedule), { status: 200 }),
  });
  assert.equal(live._from_backup, undefined);

  const backup = await loadSchedule(env, {
    cache,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  assert.equal(backup._from_backup, true);
  assert.equal(backup.group, "БТб-3101-03-00");
});

test("feedback relay strips all sender metadata", async () => {
  const originalFetch = globalThis.fetch;
  const telegramPayloads = [];
  globalThis.fetch = async (_url, options) => {
    telegramPayloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  try {
    let backgroundTask;
    const request = new Request("https://worker.test/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: 123456, type: "private" },
          from: { id: 123456, first_name: "Секретное имя", username: "secret_user" },
          text: "Добавьте кнопку расписания на месяц",
          reply_to_message: {
            message_id: 9,
            from: { id: 1, is_bot: true },
            text: FEEDBACK_PROMPT,
          },
        },
      }),
    });
    const response = await worker.fetch(request, {
      ...env,
      WEBHOOK_SECRET: "webhook-secret",
      ADMIN_CHAT_ID: "999999",
    }, {
      waitUntil(promise) {
        backgroundTask = promise;
      },
    });
    assert.equal(response.status, 200);
    await backgroundTask;

    assert.equal(telegramPayloads[0].chat_id, "999999");
    assert.match(telegramPayloads[0].text, /^🚨.*ОТЗЫВ.*🚨/);
    assert.match(telegramPayloads[0].text, /кнопку расписания на месяц/);
    assert.doesNotMatch(telegramPayloads[0].text, /Секретное имя|secret_user|123456/);
    assert.equal(telegramPayloads[1].chat_id, 123456);
    assert.match(telegramPayloads[1].text, /анонимно отправлено/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
