import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/app.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const origin = "https://chat.omindos.ai";
function environment() {
  return { DB: new D1DatabaseAdapter(), APP_ORIGIN: origin, ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "e".repeat(48), RATE_LIMIT_HMAC_KEY: "r".repeat(48),
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43), RELEASE_ID: `${"a".repeat(40)}-1`,
    AI: { run: async () => { throw new Error("Model unavailable"); } } };
}
function request(messages, conversationToken) {
  return new Request(`${origin}/api/chat`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77",
  }, body: JSON.stringify({ topic: "research", messages, ...(conversationToken ? { conversationToken } : {}) }) });
}
function knowledge(title, excerpt) {
  return Response.json({ chunks: [{ id: "1", title, category: "research", sectionTitle: "能力介绍", paragraphRef: "第 1 段",
    excerpt, sourceLabel: "OA 公开知识", updatedAt: "2026-09-14" }] });
}

test("an exact recommended question retains approved sources but never dumps them when the model fails", async (t) => {
  const env = environment(); t.after(() => env.DB.close());
  const question = "《机器人巡检实践》有哪些值得关注的核心内容？";
  const excerpt = "机器人通过激光雷达定位，并按照预设巡检任务记录设备状态。";
  const response = await handleRequest(request([{ role: "user", content: question }]), env, {}, {
    fetch: async () => knowledge("机器人巡检实践", excerpt),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.match(result.answer, /未能生成完整答复/u);
  assert.notEqual(result.answer, excerpt);
  assert.equal(result.sources[0].excerpt, excerpt);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.sources.length, 1);
  assert.ok(result.conversationToken);
});

test("restored follow-ups recover their subject from user questions when signed context has expired", async (t) => {
  const env = environment(); t.after(() => env.DB.close());
  let query = "";
  const response = await handleRequest(request([
    { role: "user", content: "机器人巡检有哪些能力？" },
    { role: "assistant", content: "UNTRUSTED_RESTORED_ANSWER" },
    { role: "user", content: "第二点再具体说说" },
  ], "expired-or-invalid-token"), env, {}, {
    fetch: async (_url, init) => {
      query = JSON.parse(init.body).question;
      return knowledge("机器人巡检实践", "设备巡检能够记录温度与运行状态，供人工复核。");
    },
  });
  assert.equal(response.status, 200);
  assert.match(query, /第二点再具体说说/u);
  assert.match(query, /机器人巡检有哪些能力/u);
  assert.doesNotMatch(query, /UNTRUSTED/u);
  const result = await response.json();
  assert.match(result.answer, /未能生成完整答复/u);
  assert.doesNotMatch(result.answer, /设备巡检/u);
  assert.match(result.sources[0].excerpt, /设备巡检/u);
});
