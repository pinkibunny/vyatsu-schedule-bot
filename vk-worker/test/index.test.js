import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, replyRandomId } from "../src/index.js";

const env = {
  VK_GROUP_ID: "242581427",
  VK_TOKEN: "test-token",
  VK_CALLBACK_SECRET: "test-secret",
  VK_CONFIRMATION_CODE: "test-confirmation",
};

function event(overrides = {}) {
  return {
    type: "message_new",
    group_id: 242581427,
    secret: "test-secret",
    event_id: "event-1",
    object: { message: { id: 10, conversation_message_id: 5, peer_id: 123, from_id: 123, out: 0, text: "тест" } },
    ...overrides,
  };
}

function request(update) {
  return new Request("https://example.test/vk", {
    method: "POST",
    body: JSON.stringify(update),
  });
}

test("confirmation returns the exact code without a VK API call", async () => {
  const response = await handleRequest(request(event({ type: "confirmation" })), env, {
    fetchImpl: () => assert.fail("confirmation must not call VK"),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "test-confirmation");
});

test("invalid secret, wrong group, and unconfigured callback are rejected", async () => {
  for (const update of [event({ secret: "wrong" }), event({ group_id: 1 })]) {
    assert.equal((await handleRequest(request(update), env)).status, 403);
  }
  assert.equal((await handleRequest(request(event()), { ...env, VK_CALLBACK_SECRET: "" })).status, 503);
  const malformed = new Request("https://example.test/vk", { method: "POST", body: "{" });
  assert.equal((await handleRequest(malformed, env)).status, 400);
});

test("private message receives a test reply and a repeat button", async () => {
  let calls = 0;
  const response = await handleRequest(request(event()), env, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.vk.com/method/messages.send");
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("access_token"), "test-token");
      assert.equal(options.body.get("peer_id"), "123");
      assert.equal(options.body.get("random_id"), String(replyRandomId(event())));
      assert.match(options.body.get("message"), /ВК ↔ Cloudflare/);
      const keyboard = JSON.parse(options.body.get("keyboard"));
      assert.equal(keyboard.buttons[0][0].action.type, "text");
      return Response.json({ response: 100 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(await response.text(), "ok");
});

test("redelivery keeps the deduplication ID and new messages change it", () => {
  assert.equal(replyRandomId(event()), replyRandomId(event({ event_id: "redelivery" })));
  const next = event();
  next.object.message.conversation_message_id += 1;
  assert.notEqual(replyRandomId(event()), replyRandomId(next));
  assert.ok(replyRandomId(event()) > 0);
});

test("outgoing messages, group chats and other event types do not send replies", async () => {
  const outgoing = event();
  outgoing.object.message.out = 1;
  const chat = event();
  chat.object.message.peer_id = 2000000001;
  for (const update of [outgoing, chat, event({ type: "message_reply" })]) {
    const response = await handleRequest(request(update), env, {
      fetchImpl: () => assert.fail("ignored event must not call VK"),
    });
    assert.equal(await response.text(), "ok");
  }
});

test("VK rejects delivery: report failure for retry without leaking secrets", async () => {
  const errors = [];
  const response = await handleRequest(request(event()), env, {
    fetchImpl: async () => Response.json({
      error: { error_code: 5, request_params: [{ key: "access_token", value: "test-token" }] },
    }),
    logError: (...values) => errors.push(values),
  });
  assert.equal(response.status, 502);
  assert.match(JSON.stringify(errors), /VK API 5/);
  assert.doesNotMatch(JSON.stringify(errors), /test-token|test-secret|request_params/);
});

test("network failures and invalid JSON from VK are retryable failures", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("request containing test-token failed"); },
    async () => new Response("bad gateway", { status: 502 }),
    async () => new Response("<html>unexpected page</html>"),
  ]) {
    const response = await handleRequest(request(event()), env, { fetchImpl, logError: () => {} });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /test-token/);
  }
});

test("health reports configuration only and never calls the VK API", async () => {
  const req = new Request("https://example.test/health");
  const response = await handleRequest(req, env);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /test-token|test-secret|test-confirmation/);
  assert.equal((await handleRequest(req, { ...env, VK_TOKEN: "" })).status, 503);
});
