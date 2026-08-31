import {
  addDays,
  escapeHtml,
  formatDay,
  formatRange,
  mondayOf,
  moscowIsoDate,
  subgroupLabel,
} from "./format.js";

function telegramApi(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Telegram ${method}: ${response.status} ${await response.text()}`);
    }
    return response.json();
  });
}

async function loadSchedule(env) {
  const response = await fetch(env.SCHEDULE_URL, {
    cf: { cacheEverything: true, cacheTtl: 60 },
  });
  if (!response.ok) {
    throw new Error(`Schedule JSON: ${response.status}`);
  }
  const schedule = await response.json();
  if (schedule.schema_version !== 1 || !Array.isArray(schedule.days)) {
    throw new Error("Unsupported schedule schema");
  }
  return schedule;
}

function chooseKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "1 подгруппа", callback_data: "set:1" },
        { text: "2 подгруппа", callback_data: "set:2" },
      ],
      [{ text: "Обе подгруппы", callback_data: "set:all" }],
    ],
  };
}

function mainKeyboard(subgroup) {
  return {
    inline_keyboard: [
      [
        { text: "Сегодня", callback_data: `show:today:${subgroup}` },
        { text: "Завтра", callback_data: `show:tomorrow:${subgroup}` },
      ],
      [
        { text: "Эта неделя", callback_data: `show:week:${subgroup}` },
        { text: "Следующая", callback_data: `show:nextweek:${subgroup}` },
      ],
      [{ text: `Сейчас: ${subgroupLabel(subgroup)}`, callback_data: "choose" }],
    ],
  };
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function sendMenu(env, chatId, subgroup) {
  return sendMessage(
    env,
    chatId,
    `Расписание <b>БТб-3101-03-00</b>\nРежим: ${escapeHtml(subgroupLabel(subgroup))}`,
    mainKeyboard(subgroup),
  );
}

async function sendSchedule(env, chatId, scope, subgroup) {
  const schedule = await loadSchedule(env);
  const today = moscowIsoDate();
  const byDate = new Map(schedule.days.map((day) => [day.date, day]));
  let messages;

  if (scope === "today") {
    messages = [formatDay(byDate.get(today), subgroup)];
  } else if (scope === "tomorrow") {
    messages = [formatDay(byDate.get(addDays(today, 1)), subgroup)];
  } else if (scope === "week") {
    messages = formatRange(schedule, mondayOf(today), 7, subgroup);
  } else if (scope === "nextweek") {
    messages = formatRange(schedule, addDays(mondayOf(today), 7), 7, subgroup);
  } else {
    messages = ["Не понял период расписания."];
  }

  for (const text of messages) {
    await sendMessage(env, chatId, text);
  }
  await sendMenu(env, chatId, subgroup);
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const command = (message.text || "").split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/settings") {
    await sendMessage(
      env,
      chatId,
      "Выбери, какое расписание показывать:",
      chooseKeyboard(),
    );
    return;
  }

  const commandScopes = new Map([
    ["/today", "today"],
    ["/tomorrow", "tomorrow"],
    ["/week", "week"],
    ["/nextweek", "nextweek"],
  ]);
  if (commandScopes.has(command)) {
    await sendSchedule(env, chatId, commandScopes.get(command), "all");
    return;
  }

  await sendMessage(
    env,
    chatId,
    "Жми /start — там кнопки расписания и выбор подгруппы.",
  );
}

async function handleCallback(env, callback) {
  await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });
  const chatId = callback.message?.chat?.id;
  if (!chatId) return;
  const data = callback.data || "";

  if (data === "choose") {
    await sendMessage(env, chatId, "Выбери подгруппу:", chooseKeyboard());
    return;
  }
  if (data.startsWith("set:")) {
    const subgroup = data.slice(4);
    if (!["1", "2", "all"].includes(subgroup)) return;
    await sendMenu(env, chatId, subgroup);
    return;
  }
  if (data.startsWith("show:")) {
    const [, scope, subgroup] = data.split(":");
    if (!["1", "2", "all"].includes(subgroup)) return;
    await sendSchedule(env, chatId, scope, subgroup);
  }
}

async function handleUpdate(env, update) {
  try {
    if (update.message) await handleMessage(env, update.message);
    if (update.callback_query) await handleCallback(env, update.callback_query);
  } catch (error) {
    console.error(error);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      await sendMessage(
        env,
        chatId,
        "Не получилось получить расписание. Попробуй ещё раз чуть позже.",
      );
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "vyatsu-schedule-bot" });
    }
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const update = await request.json();
    ctx.waitUntil(handleUpdate(env, update));
    return new Response("OK");
  },
};
