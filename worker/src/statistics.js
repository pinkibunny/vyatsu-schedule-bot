import { addDays, escapeHtml, moscowIsoDate } from "./format.js";

const PAGE_SIZE = 5;
const initialization = new WeakMap();
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stats_events (
    update_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    is_schedule INTEGER NOT NULL CHECK (is_schedule IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS stats_users (
    user_id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT,
    username TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS stats_events_user_day ON stats_events(user_id, day)",
  "CREATE INDEX IF NOT EXISTS stats_events_day_user ON stats_events(day, user_id)",
];

export function statisticsAdminId(env) {
  const raw = String(env.STATS_ADMIN_ID ?? env.ADMIN_CHAT_ID ?? "");
  const id = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) ? id : null;
}

export function statisticsStatus(env) {
  return {
    configured: Boolean(env.STATS_DB),
    enabled: env.STATS_ENABLED !== "false",
    admin_configured: statisticsAdminId(env) !== null,
  };
}

export function isStatisticsAdmin(env, from, chat) {
  const admin = statisticsAdminId(env);
  return admin !== null && from?.id === admin && !from.is_bot &&
    chat?.type === "private" && chat.id === admin;
}

export function statisticsAction(update) {
  const message = update.message;
  const command = String(message?.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/stats") return { kind: "summary" };
  if (command === "/users") {
    const page = Number(String(message.text).trim().split(/\s+/)[1] || "1");
    return { kind: "users", page: Number.isSafeInteger(page) && page > 0 ? page - 1 : 0 };
  }
  const match = /^stats:users:(\d{1,8})$/.exec(update.callback_query?.data || "");
  return match ? { kind: "users", page: Number(match[1]) } : null;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function scheduleRequest(data) {
  const parts = String(data || "").split(":");
  if (parts.length !== 3 || !["1", "2", "all"].includes(parts[2])) return false;
  if (parts[0] === "date") return validDate(parts[1]);
  return parts[0] === "show" && ["today", "tomorrow", "aftertomorrow", "week", "nextweek"].includes(parts[1]);
}

// Collect only direct interactions received by this bot, never message bodies.
export function statisticsEvent(update, now = new Date()) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 || statisticsAction(update)) return null;
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const user = callback?.from || update.message?.from;
  if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.is_bot ||
      message?.chat?.type !== "private" || message.chat.id !== user.id) return null;
  // Old feedback buttons/replies remain anonymous even though removed from menus.
  if (callback?.data?.startsWith("feedback:") ||
      (update.message?.reply_to_message?.from?.is_bot &&
       update.message.reply_to_message.text?.includes("Администратор получит только текст"))) return null;
  return {
    update_id: update.update_id,
    user_id: user.id,
    first_name: String(user.first_name || "Без имени").slice(0, 256),
    last_name: user.last_name ? String(user.last_name).slice(0, 256) : null,
    username: user.username ? String(user.username).slice(0, 64) : null,
    day: moscowIsoDate(now),
    occurred_at: now.toISOString(),
    is_schedule: scheduleRequest(callback?.data) ? 1 : 0,
  };
}

async function ensureSchema(db) {
  let pending = initialization.get(db);
  if (!pending) {
    pending = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((error) => {
      initialization.delete(db);
      throw error;
    });
    initialization.set(db, pending);
  }
  await pending;
}

export async function recordStatistics(env, update, options = {}) {
  if (!env.STATS_DB || env.STATS_ENABLED === "false" || !statisticsAdminId(env)) return false;
  try {
    const event = statisticsEvent(update, options.now || new Date());
    if (!event) return false;
    const db = env.STATS_DB;
    await ensureSchema(db);
    await db.batch([
      db.prepare(`INSERT INTO stats_events (update_id, user_id, day, occurred_at, is_schedule)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(update_id) DO NOTHING`).bind(
        event.update_id, event.user_id, event.day, event.occurred_at, event.is_schedule,
      ),
      db.prepare(`INSERT INTO stats_users (user_id, first_name, last_name, username, first_seen, last_seen)
        SELECT user_id, ?, ?, ?, occurred_at, occurred_at FROM stats_events WHERE update_id = ?
        ON CONFLICT(user_id) DO UPDATE SET
          first_name = CASE WHEN excluded.last_seen >= stats_users.last_seen THEN excluded.first_name ELSE stats_users.first_name END,
          last_name = CASE WHEN excluded.last_seen >= stats_users.last_seen THEN excluded.last_name ELSE stats_users.last_name END,
          username = CASE WHEN excluded.last_seen >= stats_users.last_seen THEN excluded.username ELSE stats_users.username END,
          first_seen = MIN(stats_users.first_seen, excluded.first_seen),
          last_seen = MAX(stats_users.last_seen, excluded.last_seen)`).bind(
        event.first_name, event.last_name, event.username, event.update_id,
      ),
    ]);
    return true;
  } catch {
    // Do not put user profiles or SQL bind values in Cloudflare logs.
    (options.logError || console.error)("Statistics recording unavailable");
    return false;
  }
}

const SUMMARY_SQL = `SELECT
  COUNT(DISTINCT user_id) AS users,
  COUNT(*) AS interactions,
  COALESCE(SUM(is_schedule), 0) AS schedules,
  COUNT(DISTINCT CASE WHEN day = ? THEN user_id END) AS active_today,
  COUNT(DISTINCT CASE WHEN day BETWEEN ? AND ? THEN user_id END) AS active_7,
  COUNT(DISTINCT CASE WHEN day BETWEEN ? AND ? THEN user_id END) AS active_30,
  COALESCE(SUM(CASE WHEN day = ? THEN 1 ELSE 0 END), 0) AS interactions_today,
  COALESCE(SUM(CASE WHEN day BETWEEN ? AND ? THEN 1 ELSE 0 END), 0) AS interactions_7,
  COALESCE(SUM(CASE WHEN day BETWEEN ? AND ? THEN 1 ELSE 0 END), 0) AS interactions_30
  FROM stats_events WHERE user_id `;

function summaryParams(today, id) {
  const week = addDays(today, -6);
  const month = addDays(today, -29);
  return [today, week, today, month, today, today, week, today, month, today, id];
}

export async function readStatistics(env, now = new Date()) {
  const db = env.STATS_DB;
  await ensureSchema(db);
  const today = moscowIsoDate(now);
  const admin = statisticsAdminId(env);
  const results = await db.batch([
    db.prepare(SUMMARY_SQL + "!= ?").bind(...summaryParams(today, admin)),
    db.prepare(SUMMARY_SQL + "= ?").bind(...summaryParams(today, admin)),
    db.prepare("SELECT MIN(occurred_at) AS started_at FROM stats_events"),
  ]);
  return {
    today,
    others: results[0].results[0],
    owner: results[1].results[0],
    started_at: results[2].results[0].started_at,
  };
}

export async function readStatisticsUsers(env, page = 0, now = new Date()) {
  const db = env.STATS_DB;
  await ensureSchema(db);
  const today = moscowIsoDate(now);
  const admin = statisticsAdminId(env);
  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM stats_users WHERE user_id != ?")
    .bind(admin).first();
  const total = Number(totalRow.total);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  page = Math.min(Math.max(Number.isSafeInteger(page) ? page : 0, 0), lastPage);
  const result = await db.prepare(`SELECT u.*, COUNT(e.update_id) AS interactions,
    COALESCE(SUM(e.is_schedule), 0) AS schedules,
    SUM(CASE WHEN e.day = ? THEN 1 ELSE 0 END) AS interactions_today,
    SUM(CASE WHEN e.day BETWEEN ? AND ? THEN 1 ELSE 0 END) AS interactions_7
    FROM stats_users u JOIN stats_events e ON e.user_id = u.user_id
    WHERE u.user_id != ? GROUP BY u.user_id
    ORDER BY interactions DESC, u.user_id ASC LIMIT ? OFFSET ?`)
    .bind(today, addDays(today, -6), today, admin, PAGE_SIZE, page * PAGE_SIZE).all();
  return { users: result.results, total, page, lastPage, pageSize: PAGE_SIZE };
}

function dateTime(value) {
  if (!value) return "пока нет обращений";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function formatStatistics(report) {
  const { others: o, owner: me } = report;
  return [
    "📊 <b>Статистика Telegram-бота</b>",
    `Первое учтённое обращение: ${dateTime(report.started_at)}`,
    `Уникальных всего: ${o.users + me.users} (включая тебя)`,
    "",
    "<b>Остальные пользователи</b>",
    `Уникальных за всё время: ${o.users}`,
    `Активны сегодня / 7 дней / 30 дней: ${o.active_today} / ${o.active_7} / ${o.active_30}`,
    `Взаимодействий сегодня / 7 дней / 30 дней: ${o.interactions_today} / ${o.interactions_7} / ${o.interactions_30}`,
    `Взаимодействий всего: ${o.interactions}`,
    `Из них запросов расписания: ${o.schedules}`,
    "",
    "<b>Твои обращения отдельно</b>",
    `Взаимодействий: ${me.interactions}; запросов расписания: ${me.schedules}`,
    `Сегодня / 7 дней / 30 дней: ${me.interactions_today} / ${me.interactions_7} / ${me.interactions_30}`,
    "",
    "Дни считаются по Москве; 7 и 30 дней включают сегодня.",
    "Список пользователей: /users",
    "Просмотры старых сообщений и переходы по ссылке ВК не учитываются.",
  ].join("\n");
}

export function formatStatisticsUsers(report) {
  const lines = [
    `👥 <b>Пользователи: ${report.total}</b>`,
    "Без твоего аккаунта, по количеству взаимодействий.",
    `Страница ${report.page + 1} из ${report.lastPage + 1}`,
  ];
  for (const [index, user] of report.users.entries()) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 64);
    const username = /^[A-Za-z0-9_]{1,32}$/.test(user.username || "") ? ` (@${user.username})` : "";
    lines.push("", `${report.page * report.pageSize + index + 1}. <b>${escapeHtml(name)}</b>${escapeHtml(username)}`,
      `ID: <code>${user.user_id}</code>`,
      `Взаимодействий: ${user.interactions}; расписаний: ${user.schedules}`,
      `Сегодня: ${user.interactions_today}; за 7 дней: ${user.interactions_7}`,
      `Впервые: ${dateTime(user.first_seen)}`,
      `Последний раз: ${dateTime(user.last_seen)}`);
  }
  if (!report.users.length) lines.push("", "Других пользователей пока не зарегистрировано.");
  lines.push("", "Время московское. Имя и username — из профиля Telegram.");
  return lines.join("\n");
}

export function statisticsUsersKeyboard(report) {
  const row = [];
  if (report.page > 0) row.push({ text: "⬅️ Назад", callback_data: `stats:users:${report.page - 1}` });
  if (report.page < report.lastPage) row.push({ text: "Дальше ➡️", callback_data: `stats:users:${report.page + 1}` });
  return { inline_keyboard: row.length ? [row] : [] };
}
