import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("webhook rejects an incorrect secret before accessing the database", async () => {
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST", body: "{}",
  }), { WEBHOOK_SECRET: "test-only" }, {});
  assert.equal(response.status, 403);
});

test("webhook rejects malformed JSON and invalid update identifiers", async () => {
  for (const body of ["{", "null", "[]", "{}", '{"update_id":-1}', '{"update_id":"1"}']) {
    const response = await worker.fetch(new Request("https://example.test/webhook", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-only" }, body,
    }), { WEBHOOK_SECRET: "test-only" }, {});
    assert.equal(response.status, 400, body);
  }
});

test("duplicate updates are acknowledged without calling Telegram", async () => {
  let claimed;
  const env = { WEBHOOK_SECRET: "test-only", DB: { prepare() { return {
    bind(id) { claimed = id; return this; },
    async run() { return { meta: { changes: 0 } }; },
  }; } } };
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": "test-only" },
    body: JSON.stringify({ update_id: 42 }),
  }), env, {});
  assert.equal(claimed, 42);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true });
});
