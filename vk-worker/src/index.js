const TEST_REPLY = [
  "✅ ВК ↔ Cloudflare: сообщение получено, ответ отправлен!",
  "",
  "Это проверка связи для бота расписания БТб-3101-03-00.",
  "Расписание пока доступно в Telegram: @ScheduleBTBbot.",
  "Нажми «Проверить ещё раз», чтобы повторить тест.",
].join("\n");

function configuration(env) {
  return {
    group: /^[1-9]\d*$/.test(String(env.VK_GROUP_ID || "")),
    token: Boolean(env.VK_TOKEN),
    secret: Boolean(env.VK_CALLBACK_SECRET),
    confirmation: Boolean(env.VK_CONFIRMATION_CODE),
  };
}

// A repeat delivery must use the same random_id so VK can suppress duplicates.
export function replyRandomId(update) {
  const message = update.object.message;
  const key = JSON.stringify([
    update.group_id,
    message.peer_id,
    message.conversation_message_id ?? message.id ?? update.event_id,
  ]);
  let hash = 2166136261;
  for (const character of key) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

async function sendTestReply(env, update, fetchImpl) {
  const body = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: env.VK_API_VERSION || "5.199",
    peer_id: String(update.object.message.peer_id),
    random_id: String(replyRandomId(update)),
    message: TEST_REPLY,
    keyboard: JSON.stringify({
      one_time: false,
      buttons: [[{
        action: { type: "text", label: "Проверить ещё раз" },
        color: "primary",
      }]],
    }),
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
}

export async function handleRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const config = configuration(env);
  if (request.method === "GET" && url.pathname === "/health") {
    const ready = Object.values(config).every(Boolean);
    return Response.json({
      ok: ready,
      service: "vyatsu-schedule-vk-bot",
      stage: "connection-test",
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
  // This test is only for incoming personal messages, not chat conversations.
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
    await sendTestReply(env, update, options.fetchImpl || fetch);
    return new Response("ok");
  } catch (error) {
    const logError = options.logError || console.error;
    // Never print incoming messages, user IDs, tokens, or raw VK errors.
    logError("VK connection test failed", /^VK (HTTP \d+|API \d+|invalid response)$/.test(error.message)
      ? error.message : "Network, timeout or response decoding error");
    return new Response("VK delivery failed", { status: 502 });
  }
}

export default { fetch: handleRequest };
