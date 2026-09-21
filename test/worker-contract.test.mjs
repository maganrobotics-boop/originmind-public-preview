import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.mjs";
import { handleRequest } from "../src/app.mjs";
import {
  createPasswordRecord,
  encryptSecret,
} from "../src/crypto.mjs";
import { WORKERS_AI_MODEL } from "../src/constants.mjs";
import { MockD1, mockAssets } from "./contract-mock-d1.mjs";

const ORIGIN = "https://chat.omindos.ai";
const OA_URL = "https://oa.omindos.ai/api/public/lab-ai/retrieve";
const OA_STATUS_URL = "https://oa.omindos.ai/api/public/lab-ai/status";
const SERVICE_TOKEN = "A".repeat(43);
const RELEASE_ID = `${"a".repeat(40)}-1`;
const ENCRYPTION_KEY = "encryption-key-for-tests-only-0123456789abcdef";
const RATE_LIMIT_HMAC_KEY = "rate-limit-key-for-tests-only-0123456789abcdef";

const OA_CHUNKS = Object.freeze([
  {
    id: "1",
    title: "ARTS Robotics 公开研究方向",
    category: "research",
    sectionTitle: "研究方向",
    paragraphRef: "第 1 段",
    excerpt: "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。",
    sourceLabel: "OA 公开知识",
    updatedAt: "2026-09-11",
  },
]);

function oaRuntime(chunks = OA_CHUNKS, externalFetch = null) {
  return {
    async fetch(url, init) {
      if (String(url) === OA_URL) {
        return Response.json({ chunks }, { headers: { "Content-Type": "application/json" } });
      }
      if (String(url) === OA_STATUS_URL) {
        return Response.json(
          { oaReady: true, publicKnowledgeReady: chunks.length > 0, retrievalReady: true },
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (externalFetch) return externalFetch(url, init);
      throw new Error(`Unexpected external fetch: ${url}`);
    },
  };
}

function environment(overrides = {}) {
  return {
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.com",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_LIMIT_HMAC_KEY,
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID,
    DB: new MockD1(),
    ASSETS: mockAssets(),
    ...overrides,
  };
}

function request(path, { method = "GET", body, cookie, origin = ORIGIN, ip = "203.0.113.9" } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (origin !== null) headers.set("Origin", origin);
  if (cookie) headers.set("Cookie", cookie);
  if (ip) headers.set("CF-Connecting-IP", ip);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function chatBody(question, messages = null) {
  return {
    topic: "research",
    messages: messages ?? [{ role: "user", content: question }],
  };
}

async function body(response) {
  return response.json();
}

async function bailianDatabase() {
  const encryptedKey = await encryptSecret("test-bailian-api-key", ENCRYPTION_KEY);
  return new MockD1({
    settings: {
      model: JSON.stringify({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        encryptedKey,
        verifiedAt: "2026-09-11T00:00:00.000Z",
      }),
    },
  });
}

async function login(env, password) {
  const response = await handleRequest(
    request("/api/auth/login", { method: "POST", body: { password } }),
    env,
    {},
    oaRuntime(),
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  return { response, cookie };
}

test("saving a verified model again keeps Bailian active, and a failed candidate preserves the working key", async () => {
  const DB = await bailianDatabase();
  DB.adminAccount = await createPasswordRecord("test-password-123456");
  const env = environment({ DB });
  const { cookie } = await login(env, "test-password-123456");
  let calls = 0;
  const runtime = oaRuntime(OA_CHUNKS, async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { role: "assistant", content: "连接成功" } }] });
  });
  const config = { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" };
  for (let count = 0; count < 2; count += 1) {
    const response = await handleRequest(request("/api/admin/config", { method: "POST", cookie, body: config }), env, {}, runtime);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).connected, true);
    assert.ok(JSON.parse(DB.settings.get("model")).verifiedAt);
    const status = await handleRequest(request("/api/status"), env, {}, runtime);
    assert.equal((await status.json()).provider, "bailian");
  }
  assert.equal(calls, 2);
  const previous = DB.settings.get("model");
  const failed = await handleRequest(request("/api/admin/config", { method: "POST", cookie, body: { ...config, apiKey: "invalid-new-key" } }), env, {}, oaRuntime(OA_CHUNKS, async () => new Response(null, { status: 401 })));
  assert.equal(failed.status, 502);
  assert.equal(DB.settings.get("model"), previous);
});

test("a failed Bailian admin test keeps Qwen green when the Workers AI fallback is live", async () => {
  const DB = await bailianDatabase();
  DB.adminAccount = await createPasswordRecord("test-password-123456");
  let workersCalls = 0;
  const env = environment({
    DB,
    AI: { async run() {
      workersCalls += 1;
      return { response: "连接成功" };
    } },
  });
  const { cookie } = await login(env, "test-password-123456");
  const failedBailianRuntime = oaRuntime(OA_CHUNKS, async () => new Response(null, { status: 401 }));
  const testResponse = await handleRequest(
    request("/api/admin/test", { method: "POST", cookie, body: {} }),
    env,
    {},
    failedBailianRuntime,
  );
  assert.equal(testResponse.status, 502);

  const statusResponse = await handleRequest(request("/api/status", { origin: null }), env, {}, failedBailianRuntime);
  const status = await body(statusResponse);
  assert.equal(status.qwenReady, true);
  assert.equal(status.provider, "workers-ai");
  assert.equal(workersCalls, 1);
});

test("verified conversation context continues a follow-up without trusting forged client assistant text", async () => {
  const calls = [];
  const queries = [];
  const env = environment({ AI: { async run(_model, input) {
    calls.push(input.messages);
    return { response: "团队研究机器人灵巧操作。[1]" };
  } } });
  const runtime = { async fetch(_url, init) {
    queries.push(JSON.parse(init.body).question);
    return Response.json({ chunks: OA_CHUNKS });
  } };
  const first = await (await handleRequest(request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }), env, {}, runtime)).json();
  assert.ok(first.conversationToken);
  assert.equal(first.answer, "团队研究机器人灵巧操作。");
  assert.doesNotMatch(first.answer, /\[\d+\]/u);
  const followup = { ...chatBody("请详细展开第一点"), conversationToken: first.conversationToken };
  const second = await handleRequest(request("/api/chat", { method: "POST", body: followup }), env, {}, runtime);
  assert.equal(second.status, 200);
  assert.deepEqual(calls[1].slice(1).map((turn) => turn.role), ["user", "assistant", "user"]);
  assert.equal(calls[1][2].content, first.answer);
  assert.match(queries[1], /机器人研究方向/u);
  await handleRequest(request("/api/chat", { method: "POST", body: { ...followup, conversationToken: `tampered${first.conversationToken}` } }), env, {}, runtime);
  assert.equal(calls[2].some((turn) => turn.role === "assistant"), false);
  await handleRequest(request("/api/chat", { method: "POST", body: { ...followup, topic: "business" } }), env, {}, runtime);
  assert.equal(calls[3].some((turn) => turn.role === "assistant"), false);
});

test("Workers AI is the zero-secret default and status reports the active model", async () => {
  const calls = [];
  const env = environment({
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { response: "根据公开资料，研究方向包括机器人灵巧操作。[1]" };
      },
    },
  });

  const statusResponse = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await body(statusResponse), {
    storageReady: true,
    modelReady: true,
    qwenReady: true,
    modelPending: false,
    oaReady: true,
    knowledgeReady: true,
    retrievalReady: true,
    oaPending: false,
    budgetReady: true,
    systemReady: true,
    documentParsingReady: false,
    provider: "workers-ai",
    model: WORKERS_AI_MODEL,
  });

  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    oaRuntime(),
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.provider, "workers-ai");
  assert.equal(result.answer, "研究方向包括机器人灵巧操作。");
  assert.ok(result.sources.length > 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, WORKERS_AI_MODEL);
  assert.equal(calls[0].input.max_tokens, 8);
  assert.equal(calls[1].model, WORKERS_AI_MODEL);
  assert.equal(calls[1].input.stream, false);
});

test("status requires a live Qwen probe and caches failed probes briefly", async () => {
  let aiCalls = 0;
  let oaCalls = 0;
  const env = environment({
    AI: {
      async run() {
        aiCalls += 1;
        throw new Error("Qwen unavailable");
      },
    },
    OA_SERVICE: {
      async fetch(boundRequest) {
        oaCalls += 1;
        return boundRequest.method === "POST"
          ? Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } })
          : Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true });
      },
    },
  });
  for (let count = 0; count < 2; count += 1) {
    const response = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
    assert.equal(response.status, 200);
    const result = await body(response);
    assert.equal(result.modelReady, false);
    assert.equal(result.qwenReady, false);
    assert.equal(result.systemReady, false);
    assert.equal(result.provider, null);
  }
  assert.equal(aiCalls, 1);
  assert.equal(oaCalls, 2);
});

test("status probe budget prevents unbounded unauthenticated model calls", async () => {
  const day = new Date().toISOString().slice(0, 10);
  let aiCalls = 0;
  const env = environment({
    DB: new MockD1({ limits: { [`model-status-day:${day}`]: 300 } }),
    AI: { async run() { aiCalls += 1; return { response: "连接成功" }; } },
  });
  const response = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.qwenReady, false);
  assert.equal(result.systemReady, false);
  assert.equal(aiCalls, 0);
});

test("Bailian failure and Workers fallback consume one aggregate status-probe budget unit", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const budgetKey = `model-status-day:${day}`;
  const DB = await bailianDatabase();
  DB.limits.set(budgetKey, { count: 299, expires: Number.MAX_SAFE_INTEGER });
  let bailianCalls = 0;
  let workersCalls = 0;
  const env = environment({
    DB,
    AI: {
      async run() {
        workersCalls += 1;
        return { response: "连接成功" };
      },
    },
  });
  const runtime = oaRuntime(OA_CHUNKS, async () => {
    bailianCalls += 1;
    return new Response(null, { status: 503 });
  });
  const budgetWrites = () => DB.statements.filter(
    ({ query, args }) => query.startsWith("insert into limits") && args[0] === budgetKey,
  );

  const response = await handleRequest(request("/api/status", { origin: null }), env, {}, runtime);
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.modelReady, true);
  assert.equal(result.qwenReady, true);
  assert.equal(result.systemReady, true);
  assert.equal(result.provider, "workers-ai");
  assert.equal(result.model, WORKERS_AI_MODEL);
  assert.equal(bailianCalls, 1);
  assert.equal(workersCalls, 1);
  assert.equal(DB.limits.get(budgetKey)?.count, 300);
  assert.equal(budgetWrites().length, 1);

  const cachedResponse = await handleRequest(request("/api/status", { origin: null }), env, {}, runtime);
  const cached = await body(cachedResponse);
  assert.equal(cached.qwenReady, true);
  assert.equal(cached.systemReady, true);
  assert.equal(cached.provider, "workers-ai");
  assert.equal(bailianCalls, 1);
  assert.equal(workersCalls, 1);
  assert.equal(DB.limits.get(budgetKey)?.count, 300);
  assert.equal(budgetWrites().length, 1);
});

test("a failed real chat reports failure without excerpts and replaces a cached green Qwen status", async () => {
  let aiCalls = 0;
  const env = environment({
    AI: {
      async run() {
        aiCalls += 1;
        if (aiCalls === 1) return { response: "连接成功" };
        throw new Error("Qwen unavailable after the probe");
      },
    },
  });
  const firstStatus = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal((await body(firstStatus)).systemReady, true);

  const failedChat = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    oaRuntime(),
  );
  assert.equal(failedChat.status, 200);
  const failedResult = await body(failedChat);
  assert.equal(failedResult.mode, "retrieval");
  assert.match(failedResult.answer, /未能生成完整答复/u);
  assert.notEqual(failedResult.answer, OA_CHUNKS[0].excerpt);
  assert.equal(failedResult.sources[0].excerpt, OA_CHUNKS[0].excerpt);
  const updatedStatus = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const result = await body(updatedStatus);
  assert.equal(result.qwenReady, false);
  assert.equal(result.systemReady, false);
  assert.equal(aiCalls, 2);
});

test("a transient OA retrieval failure does not poison the shared readiness cache", async () => {
  let retrievalAvailable = true;
  const serviceCalls = [];
  const env = environment({
    AI: { async run() { return { response: "连接成功" }; } },
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls.push({ method: boundRequest.method, url: boundRequest.url });
        if (boundRequest.url === OA_STATUS_URL) {
          return Response.json(
            { oaReady: true, publicKnowledgeReady: true, retrievalReady: true },
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (boundRequest.url === OA_URL && retrievalAvailable) {
          return Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } });
        }
        return new Response(null, { status: 503 });
      },
    },
  });

  const firstStatus = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal((await body(firstStatus)).systemReady, true);
  retrievalAvailable = false;

  const failedChat = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    oaRuntime(),
  );
  const failedChatBody = await body(failedChat);
  assert.equal(failedChat.status, 200);
  assert.equal(failedChatBody.oaPublicStatus, "unavailable");

  const updatedStatus = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const result = await body(updatedStatus);
  assert.equal(result.oaReady, true);
  assert.equal(result.knowledgeReady, true);
  assert.equal(result.retrievalReady, true);
  assert.equal(result.systemReady, true);
  assert.deepEqual(serviceCalls.map(({ method }) => method), ["GET", "POST", "POST"]);
});

test("a failed OA readiness probe is retried after the short negative-cache TTL", async () => {
  let retrievalAvailable = false;
  const serviceCalls = [];
  const DB = new MockD1();
  const env = environment({
    DB,
    AI: { async run() { return { response: "连接成功" }; } },
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls.push(boundRequest.method);
        if (boundRequest.url === OA_STATUS_URL) {
          return Response.json(
            { oaReady: true, publicKnowledgeReady: true, retrievalReady: true },
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return retrievalAvailable
          ? Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } })
          : new Response(null, { status: 503 });
      },
    },
  });

  const failed = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const failedResult = await body(failed);
  assert.equal(failedResult.oaReady, true);
  assert.equal(failedResult.knowledgeReady, true);
  assert.equal(failedResult.retrievalReady, false);
  assert.deepEqual(serviceCalls, ["GET", "POST"]);

  const cached = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal((await body(cached)).retrievalReady, false);
  assert.deepEqual(serviceCalls, ["GET", "POST"]);

  const cacheEntry = [...DB.settings.entries()].find(([id]) => id.startsWith("system-status-oa-v2:"));
  assert.ok(cacheEntry);
  const record = JSON.parse(cacheEntry[1]);
  record.checkedAt -= 5_001;
  DB.settings.set(cacheEntry[0], JSON.stringify(record));
  retrievalAvailable = true;

  const recovered = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const recoveredResult = await body(recovered);
  assert.equal(recoveredResult.oaReady, true);
  assert.equal(recoveredResult.knowledgeReady, true);
  assert.equal(recoveredResult.retrievalReady, true);
  assert.equal(recoveredResult.systemReady, true);
  assert.deepEqual(serviceCalls, ["GET", "POST", "GET", "POST"]);
});

test("OA retrieval preserves actionable upstream failure classes", async (t) => {
  for (const [name, expectedStatus, response] of [
    ["authentication", "auth_error", () => new Response(null, { status: 401 })],
    ["rate limit", "rate_limited", () => new Response(null, { status: 429 })],
    ["invalid response", "invalid_response", () => Response.json({ unexpected: true })],
    ["timeout", "timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
  ]) {
    await t.test(name, async () => {
      const env = environment({
        OA_SERVICE: { async fetch() { return response(); } },
        AI: { async run() { throw new Error("model must not run"); } },
      });
      const chat = await handleRequest(
        request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
        env,
        {},
        oaRuntime(),
      );
      assert.equal(chat.status, 200);
      assert.equal((await body(chat)).oaPublicStatus, expectedStatus);
    });
  }
});

test("a one-character question does not falsely turn OA knowledge lights red", async () => {
  const env = environment({ AI: { async run() { return { response: "连接成功" }; } } });
  const initialStatus = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal((await body(initialStatus)).systemReady, true);

  const shortQuestion = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("？") }),
    env,
    {},
    oaRuntime(),
  );
  assert.equal((await body(shortQuestion)).oaPublicStatus, "invalid_question");

  const statusAfterQuestion = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  assert.equal((await body(statusAfterQuestion)).systemReady, true);
});

test("an obsolete Qwen probe cannot overwrite a newer configuration status", async () => {
  const DB = await bailianDatabase();
  const env = environment({ DB });
  let releaseFirstProbe;
  let markFirstProbeStarted;
  const firstProbeStarted = new Promise((resolve) => {
    markFirstProbeStarted = resolve;
  });
  const firstProbeResponse = new Promise((resolve) => {
    releaseFirstProbe = resolve;
  });
  const probeRuntime = oaRuntime(OA_CHUNKS, async (_url, init) => {
    if (new Headers(init.headers).get("authorization") === "Bearer test-bailian-api-key") {
      markFirstProbeStarted();
      return firstProbeResponse;
    }
    return new Response(null, { status: 401 });
  });

  const obsoleteRequest = handleRequest(request("/api/status", { origin: null }), env, {}, probeRuntime);
  await firstProbeStarted;
  DB.settings.set("model", JSON.stringify({
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    encryptedKey: await encryptSecret("new-invalid-key", ENCRYPTION_KEY),
    verifiedAt: "2026-09-12T00:00:00.000Z",
  }));
  const currentResponse = await handleRequest(request("/api/status", { origin: null }), env, {}, probeRuntime);
  assert.equal((await body(currentResponse)).qwenReady, false);

  releaseFirstProbe(Response.json({ choices: [{ message: { role: "assistant", content: "连接成功" } }] }));
  const obsoleteResponse = await obsoleteRequest;
  assert.equal((await body(obsoleteResponse)).qwenReady, true);
  const finalResponse = await handleRequest(request("/api/status", { origin: null }), env, {}, probeRuntime);
  assert.equal((await body(finalResponse)).qwenReady, false);
  const cachedRecords = [...DB.settings]
    .filter(([key]) => key.startsWith("system-status-model-v1:"))
    .map(([, value]) => JSON.parse(value));
  assert.equal(cachedRecords.some((record) => record.result.ready === false), true);
});

test("status rejects cache-busting query parameters before probing dependencies", async () => {
  let calls = 0;
  const env = environment({
    AI: { async run() { calls += 1; return { response: "连接成功" }; } },
    OA_SERVICE: { async fetch() { calls += 1; return Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true }); } },
  });
  const response = await handleRequest(request("/api/status?refresh=1", { origin: null }), env, {}, oaRuntime());
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("the aggregate system light turns off when the daily AI budget is exhausted", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const env = environment({
    DB: new MockD1({ limits: { [`model-day:${day}`]: { count: 300, expires: Number.MAX_SAFE_INTEGER } } }),
    AI: { async run() { return { response: "连接成功" }; } },
  });
  const response = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const result = await body(response);
  assert.equal(result.qwenReady, true);
  assert.equal(result.oaReady, true);
  assert.equal(result.knowledgeReady, true);
  assert.equal(result.budgetReady, false);
  assert.equal(result.systemReady, false);
});

test("the aggregate system light turns off while OA retrieval capacity is exhausted", async () => {
  const env = environment({
    AI: { async run() { return { response: "连接成功" }; } },
    OA_SERVICE: {
      async fetch() {
        return Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: false });
      },
    },
  });
  const response = await handleRequest(request("/api/status", { origin: null }), env, {}, oaRuntime());
  const result = await body(response);
  assert.equal(result.oaReady, true);
  assert.equal(result.knowledgeReady, true);
  assert.equal(result.retrievalReady, false);
  assert.equal(result.systemReady, false);
});

test("five-light status uses the authenticated OA Service Binding without exposing its token", async () => {
  const serviceCalls = [];
  const env = environment({
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls.push(boundRequest.clone());
        if (boundRequest.url === OA_STATUS_URL && boundRequest.method === "GET") {
          return Response.json(
            { oaReady: true, publicKnowledgeReady: true, retrievalReady: true },
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (boundRequest.url === OA_URL && boundRequest.method === "POST") {
          return Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } });
        }
        return new Response(null, { status: 404 });
      },
    },
    AI: { async run() { return { response: "unused" }; } },
  });
  const response = await handleRequest(request("/api/status", { origin: null }), env, {}, {
    async fetch() {
      throw new Error("The public network fallback must not run when OA_SERVICE is bound");
    },
  });
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.oaReady, true);
  assert.equal(result.knowledgeReady, true);
  assert.equal(result.qwenReady, true);
  assert.equal(result.systemReady, true);
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(serviceCalls.length, 2);
  assert.deepEqual(serviceCalls.map((boundRequest) => [boundRequest.url, boundRequest.method]), [
    [OA_STATUS_URL, "GET"],
    [OA_URL, "POST"],
  ]);
  for (const boundRequest of serviceCalls) {
    assert.equal(boundRequest.headers.get("x-originmind-public-lab-ai-service-token"), SERVICE_TOKEN);
    assert.equal(boundRequest.headers.has("cookie"), false);
    assert.equal(boundRequest.headers.has("authorization"), false);
  }
  assert.deepEqual(await serviceCalls[1].json(), { question: "oaretrievalprobe" });
});

test("OA Service Binding is preferred and preserves the hardened request", async () => {
  const serviceCalls = [];
  let globalFetchCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls.push(boundRequest.clone());
        return Response.json({ chunks: OA_CHUNKS }, { headers: { "Content-Type": "application/json" } });
      },
    },
    AI: {
      async run() {
        return { response: "根据公开资料，研究方向包括机器人灵巧操作。[1]" };
      },
    },
  });
  const runtime = {
    async fetch() {
      globalFetchCalls += 1;
      throw new Error("The global OA fetch fallback must not run when OA_SERVICE is bound");
    },
  };
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向有哪些？") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.oaPublicStatus, "connected");
  assert.equal(result.sources.length, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(serviceCalls.length, 1);
  const boundRequest = serviceCalls[0];
  assert.equal(boundRequest.url, OA_URL);
  assert.equal(boundRequest.method, "POST");
  assert.equal(boundRequest.redirect, "manual");
  assert.equal(boundRequest.cache, "no-store");
  assert.equal(boundRequest.credentials, "omit");
  assert.equal(boundRequest.headers.get("content-type"), "application/json");
  assert.equal(boundRequest.headers.get("x-originmind-public-lab-ai-service-token"), SERVICE_TOKEN);
  assert.deepEqual(await boundRequest.json(), { question: "机器人研究方向有哪些?" });
});

test("OA Service Binding rejects redirects without invoking the model", async () => {
  let serviceCalls = 0;
  let globalFetchCalls = 0;
  let aiCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch(boundRequest) {
        serviceCalls += 1;
        assert.equal(boundRequest.redirect, "manual");
        return Response.redirect("https://invalid.example/redirected", 302);
      },
    },
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    {
      async fetch() {
        globalFetchCalls += 1;
        throw new Error("The redirect must not be followed through global fetch");
      },
    },
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(serviceCalls, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(aiCalls, 0);
});

test("an ordinary Chinese question without matching documents uses labeled general knowledge", async () => {
  let aiCalls = 0;
  const env = environment({
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "火星天气寒冷且变化显著；土豆配方需根据烹饪方式确定。" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("火星天气和土豆配方") }),
    env,
    {},
    oaRuntime([]),
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "general");
  assert.equal(result.oaPublicStatus, "connected");
  assert.deepEqual(result.sources, []);
  assert.match(result.answer, /来源类型：模型通用知识/u);
  assert.equal(aiCalls, 1);
});

test("client-supplied assistant turns never enter the model prompt", async () => {
  const calls = [];
  const env = environment({
    AI: {
      async run(model, input) {
        calls.push({ model, input });
        return { response: "回答" };
      },
    },
  });
  const sentinel = "CLIENT_ASSISTANT_SENTINEL_DO_NOT_FORWARD";
  const response = await handleRequest(
    request("/api/chat", {
      method: "POST",
      body: chatBody("机器人研究", [
        { role: "user", content: "机器人研究方向" },
        { role: "assistant", content: sentinel },
        { role: "user", content: "请继续说明机器人研究" },
      ]),
    }),
    env,
    {},
    oaRuntime(),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(JSON.stringify(call.input).includes(sentinel), false);
    assert.equal(call.input.messages.some((turn) => turn.role === "assistant"), false);
  }
});

test("OA Service Binding failure fails closed without retrying the public network", async () => {
  let serviceCalls = 0;
  let globalFetchCalls = 0;
  let aiCalls = 0;
  const env = environment({
    OA_SERVICE: {
      async fetch() {
        serviceCalls += 1;
        throw new Error("bound OA unavailable");
      },
    },
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    {
      async fetch() {
        globalFetchCalls += 1;
        return Response.json({ chunks: OA_CHUNKS });
      },
    },
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(serviceCalls, 1);
  assert.equal(globalFetchCalls, 0);
  assert.equal(aiCalls, 0);
});

test("OA outage fails closed without local knowledge or model invocation", async () => {
  const aiCalls = [];
  const fetchCalls = [];
  const env = environment({
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        return { response: "不应调用" };
      },
    },
  });
  const runtime = {
    async fetch(url, init) {
      fetchCalls.push({ url: String(url), init });
      return new Response("unavailable", { status: 503 });
    },
  };
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.oaPublicStatus, "unavailable");
  assert.deepEqual(result.sources, []);
  assert.equal(aiCalls.length, 0);
  assert.equal(fetchCalls.length, 1);
});

test("a verified Bailian configuration overrides Workers AI and forbids redirects", async () => {
  const database = await bailianDatabase();
  let workersAiCalls = 0;
  const fetchCalls = [];
  const env = environment({
    DB: database,
    AI: {
      async run() {
        workersAiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const runtime = oaRuntime(OA_CHUNKS, async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ choices: [{ message: { role: "assistant", content: "百炼回答。[1]" } }] });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.mode, "ai");
  assert.equal(result.provider, "bailian");
  assert.equal(result.answer, "百炼回答。");
  assert.equal(workersAiCalls, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.redirect, "manual");
  assert.equal(JSON.parse(fetchCalls[0].init.body).stream, false);
});

test("Bailian redirect responses fail safely without returning retrieved text without being followed", async () => {
  const env = environment({ DB: await bailianDatabase() });
  let externalCalls = 0;
  const runtime = oaRuntime(OA_CHUNKS, async (_url, init) => {
    externalCalls += 1;
    assert.equal(init.redirect, "manual");
    return Response.redirect("https://invalid.example/redirected", 302);
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.mode, "retrieval");
  assert.match(result.answer, /未能生成完整答复/u);
  assert.notEqual(result.answer, OA_CHUNKS[0].excerpt);
  assert.equal(result.sources[0].excerpt, OA_CHUNKS[0].excerpt);
  assert.equal(externalCalls, 1);
});

test("Bailian non-JSON responses fail safely without returning retrieved text", async () => {
  const env = environment({ DB: await bailianDatabase() });
  const runtime = oaRuntime(OA_CHUNKS, async () => {
      return new Response("<html>not JSON</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.mode, "retrieval");
  assert.match(result.answer, /未能生成完整答复/u);
  assert.notEqual(result.answer, OA_CHUNKS[0].excerpt);
  assert.equal(result.sources[0].excerpt, OA_CHUNKS[0].excerpt);
});

test("oversized Bailian responses fail safely without returning retrieved text", async () => {
  const env = environment({ DB: await bailianDatabase() });
  const hugeJson = JSON.stringify({ choices: [{ message: { content: "大".repeat(270 * 1024) } }] });
  const encoded = new TextEncoder().encode(hugeJson);
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += 32 * 1024) {
        controller.enqueue(encoded.slice(offset, offset + 32 * 1024));
      }
      controller.close();
    },
  });
  const runtime = oaRuntime(OA_CHUNKS, async () => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    runtime,
  );
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.mode, "retrieval");
  assert.match(result.answer, /未能生成完整答复/u);
  assert.notEqual(result.answer, OA_CHUNKS[0].excerpt);
  assert.equal(result.sources[0].excerpt, OA_CHUNKS[0].excerpt);
});

test("rate-limit identifiers depend on RATE_LIMIT_HMAC_KEY, not the encryption key", async () => {
  const firstDb = new MockD1();
  const secondDb = new MockD1();
  const first = environment({ DB: firstDb, APP_ENCRYPTION_KEY: "A".repeat(48) });
  const second = environment({ DB: secondDb, APP_ENCRYPTION_KEY: "B".repeat(48) });
  const input = { method: "POST", body: chatBody("火星天气和土豆配方"), ip: "2001:db8::7" };
  const firstResponse = await handleRequest(request("/api/chat", input), first, {}, oaRuntime([]));
  const secondResponse = await handleRequest(request("/api/chat", input), second, {}, oaRuntime([]));
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const firstKey = firstDb.limitKey("chat:");
  const secondKey = secondDb.limitKey("chat:");
  assert.ok(firstKey);
  assert.equal(firstKey, secondKey);
});

test("global daily budget blocks the 301st model call with its dedicated response", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const database = new MockD1({ limits: { [`model-day:${day}`]: 300 } });
  let aiCalls = 0;
  const env = environment({
    DB: database,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const response = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("机器人研究方向") }),
    env,
    {},
    oaRuntime(),
  );
  const result = await body(response);
  assert.equal(response.status, 429);
  assert.equal(result.error, "今日 AI 咨询额度已用完，请稍后再试。");
  assert.equal(aiCalls, 0);
});

test("admin authentication is same-origin, cookie-based, and required for admin APIs", async () => {
  const password = "correct horse battery staple";
  const database = new MockD1({ adminAccount: await createPasswordRecord(password) });
  const env = environment({ DB: database });

  const anonymous = await handleRequest(request("/api/admin/config", { origin: null }), env, {});
  assert.equal(anonymous.status, 403);

  const crossOrigin = await handleRequest(
    request("/api/auth/login", { method: "POST", body: { password }, origin: "https://evil.example" }),
    env,
    {},
    oaRuntime([]),
  );
  assert.equal(crossOrigin.status, 403);

  const wrongPassword = await handleRequest(
    request("/api/auth/login", { method: "POST", body: { password: "definitely not the administrator password" } }),
    env,
    {},
    oaRuntime([]),
  );
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await body(wrongPassword), { error: "密码不正确" });

  const { response: loginResponse, cookie } = await login(env, password);
  assert.equal(loginResponse.status, 200);
  assert.ok(cookie?.startsWith("__Host-ma-session="));
  assert.match(loginResponse.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Strict/u);

  const status = await handleRequest(request("/api/auth/status", { cookie, origin: null }), env, {});
  assert.deepEqual(await body(status), { signedIn: true });
  const admin = await handleRequest(request("/api/admin/config", { cookie, origin: null }), env, {});
  assert.equal(admin.status, 200);
});

test("Chat admin documents cannot become public knowledge without OA review", async () => {
  const password = "correct horse battery staple";
  const database = new MockD1({
    adminAccount: await createPasswordRecord(password),
    documents: [{
      id: "historic-published-row",
      title: "历史错误公开行",
      body: "这条历史 published=1 的 Chat D1 资料绝不能进入公网回答。",
      url: "",
      category: "research",
      updatedAt: "2026-09-11",
      published: 1,
    }],
  });
  let aiCalls = 0;
  const env = environment({
    DB: database,
    AI: {
      async run() {
        aiCalls += 1;
        return { response: "不应调用" };
      },
    },
  });
  const { response: loginResponse, cookie } = await login(env, password);
  assert.equal(loginResponse.status, 200);

  const documentResponse = await handleRequest(
    request("/api/admin/documents", {
      method: "POST",
      cookie,
      body: {
        id: "private-only-review",
        title: "锆蓝实验 4829",
        body: "锆蓝实验 4829 是仅供内部审核的占位资料，不得直接公开。",
        url: "",
        category: "research",
        updatedAt: "2026-09-11",
        published: 1,
      },
    }),
    env,
    {},
  );
  assert.ok([200, 400, 403].includes(documentResponse.status));
  const stored = database.documents.get("private-only-review");
  assert.notEqual(stored?.published, 1);

  const publicResponse = await handleRequest(
    request("/api/chat", { method: "POST", body: chatBody("锆蓝实验 4829") }),
    env,
    {},
    oaRuntime([]),
  );
  const publicResult = await body(publicResponse);
  assert.equal(publicResult.mode, "retrieval");
  assert.equal(publicResult.sources.some((source) => source.id === "private-only-review"), false);
  assert.equal(publicResult.sources.some((source) => source.id === "historic-published-row"), false);
  assert.equal(aiCalls, 0);
});

test("public health stays ready before an admin account is initialized", async () => {
  const env = environment({ DB: new MockD1({ adminAccount: null }) });
  const response = await handleRequest(request("/_health", { origin: null }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId: RELEASE_ID,
  });
});

test("static topic links, PWA files, root, manager and generated hashed assets use ASSETS", async () => {
  const assets = mockAssets();
  const env = environment({ ASSETS: assets });
  const paths = [
    "/",
    "/technology",
    "/research",
    "/originmind",
    "/ius",
    "/manage",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/assets/app-0123456789abcdef.js",
    "/assets/pwa/icon-192-v1.png",
  ];
  for (const path of paths) {
    const response = await worker.fetch(request(path, { origin: null }), env, {});
    assert.equal(response.status, 200, path);
  }
  assert.deepEqual(assets.calls, [
    "/index.html",
    "/index.html",
    "/index.html",
    "/index.html",
    "/index.html",
    "/index.html",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/assets/app-0123456789abcdef.js",
    "/assets/pwa/icon-192-v1.png",
  ]);
});

test("wrong canonical host is rejected before API or static handling", async () => {
  const database = new MockD1();
  const assets = mockAssets();
  const env = environment({ DB: database, ASSETS: assets });
  for (const path of ["/", "/api/status"]) {
    const response = await worker.fetch(new Request(`https://evil.example${path}`), env, {});
    assert.equal(response.status, 421, path);
  }
  assert.deepEqual(assets.calls, []);
  assert.equal(database.statements.length, 0);
});
