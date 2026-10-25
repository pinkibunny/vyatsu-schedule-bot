import {
  addDays, chunkBlocks, formatDataStatus, formatDay, formatMissingDate,
  formatRange, mondayOf, moscowIsoDate, subgroupLabel,
} from "../../worker/src/format.js";
import {
  calendarKeyboard, calendarPageStart, chooseKeyboard, loadSchedule, mainKeyboard,
} from "../../worker/src/index.js";

const GROUP = "БТб-3101-03-00";
const SUBGROUPS = new Set(["1", "2", "all"]);
const SCOPES = new Set(["today", "tomorrow", "aftertomorrow", "week", "nextweek"]);

export function plainText(html) {
  return String(html).replace(/<\/?(?:b|i|code)>/g, "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function textButton(label, action) {
  return {
    action: { type: "text", label, payload: JSON.stringify({ action }) },
    color: "secondary",
  };
}

// Reuse the Telegram navigation so both channels have the same dates/subgroups.
export function vkKeyboard(markup) {
  return {
    one_time: false,
    inline: false,
    buttons: markup.inline_keyboard.map((row) => row
      .filter((button) => typeof button.callback_data === "string")
      .map((button) => textButton(button.text, button.callback_data)))
      .filter((row) => row.length > 0),
  };
}

function menuKeyboard(subgroup) {
  return vkKeyboard(mainKeyboard(subgroup));
}

function menuText(subgroup) {
  return `Расписание ${GROUP}\nРежим: ${subgroupLabel(subgroup)}\n\nВыбери день или неделю кнопками ниже.`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function messageAction(message) {
  if (message.payload) {
    try {
      const payload = typeof message.payload === "string"
        ? JSON.parse(message.payload) : message.payload;
      return typeof payload?.action === "string" ? payload.action : "help";
    } catch {
      return "help";
    }
  }
  const text = String(message.text || "").trim().toLowerCase();
  const commands = new Map([
    ["начать", "choose"], ["start", "choose"], ["/start", "choose"],
    ["меню", "choose"], ["/settings", "choose"], ["подгруппа", "choose"],
    ["1 подгруппа", "set:1"], ["2 подгруппа", "set:2"], ["обе подгруппы", "set:all"],
    ["сегодня", "pick:today"], ["/today", "pick:today"],
    ["завтра", "pick:tomorrow"], ["/tomorrow", "pick:tomorrow"],
    ["послезавтра", "pick:aftertomorrow"], ["/aftertomorrow", "pick:aftertomorrow"],
    ["эта неделя", "pick:week"], ["неделя", "pick:week"], ["/week", "pick:week"],
    ["следующая", "pick:nextweek"], ["следующая неделя", "pick:nextweek"],
    ["/nextweek", "pick:nextweek"], ["выбрать день", "pick:calendar"], ["/day", "pick:calendar"],
    ["данные", "status:all"], ["/status", "status:all"],
    ["отзыв", "feedback:all"], ["идея", "feedback:all"],
    ["тест", "test"], ["проверить ещё раз", "test"],
  ]);
  if (commands.has(text)) return commands.get(text);
  if (validDate(text)) return `pick:${text}`;
  const shortDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (shortDate) {
    const iso = `${shortDate[3]}-${shortDate[2]}-${shortDate[1]}`;
    if (validDate(iso)) return `pick:${iso}`;
  }
  return "help";
}

function configuration(env) {
  return {
    group: /^[1-9]\d*$/.test(String(env.VK_GROUP_ID || "")),
    token: Boolean(env.VK_TOKEN),
    secret: Boolean(env.VK_CALLBACK_SECRET),
    confirmation: Boolean(env.VK_CONFIRMATION_CODE),
    schedule: Boolean(env.SCHEDULE_URL),
  };
}

// A repeat delivery must use the same random_id so VK can suppress duplicates.
export function replyRandomId(update, part = 0) {
  const message = update.object.message;
  const key = JSON.stringify([
    update.group_id,
    message.peer_id,
    message.conversation_message_id ?? message.id ?? update.event_id,
    part,
  ]);
  let hash = 2166136261;
  for (const character of key) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

async function sendReply(env, update, reply, part, options) {
  const started = performance.now();
  const fetchImpl = options.fetchImpl || fetch;
  const body = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: env.VK_API_VERSION || "5.199",
    peer_id: String(update.object.message.peer_id),
    random_id: String(replyRandomId(update, part)),
    message: reply.text,
    dont_parse_links: "1",
    disable_mentions: "1",
    ...(reply.keyboard ? { keyboard: JSON.stringify(reply.keyboard) } : {}),
  });
  const response = await fetchImpl("https://api.vk.com/method/messages.send", {
    method: "POST",
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`VK HTTP ${response.status}`);
  const result = await response.json();
  if (result.error || !Number.isInteger(result.response) || result.response <= 0) {
    // Do not log the response body: VK may include access_token in request_params.
    const code = Number(result.error?.error_code);
    throw new Error(Number.isFinite(code) ? `VK API ${code}` : "VK invalid response");
  }
  (options.logInfo || console.log)("VK reply delivered", {
    part, send_ms: Math.round(performance.now() - started),
  });
}

export async function buildReplies(env, message, options = {}) {
  const action = messageAction(message);
  const [kind, first, second] = action.split(":");
  const today = moscowIsoDate(options.now);
  if (kind === "test") {
    return [{ text: "✅ ВК ↔ Cloudflare: сообщение получено, ответ отправлен!\n\n" + menuText("all"), keyboard: menuKeyboard("all") }];
  }
  if (kind === "choose") {
    return [{ text: `Расписание ${GROUP}\n\nВыбери подгруппу:`, keyboard: vkKeyboard(chooseKeyboard()) }];
  }
  if (kind === "pick" && (SCOPES.has(first) || first === "calendar" || validDate(first))) {
    return [{ text: "Для какой подгруппы показать расписание?", keyboard: vkKeyboard(chooseKeyboard(first)) }];
  }
  if (kind === "set" && SUBGROUPS.has(first)) {
    return [{ text: menuText(first), keyboard: menuKeyboard(first) }];
  }
  if (kind === "feedback") {
    const subgroup = SUBGROUPS.has(first) ? first : "all";
    return [{
      text: menuText(subgroup), keyboard: menuKeyboard(subgroup),
    }];
  }

  const subgroup = action.split(":").at(-1);
  const isCalendar = kind === "calendar" && SUBGROUPS.has(subgroup) &&
    (action.split(":").length === 2 || (action.split(":").length === 3 && validDate(first)));
  const isDate = kind === "date" && validDate(first) && SUBGROUPS.has(second);
  const isShow = kind === "show" && (SCOPES.has(first) || validDate(first)) && SUBGROUPS.has(second);
  const isStatus = kind === "status" && SUBGROUPS.has(first);
  if (!isCalendar && !isDate && !isShow && !isStatus) {
    return [{
      text: "Жми кнопки ниже или напиши «сегодня», «завтра», «неделя» либо дату в формате 26.10.2026. Подгруппу можно выбрать через «Меню».",
      keyboard: menuKeyboard("all"),
    }];
  }

  let schedule;
  const started = performance.now();
  try {
    const fetchImpl = options.fetchImpl || fetch;
    schedule = await loadSchedule(env, {
      cache: options.cache,
      fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000) }),
    });
  } catch {
    return [{ text: "Не получилось загрузить расписание. Попробуй ещё раз чуть позже.", keyboard: menuKeyboard(subgroup) }];
  }
  (options.logInfo || console.log)("VK schedule loaded", {
    schedule_ms: Math.round(performance.now() - started), backup: Boolean(schedule._from_backup),
  });
  if (isStatus) {
    return [{ text: plainText(formatDataStatus(schedule, today)), keyboard: menuKeyboard(subgroup) }];
  }
  if (isCalendar) {
    const requested = action.split(":").length === 3 ? first : today;
    const start = calendarPageStart(schedule, requested);
    const shortDate = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
    return [{
      text: `Выбери день\n${shortDate(start)} — ${shortDate(addDays(start, 6))}\n${subgroupLabel(subgroup)}`,
      keyboard: vkKeyboard(calendarKeyboard(schedule, subgroup, requested)),
    }];
  }
  let blocks;
  if (first === "week" || first === "nextweek") {
    const start = addDays(mondayOf(today), first === "nextweek" ? 7 : 0);
    blocks = formatRange(schedule, start, 7, subgroup);
  } else {
    const offsets = { today: 0, tomorrow: 1, aftertomorrow: 2 };
    const date = validDate(first) ? first : addDays(today, offsets[first]);
    const day = schedule.days.find((item) => item.date === date);
    blocks = [day ? formatDay(day, subgroup) : formatMissingDate(schedule, date)];
  }
  const chunks = chunkBlocks([
    `${GROUP} · ${subgroupLabel(subgroup)}\n\n${plainText(blocks[0])}`,
    ...blocks.slice(1).map(plainText),
    ...(schedule._from_backup ? ["⚠️ Используется последняя сохранённая копия расписания."] : []),
  ]);
  return chunks.map((text, index) => ({
    text,
    ...(index === chunks.length - 1 ? { keyboard: menuKeyboard(subgroup) } : {}),
  }));
}

export async function handleRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const config = configuration(env);
  if (request.method === "GET" && url.pathname === "/health") {
    const ready = Object.values(config).every(Boolean);
    return Response.json({
      ok: ready,
      service: "vyatsu-schedule-vk-bot",
      stage: "schedule",
      configured: config,
    }, { status: ready ? 200 : 503 });
  }
  if (url.pathname !== "/vk") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!config.group || !config.secret) {
    return new Response("Callback not configured", { status: 503 });
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (
    !update || String(update.group_id) !== String(env.VK_GROUP_ID) ||
    update.secret !== env.VK_CALLBACK_SECRET
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  if (update.type === "confirmation") {
    return config.confirmation
      ? new Response(env.VK_CONFIRMATION_CODE)
      : new Response("Confirmation not configured", { status: 503 });
  }
  if (update.type !== "message_new") return new Response("ok");
  const message = update.object?.message;
  // Handle incoming personal messages only, not chat conversations.
  if (
    !message || message.out ||
    !Number.isSafeInteger(message.from_id) || message.from_id <= 0 ||
    message.peer_id !== message.from_id ||
    message.peer_id >= 2000000000 ||
    !(Number.isSafeInteger(message.conversation_message_id) ||
      Number.isSafeInteger(message.id) || typeof update.event_id === "string")
  ) {
    return new Response("ok");
  }
  if (!config.token) return new Response("VK token not configured", { status: 503 });
  try {
    // Acknowledge only after delivery; on failure VK can retry the event.
    const replies = await buildReplies(env, message, options);
    for (let part = 0; part < replies.length; part += 1) {
      await sendReply(env, update, replies[part], part, options);
    }
    return new Response("ok");
  } catch (error) {
    const logError = options.logError || console.error;
    // Never print incoming messages, user IDs, tokens, or raw VK errors.
    logError("VK reply failed", /^VK (HTTP \d+|API \d+|invalid response)$/.test(error.message)
      ? error.message : "Network, timeout or response decoding error");
    return new Response("VK delivery failed", { status: 502 });
  }
}

export default { fetch: handleRequest };
