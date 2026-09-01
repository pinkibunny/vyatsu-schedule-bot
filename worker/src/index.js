import {
  addDays,
  escapeHtml,
  formatDataStatus,
  formatDay,
  formatMissingDate,
  formatRange,
  mondayOf,
  moscowIsoDate,
  subgroupLabel,
} from "./format.js";

const VALID_SUBGROUPS = ["1", "2", "all"];
const VALID_SCOPES = ["today", "tomorrow", "aftertomorrow", "week", "nextweek"];
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function telegramApi(env, method, payload, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const maxAttempts = options.maxAttempts || 3;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await sleepImpl(250 * 2 ** attempt);
      continue;
    }

    const raw = await response.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { description: raw };
    }
    if (response.ok && body.ok !== false) return body;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt + 1 >= maxAttempts) {
      throw new Error(
        `Telegram ${method}: ${response.status} ${body.description || raw}`,
      );
    }
    const retryAfter = response.status === 429
      ? Math.min(Math.max(Number(body.parameters?.retry_after) || 1, 0), 8) * 1000
      : 250 * 2 ** attempt;
    await sleepImpl(retryAfter);
  }
  throw lastError || new Error(`Telegram ${method}: временная ошибка`);
}

function assertSchedule(schedule) {
  if (
    schedule?.schema_version !== 1 ||
    !Array.isArray(schedule.days) ||
    !schedule.days.length ||
    !schedule.period?.schedule_start ||
    !schedule.period?.schedule_end
  ) {
    throw new Error("Unsupported schedule schema");
  }
  return schedule;
}

function backupRequest(env) {
  const url = new URL(env.SCHEDULE_URL);
  url.searchParams.set("worker_backup", "1");
  return new Request(url.toString());
}

export async function loadSchedule(env, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const cache = options.cache === undefined ? globalThis.caches?.default : options.cache;
  try {
    const response = await fetchImpl(env.SCHEDULE_URL, {
      cf: { cacheEverything: true, cacheTtl: 60 },
    });
    if (!response.ok) throw new Error(`Schedule JSON: ${response.status}`);
    const raw = await response.text();
    const schedule = assertSchedule(JSON.parse(raw));
    if (cache) {
      try {
        await cache.put(
          backupRequest(env),
          new Response(raw, {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "public, max-age=604800",
            },
          }),
        );
      } catch (error) {
        console.error("Schedule backup cache:", error);
      }
    }
    return schedule;
  } catch (error) {
    if (cache) {
      const backup = await cache.match(backupRequest(env));
      if (backup) {
        const schedule = assertSchedule(await backup.json());
        schedule._from_backup = true;
        return schedule;
      }
    }
    throw error;
  }
}

export function chooseKeyboard(scope = null) {
  const action = (subgroup) => {
    if (scope === "calendar") return `calendar:${subgroup}`;
    if (scope) return `show:${scope}:${subgroup}`;
    return `set:${subgroup}`;
  };
  return {
    inline_keyboard: [
      [
        { text: "1 подгруппа", callback_data: action("1") },
        { text: "2 подгруппа", callback_data: action("2") },
      ],
      [{ text: "Обе подгруппы", callback_data: action("all") }],
    ],
  };
}

export function mainKeyboard(subgroup) {
  return {
    inline_keyboard: [
      [
        { text: "Сегодня", callback_data: `show:today:${subgroup}` },
        { text: "Завтра", callback_data: `show:tomorrow:${subgroup}` },
        { text: "Послезавтра", callback_data: `show:aftertomorrow:${subgroup}` },
      ],
      [
        { text: "Эта неделя", callback_data: `show:week:${subgroup}` },
        { text: "Следующая", callback_data: `show:nextweek:${subgroup}` },
      ],
      [{ text: "📅 Выбрать день", callback_data: `calendar:${subgroup}` }],
      [
        { text: `⚙️ ${subgroupLabel(subgroup)}`, callback_data: "choose" },
        { text: "🔄 Данные", callback_data: `status:${subgroup}` },
      ],
    ],
  };
}

function scheduleBounds(schedule) {
  const dates = schedule.days.map((day) => day.date).sort();
  return { start: dates[0], end: dates.at(-1) };
}

export function calendarPageStart(schedule, requestedDate = moscowIsoDate()) {
  const { start, end } = scheduleBounds(schedule);
  const firstPage = mondayOf(start);
  const lastPage = mondayOf(end);
  const requestedPage = mondayOf(requestedDate);
  if (requestedPage < firstPage) return firstPage;
  if (requestedPage > lastPage) return lastPage;
  return requestedPage;
}

function calendarButtonText(isoDate) {
  const value = new Date(`${isoDate}T12:00:00Z`);
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS_SHORT[value.getUTCDay()]} · ${day}.${month}`;
}

function compactDate(isoDate) {
  return calendarButtonText(isoDate).split(" · ")[1];
}

export function calendarKeyboard(schedule, subgroup, requestedDate = moscowIsoDate()) {
  const pageStart = calendarPageStart(schedule, requestedDate);
  const knownDates = new Set(schedule.days.map((day) => day.date));
  const dateButtons = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(pageStart, offset);
    if (!knownDates.has(date)) continue;
    dateButtons.push({
      text: calendarButtonText(date),
      callback_data: `date:${date}:${subgroup}`,
    });
  }

  const rows = [];
  for (let index = 0; index < dateButtons.length; index += 2) {
    rows.push(dateButtons.slice(index, index + 2));
  }

  const { start, end } = scheduleBounds(schedule);
  const navigation = [];
  const previousPage = addDays(pageStart, -7);
  const nextPage = addDays(pageStart, 7);
  if (addDays(pageStart, -1) >= start) {
    navigation.push({ text: "⬅️ Раньше", callback_data: `calendar:${previousPage}:${subgroup}` });
  }
  if (nextPage <= end) {
    navigation.push({ text: "Позже ➡️", callback_data: `calendar:${nextPage}:${subgroup}` });
  }
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: "↩️ В меню", callback_data: `set:${subgroup}` }]);
  return { inline_keyboard: rows };
}

function calendarText(schedule, subgroup, requestedDate) {
  const pageStart = calendarPageStart(schedule, requestedDate);
  return [
    "<b>Выбери день</b>",
    `${compactDate(pageStart)} — ${compactDate(addDays(pageStart, 6))}`,
    escapeHtml(subgroupLabel(subgroup)),
  ].join("\n");
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

async function editMessage(env, chatId, messageId, text, replyMarkup) {
  return telegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function removeKeyboard(env, callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) return;
  try {
    await telegramApi(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.error("Remove old keyboard:", error);
  }
}

function menuText(subgroup) {
  return [
    "Расписание <b>БТб-3101-03-00</b>",
    `Режим: ${escapeHtml(subgroupLabel(subgroup))}`,
  ].join("\n");
}

async function sendMenu(env, chatId, subgroup) {
  return sendMessage(env, chatId, menuText(subgroup), mainKeyboard(subgroup));
}

async function replaceWithMenu(env, callback, subgroup) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId) return;
  if (messageId) {
    try {
      await editMessage(env, chatId, messageId, menuText(subgroup), mainKeyboard(subgroup));
      return;
    } catch (error) {
      console.error("Edit menu:", error);
    }
  }
  await sendMenu(env, chatId, subgroup);
}

async function replaceWithChoice(env, callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId) return;
  if (messageId) {
    try {
      await editMessage(env, chatId, messageId, "Выбери подгруппу:", chooseKeyboard());
      return;
    } catch (error) {
      console.error("Edit subgroup choice:", error);
    }
  }
  await sendMessage(env, chatId, "Выбери подгруппу:", chooseKeyboard());
}

async function replaceWithCalendar(env, callback, subgroup, requestedDate) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId) return;
  const schedule = await loadSchedule(env);
  const text = calendarText(schedule, subgroup, requestedDate);
  const keyboard = calendarKeyboard(schedule, subgroup, requestedDate);
  if (messageId) {
    try {
      await editMessage(env, chatId, messageId, text, keyboard);
      return;
    } catch (error) {
      console.error("Edit calendar:", error);
    }
  }
  await sendMessage(env, chatId, text, keyboard);
}

async function sendSchedule(env, chatId, scope, subgroup) {
  const schedule = await loadSchedule(env);
  const today = moscowIsoDate();
  const byDate = new Map(schedule.days.map((day) => [day.date, day]));
  let messages;

  if (["today", "tomorrow", "aftertomorrow"].includes(scope)) {
    const offset = { today: 0, tomorrow: 1, aftertomorrow: 2 }[scope];
    const date = addDays(today, offset);
    const day = byDate.get(date);
    messages = [day ? formatDay(day, subgroup) : formatMissingDate(schedule, date)];
  } else if (ISO_DATE_PATTERN.test(scope)) {
    const day = byDate.get(scope);
    messages = [day ? formatDay(day, subgroup) : formatMissingDate(schedule, scope)];
  } else if (scope === "week") {
    messages = formatRange(schedule, mondayOf(today), 7, subgroup);
  } else if (scope === "nextweek") {
    messages = formatRange(schedule, addDays(mondayOf(today), 7), 7, subgroup);
  } else {
    messages = ["Не понял период расписания."];
  }

  messages[0] = [
    `<b>БТб-3101-03-00 · ${escapeHtml(subgroupLabel(subgroup))}</b>`,
    "",
    messages[0],
  ].join("\n");
  for (let index = 0; index < messages.length; index += 1) {
    if (index > 0) await sleep(1050);
    const replyMarkup = index === messages.length - 1 ? mainKeyboard(subgroup) : undefined;
    await sendMessage(env, chatId, messages[index], replyMarkup);
  }
}

async function sendDataStatus(env, chatId, subgroup) {
  const schedule = await loadSchedule(env);
  await sendMessage(
    env,
    chatId,
    formatDataStatus(schedule),
    mainKeyboard(subgroup),
  );
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const command = (message.text || "").split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/settings") {
    await sendMessage(env, chatId, "Выбери, какое расписание показывать:", chooseKeyboard());
    return;
  }

  const commandScopes = new Map([
    ["/today", "today"],
    ["/tomorrow", "tomorrow"],
    ["/aftertomorrow", "aftertomorrow"],
    ["/week", "week"],
    ["/nextweek", "nextweek"],
  ]);
  if (commandScopes.has(command)) {
    const scope = commandScopes.get(command);
    await sendMessage(env, chatId, "Для какой подгруппы показать?", chooseKeyboard(scope));
    return;
  }
  if (command === "/day") {
    await sendMessage(env, chatId, "Для какой подгруппы выбрать день?", chooseKeyboard("calendar"));
    return;
  }

  await sendMessage(env, chatId, "Жми /start — там кнопки расписания и выбор подгруппы.");
}

async function handleCallback(env, callback) {
  await telegramApi(
    env,
    "answerCallbackQuery",
    { callback_query_id: callback.id },
    { maxAttempts: 1 },
  ).catch((error) => console.error("Callback answer:", error));
  const chatId = callback.message?.chat?.id;
  if (!chatId) return;
  const data = callback.data || "";

  if (data === "choose") {
    await replaceWithChoice(env, callback);
    return;
  }
  if (data.startsWith("set:")) {
    const subgroup = data.slice(4);
    if (!VALID_SUBGROUPS.includes(subgroup)) return;
    await replaceWithMenu(env, callback, subgroup);
    return;
  }
  if (data.startsWith("status:")) {
    const subgroup = data.slice(7);
    if (!VALID_SUBGROUPS.includes(subgroup)) return;
    await removeKeyboard(env, callback);
    await sendDataStatus(env, chatId, subgroup);
    return;
  }
  if (data.startsWith("calendar:")) {
    const parts = data.split(":");
    const subgroup = parts.at(-1);
    const requestedDate = parts.length === 3 ? parts[1] : undefined;
    if (!VALID_SUBGROUPS.includes(subgroup)) return;
    if (requestedDate && !ISO_DATE_PATTERN.test(requestedDate)) return;
    await replaceWithCalendar(env, callback, subgroup, requestedDate);
    return;
  }
  if (data.startsWith("date:")) {
    const [, date, subgroup] = data.split(":");
    if (!ISO_DATE_PATTERN.test(date) || !VALID_SUBGROUPS.includes(subgroup)) return;
    await removeKeyboard(env, callback);
    await sendSchedule(env, chatId, date, subgroup);
    return;
  }
  if (data.startsWith("show:")) {
    const [, scope, subgroup] = data.split(":");
    if (!VALID_SCOPES.includes(scope) || !VALID_SUBGROUPS.includes(subgroup)) return;
    await removeKeyboard(env, callback);
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
      try {
        await sendMessage(
          env,
          chatId,
          "Не получилось получить расписание. Попробуй ещё раз чуть позже.",
        );
      } catch (sendError) {
        console.error("Error message delivery:", sendError);
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const schedule = await loadSchedule(env);
        return Response.json({
          ok: true,
          service: "vyatsu-schedule-bot",
          generated_at: schedule.generated_at,
          checked_at: schedule.checked_at || schedule.generated_at,
          period: schedule.period,
          backup: Boolean(schedule._from_backup),
        });
      } catch (error) {
        return Response.json(
          { ok: false, service: "vyatsu-schedule-bot", error: String(error) },
          { status: 503 },
        );
      }
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
