import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleRequest } from "../src/app.mjs";
import { WORKERS_AI_MODEL } from "../src/constants.mjs";
import { encryptSecret, sha256Hex } from "../src/crypto.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const SERVICE_TOKEN = "A".repeat(43);
const RELEASE_ID = `${"a".repeat(40)}-1`;

function emptyOaResponse() {
  return Response.json({ chunks: [] }, { headers: { "Content-Type": "application/json" } });
}

function oaResponse() {
  return Response.json({
    chunks: [{
      id: "1",
      title: "ARTS Robotics 公开研究方向",
      category: "research",
      sectionTitle: "研究方向",
      paragraphRef: "第 1 段",
      excerpt: "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。",
      sourceLabel: "OA 公开知识",
      updatedAt: "2026-09-11",
    }],
  }, { headers: { "Content-Type": "application/json" } });
}

function makeEnvironment(overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(),
    AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: "AI 回答" } }] }) },
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID,
    ...overrides,
  };
}

function runtime(fetch = async (url) => String(url).endsWith("/api/public/lab-ai/status")
  ? Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true })
  : oaResponse()) {
  return { fetch };
}

function apiRequest(path, { method = "GET", body, cookie, origin = ORIGIN, ip = "203.0.113.8" } = {}) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", origin);
  }
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadRequest(name, mimeType, bytes, {
  cookie,
  origin = ORIGIN,
  ip = "203.0.113.8",
} = {}) {
  const headers = new Headers({
    "CF-Connecting-IP": ip,
    "Content-Type": mimeType,
    "Origin": origin,
    "X-File-Name": encodeURIComponent(name),
  });
  if (cookie) headers.set("Cookie", cookie);
  return new Request(`${ORIGIN}/api/admin/extract`, {
    method: "POST",
    headers,
    body: bytes,
  });
}

function pdfBytes() {
  return new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

function assertChatServerTiming(response) {
  const value = response.headers.get("server-timing");
  assert.match(value, /^oa;dur=\d+, model;dur=\d+, total;dur=\d+$/u);
  const timings = Object.fromEntries(
    value.split(", ").map((entry) => {
      const [name, rawDuration] = entry.split(";dur=");
      return [name, Number(rawDuration)];
    }),
  );
  assert.ok(timings.total >= timings.oa + timings.model);
  return timings;
}

async function storeVerifiedBailianConfig(env, credential = "test-key-not-a-real-secret") {
  const value = {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    encryptedKey: await encryptSecret(credential, env.APP_ENCRYPTION_KEY),
    verifiedAt: "2026-09-11T00:00:00.000Z",
  };
  await env.DB.prepare("INSERT INTO settings(id,value) VALUES (?,?)").bind("model", JSON.stringify(value)).run();
}

test("Worker source contains no Tencent/Node runtime shell", () => {
  const sources = readdirSync(new URL("../src/", import.meta.url))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /from ["']node:/u);
  assert.doesNotMatch(sources, /\b(?:createServer|DatabaseSync|AsyncLocalStorage|systemd|nginx)\b/u);
  assert.doesNotMatch(sources, /\b(?:process|Buffer)\./u);
});

test("health reports D1 service readiness without leaking or requiring an admin row", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const result = await responseJson(await handleRequest(apiRequest("/_health"), env, {}, runtime()));
  assert.deepEqual(result, {
    status: 200,
    body: { app: "arts-robotics-ai-assistant", ready: true, releaseId: RELEASE_ID },
  });
  assert.equal(Object.hasOwn(result.body, "adminReady"), false);
});

test("status marks Workers AI as the default ready provider without a Bailian key", async (t) => {
  let aiCalls = 0;
  let oaCalls = 0;
  const env = makeEnvironment({
    AI: { run: async () => {
      aiCalls += 1;
      return { choices: [{ message: { role: "assistant", content: "连接成功" } }] };
    } },
  });
  t.after(() => env.DB.close());
  const statusRuntime = runtime(async (url) => {
    if (String(url).endsWith("/api/public/lab-ai/status")) {
      oaCalls += 1;
      return Response.json({ oaReady: true, publicKnowledgeReady: true, retrievalReady: true });
    }
    return oaResponse();
  });
  const result = await responseJson(await handleRequest(apiRequest("/api/status"), env, {}, statusRuntime));
  assert.deepEqual(result, {
    status: 200,
    body: {
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
    },
  });
  const cached = await responseJson(await handleRequest(apiRequest("/api/status"), env, {}, statusRuntime));
  assert.deepEqual(cached, result);
  assert.equal(aiCalls, 1);
  assert.equal(oaCalls, 1);
});

test("auth preserves public error status without exposing unknown failures", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const crossOrigin = apiRequest("/api/auth/login", {
    method: "POST",
    origin: "https://attacker.example",
    body: { password: "incorrect-password" },
  });
  const forbidden = await responseJson(await handleRequest(crossOrigin, env, {}, runtime()));
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error, /本站页面/u);

  const noAdmin = apiRequest("/api/auth/login", {
    method: "POST",
    body: { password: "incorrect-password" },
  });
  const unavailable = await responseJson(await handleRequest(noAdmin, env, {}, runtime()));
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /尚未设置/u);
});

test("zero retrieved documents returns retrieval fallback and never invokes a model", async (t) => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => { calls += 1; throw new Error("must not run"); } } });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "zzzz-no-match" }], topic: "research" },
  });
  const response = await handleRequest(request, env, {}, runtime(async () => emptyOaResponse()));
  const timings = assertChatServerTiming(response);
  const result = await responseJson(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "retrieval");
  assert.equal(result.body.sources.length, 0);
  assert.equal(calls, 0);
  assert.equal(timings.model, 0);
});

test("Workers AI gets only two bounded user turns and never client assistant text", async (t) => {
  let captured;
  const env = makeEnvironment({
    AI: {
      run: async (model, input) => {
        captured = { model, input };
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "根据公开资料显示，团队主要研究机器人灵巧操作。[1]\n\n参考资料：\n[1] 公开知识",
            },
          }],
        };
      },
    },
  });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: {
      messages: [
        { role: "user", content: "研".repeat(12_000) },
        { role: "assistant", content: "CLIENT_ASSISTANT_MUST_NOT_REACH_MODEL" },
        { role: "user", content: "研究方向是什么？" },
      ],
      topic: "research",
    },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "ai");
  assert.equal(result.body.provider, "workers-ai");
  assert.equal(result.body.answer, "团队主要研究机器人灵巧操作。");
  assert.equal(captured.model, WORKERS_AI_MODEL);
  assert.equal(captured.input.stream, false);
  assert.equal(captured.input.max_tokens, 2_400);
  const nonSystem = captured.input.messages.slice(1);
  assert.ok(nonSystem.length <= 2);
  assert.ok(nonSystem.every((message) => message.role === "user"));
  assert.ok(nonSystem.reduce((sum, message) => sum + message.content.length, 0) <= 3_000);
  assert.doesNotMatch(JSON.stringify(captured.input), /CLIENT_ASSISTANT_MUST_NOT_REACH_MODEL/u);
  assert.match(captured.input.messages[0].content, /OriginMind × ARTS Robotics 研发与对外咨询助手/u);
  assert.match(captured.input.messages[0].content, /先给结论/u);
  assert.match(captured.input.messages[0].content, /严格区分 OriginMind、ARTS Robotics 与联合研发材料/u);
  assert.match(captured.input.messages[0].content, /不把计划说成已完成/u);
  assert.match(captured.input.messages[0].content, /目前知识库没有找到足够依据/u);
  assert.match(captured.input.messages[0].content, /不要单列“参考资料”/u);
  const daily = await env.DB.prepare("SELECT count FROM limits WHERE key LIKE 'model-day:%'").first();
  assert.equal(Number(daily.count), 1);
});

test("user-visible answers remove citation markers and formatted reference sections", async () => {
  const examples = [
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n**参考资料**\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1] 参考资料：[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n### 参考来源\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\nReferences:\n[1] OA public knowledge",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "第一项是机器人灵巧操作[1]。第二项是系统设计。[1]",
      expected: "第一项是机器人灵巧操作。第二项是系统设计。",
    },
    {
      output: "机器人灵巧操作。[1，1] 系统设计。【１—１】",
      expected: "机器人灵巧操作。 系统设计。",
    },
    {
      output: "根据资料不足，我们建议先补充问题背景。[1]",
      expected: "根据资料不足，我们建议先补充问题背景。",
    },
    {
      output: "据资料库记录，团队研究机器人灵巧操作。[1]",
      expected: "据资料库记录，团队研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n- **参考资料**\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n1. 参考资料：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考资料列表：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考资料如下所示：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n> 参考资料\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nBibliography:\n[1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n参考：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n出处：\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nCitation:\n[1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "Team focuses on robotic manipulation.[1]\n\nSources [1] OA public knowledge",
      expected: "Team focuses on robotic manipulation.",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n[1] OA 公开知识\n[1] 第二条公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n\n• [1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "团队主要研究机器人灵巧操作。[1]\n[1] OA 公开知识",
      expected: "团队主要研究机器人灵巧操作。",
    },
    {
      output: "Available Resources: robotics lab and test platform.[1]",
      expected: "Available Resources: robotics lab and test platform.",
    },
    {
      output: "Preference: concise answers.[1]",
      expected: "Preference: concise answers.",
    },
    {
      output: "The project is open-source: selected components are public.[1]",
      expected: "The project is open-source: selected components are public.",
    },
  ];

  for (const example of examples) {
    const env = makeEnvironment({
      AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: example.output } }] }) },
    });
    try {
      const request = apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      });
      const result = await responseJson(await handleRequest(request, env, {}, runtime()));
      assert.equal(result.status, 200);
      assert.equal(result.body.mode, "ai");
      assert.equal(result.body.answer, example.expected);
    } finally {
      env.DB.close();
    }
  }
});

test("uncited or residual citation-shaped model output fails closed", async () => {
  for (const output of [
    "团队主要研究机器人灵巧操作。",
    "团队主要研究机器人灵巧操作。[1] 同时保留嵌套编号[[1]]",
    "团队主要研究机器人灵巧操作。[1] 同时保留异常编号[1/2]",
    "团队主要研究机器人灵巧操作。[1] 可参考资料：[1] OA 公开知识",
    "团队主要研究机器人灵巧操作。[1] 可查看**参考资料**：[1] OA 公开知识",
  ]) {
    const env = makeEnvironment({
      AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: output } }] }) },
    });
    try {
      const request = apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      });
      const result = await responseJson(await handleRequest(request, env, {}, runtime()));
      assert.equal(result.status, 200);
      assert.equal(result.body.mode, "retrieval");
      assert.doesNotMatch(result.body.answer, /\[\[\s*\d+\s*\]\]|[［【]\s*\d+\s*[］】]|参考(?:资料|文献|来源)/u);
    } finally {
      env.DB.close();
    }
  }
});

test("unsafe or uncited model output is discarded before it reaches the browser", async (t) => {
  const unsafe = "请访问 https://example.test 或联系 test@example.test [1]";
  const env = makeEnvironment({
    AI: { run: async () => ({ choices: [{ message: { role: "assistant", content: unsafe } }] }) },
  });
  t.after(() => env.DB.close());
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "retrieval");
  assert.doesNotMatch(result.body.answer, /example\.test/u);
  assert.doesNotMatch(result.body.answer, /\[\d+\]|参考(?:资料|文献)|资料来源/u);
  assert.ok(result.body.sources.length > 0);
});

test("verified Bailian config overrides Workers AI and uses hardened fetch options", async (t) => {
  let workersCalls = 0;
  let modelFetch;
  const env = makeEnvironment({ AI: { run: async () => { workersCalls += 1; } } });
  t.after(() => env.DB.close());
  await storeVerifiedBailianConfig(env);
  const externalFetch = async (url, init) => {
    if (url === "https://oa.omindos.ai/api/public/lab-ai/retrieve") return oaResponse();
    modelFetch = { url, init };
    return Response.json({ choices: [{ message: { role: "assistant", content: "百炼回答 [1]" } }] });
  };
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const response = await handleRequest(request, env, {}, runtime(externalFetch));
  assertChatServerTiming(response);
  const result = await responseJson(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "ai");
  assert.equal(result.body.provider, "bailian");
  assert.equal(result.body.answer, "百炼回答");
  assert.equal(workersCalls, 0);
  assert.equal(modelFetch.init.redirect, "manual");
  assert.equal(modelFetch.init.cache, "no-store");
  assert.equal(modelFetch.init.credentials, "omit");
  assert.equal(JSON.parse(modelFetch.init.body).stream, false);
  assert.equal(JSON.parse(modelFetch.init.body).max_tokens, 2_400);
});

test("model timing includes a failed Bailian attempt and its Workers fallback", async (t) => {
  const delay = () => new Promise((resolve) => setTimeout(resolve, 15));
  const env = makeEnvironment({
    AI: {
      run: async () => {
        await delay();
        return { choices: [{ message: { role: "assistant", content: "备用模型回答 [1]" } }] };
      },
    },
  });
  t.after(() => env.DB.close());
  await storeVerifiedBailianConfig(env);
  const externalFetch = async (url) => {
    if (url === "https://oa.omindos.ai/api/public/lab-ai/retrieve") return oaResponse();
    await delay();
    return new Response(null, { status: 503 });
  };
  const response = await handleRequest(
    apiRequest("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
    }),
    env,
    {},
    runtime(externalFetch),
  );
  const timings = assertChatServerTiming(response);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.provider, "workers-ai");
  assert.equal(result.answer, "备用模型回答");
  assert.ok(timings.model >= 20);
});

test("an oversized Bailian response fails safely without returning retrieved text", async (t) => {
  const env = makeEnvironment({ AI: undefined });
  t.after(() => env.DB.close());
  await storeVerifiedBailianConfig(env);
  const externalFetch = async (url) => {
    if (url === "https://oa.omindos.ai/api/public/lab-ai/retrieve") return oaResponse();
    const first = new Uint8Array(200 * 1024).fill(0x20);
    const second = new Uint8Array(60 * 1024).fill(0x20);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  };
  const request = apiRequest("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
  });
  const response = await handleRequest(request, env, {}, runtime(externalFetch));
  assertChatServerTiming(response);
  const result = await responseJson(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "retrieval");
  assert.match(result.body.answer, /未能生成完整答复/u);
  assert.doesNotMatch(result.body.answer, /机器人灵巧操作/u);
  assert.equal(result.body.sources[0].excerpt, "经 OA 审核公开的资料包括机器人灵巧操作与机器人系统设计。");
});

test("Chat admin cannot publish documents directly", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const token = "f".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const request = apiRequest("/api/admin/documents", {
    method: "POST",
    cookie: `__Host-ma-session=${token}`,
    body: {
      title: "待审核资料",
      body: "这是一段仍需通过 OA 审核的资料正文。",
      url: "",
      category: "research",
      updatedAt: "2026-09-11",
      published: 1,
    },
  });
  const result = await responseJson(await handleRequest(request, env, {}, runtime()));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /OA 审核/u);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first();
  assert.equal(Number(count.n), 0);
});

test("the document submission migration preserves legacy rows as unknown", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  sqlite.prepare(`
    INSERT INTO documents (id,title,body,url,category,updated_at,published)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    "legacy-document",
    "迁移前资料",
    "这是一条在 OA 提交状态字段出现前保存的历史资料。",
    "",
    "research",
    "2026-09-12",
    0,
  );

  sqlite.exec(readFileSync(new URL("../migrations/0002_document_oa_submission_state.sql", import.meta.url), "utf8"));
  const legacy = sqlite.prepare(`
    SELECT oa_submission_state AS oaSubmissionState,
           oa_item_id AS oaItemId,
           oa_submitted_at AS oaSubmittedAt,
           draft_revision AS draftRevision
    FROM documents WHERE id = ?
  `).get("legacy-document");

  assert.deepEqual({ ...legacy }, {
    oaSubmissionState: "unknown",
    oaItemId: null,
    oaSubmittedAt: null,
    draftRevision: 1,
  });
});

test("Chat document OA submission state persists across refresh and is CAS protected", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const token = "8".repeat(64);
  const cookie = `__Host-ma-session=${token}`;
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const created = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "POST",
    cookie,
    body: {
      title: "OA 状态持久化资料",
      body: "这是尚未提交 OA、用于验证状态持久化的资料正文。",
      url: "",
      category: "research",
      updatedAt: "2026-09-13",
      published: 0,
    },
  }), env, {}, runtime()));
  assert.equal(created.status, 200);
  assert.equal(created.body.oaSubmissionState, "unsubmitted");
  assert.equal(created.body.draftRevision, 1);
  const documentId = created.body.id;

  const initialRefresh = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    cookie,
    origin: null,
  }), env, {}, runtime()));
  assert.equal(initialRefresh.status, 200);
  assert.equal(initialRefresh.body.documents.length, 1);
  assert.deepEqual(
    {
      state: initialRefresh.body.documents[0].oaSubmissionState,
      itemId: initialRefresh.body.documents[0].oaItemId,
      submittedAt: initialRefresh.body.documents[0].oaSubmittedAt,
      revision: initialRefresh.body.documents[0].draftRevision,
    },
    { state: "unsubmitted", itemId: null, submittedAt: null, revision: 1 },
  );

  const editedBody = "这是保存后的第二版正文，用于证明旧版本回执不能覆盖当前版本。";
  const edited = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "POST",
    cookie,
    body: {
      id: documentId,
      draftRevision: 1,
      title: "OA 状态持久化资料",
      body: editedBody,
      url: "",
      category: "research",
      updatedAt: "2026-09-13",
      published: 0,
    },
  }), env, {}, runtime()));
  assert.equal(edited.status, 200);
  assert.equal(edited.body.draftRevision, 2);
  assert.equal(edited.body.oaSubmissionState, "unsubmitted");

  const oaItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const staleReceipt = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "PATCH",
    cookie,
    body: {
      id: documentId,
      draftRevision: 1,
      submissionState: "submitted",
      oaItemId,
    },
  }), env, {}, runtime()));
  assert.equal(staleReceipt.status, 409);
  assert.match(staleReceipt.body.error, /版本已变化/u);

  const submitted = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "PATCH",
    cookie,
    body: {
      id: documentId,
      draftRevision: 2,
      submissionState: "submitted",
      oaItemId,
    },
  }), env, {}, runtime()));
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.document.oaSubmissionState, "submitted");
  assert.equal(submitted.body.document.oaItemId, oaItemId);
  assert.match(submitted.body.document.oaSubmittedAt, /^\d{4}-\d{2}-\d{2}T/u);
  const submittedAt = submitted.body.document.oaSubmittedAt;

  const refreshed = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    cookie,
    origin: null,
  }), env, {}, runtime()));
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.documents[0].oaSubmissionState, "submitted");
  assert.equal(refreshed.body.documents[0].oaItemId, oaItemId);
  assert.equal(refreshed.body.documents[0].oaSubmittedAt, submittedAt);
  assert.equal(refreshed.body.documents[0].draftRevision, 2);

  const repeatedReceipt = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "PATCH",
    cookie,
    body: {
      id: documentId,
      draftRevision: 2,
      submissionState: "submitted",
      oaItemId,
    },
  }), env, {}, runtime()));
  assert.equal(repeatedReceipt.status, 200);
  assert.equal(repeatedReceipt.body.document.oaSubmittedAt, submittedAt);

  const downgrade = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "PATCH",
    cookie,
    body: {
      id: documentId,
      draftRevision: 2,
      submissionState: "unsubmitted",
    },
  }), env, {}, runtime()));
  assert.equal(downgrade.status, 409);
  assert.match(downgrade.body.error, /不能改回未提交状态/u);

  const editSubmitted = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "POST",
    cookie,
    body: {
      id: documentId,
      draftRevision: 2,
      title: "不应保存的新标题",
      body: "这段内容不应覆盖已经提交 OA 的资料正文。",
      url: "",
      category: "research",
      updatedAt: "2026-09-13",
      published: 0,
    },
  }), env, {}, runtime()));
  assert.equal(editSubmitted.status, 409);
  assert.match(editSubmitted.body.error, /已提交 OA/u);

  const stored = await env.DB.prepare(`
    SELECT title,body,oa_submission_state AS oaSubmissionState,
           oa_item_id AS oaItemId,oa_submitted_at AS oaSubmittedAt,
           draft_revision AS draftRevision
    FROM documents WHERE id=?
  `).bind(documentId).first();
  assert.deepEqual({ ...stored }, {
    title: "OA 状态持久化资料",
    body: editedBody,
    oaSubmissionState: "submitted",
    oaItemId,
    oaSubmittedAt: submittedAt,
    draftRevision: 2,
  });
});

test("Chat document unknown checkpoints persist and resolve through revision CAS", async (t) => {
  const env = makeEnvironment();
  t.after(() => env.DB.close());
  const token = "7".repeat(64);
  const cookie = `__Host-ma-session=${token}`;
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  async function createDocument(title) {
    return responseJson(await handleRequest(apiRequest("/api/admin/documents", {
      method: "POST",
      cookie,
      body: {
        title,
        body: `这是 ${title} 的完整测试正文，用于验证 OA 核对检查点。`,
        url: "",
        category: "research",
        updatedAt: "2026-09-13",
        published: 0,
      },
    }), env, {}, runtime()));
  }

  async function patchSubmission(id, draftRevision, submissionState, oaItemId) {
    return responseJson(await handleRequest(apiRequest("/api/admin/documents", {
      method: "PATCH",
      cookie,
      body: {
        id,
        draftRevision,
        submissionState,
        ...(oaItemId ? { oaItemId } : {}),
      },
    }), env, {}, runtime()));
  }

  const submitCandidate = await createDocument("核对后确认已提交");
  assert.equal(submitCandidate.status, 200);
  assert.equal(submitCandidate.body.oaSubmissionState, "unsubmitted");
  const submittedDocumentId = submitCandidate.body.id;

  const submittedCheckpoint = await patchSubmission(submittedDocumentId, 1, "unknown");
  assert.equal(submittedCheckpoint.status, 200);
  assert.deepEqual(
    {
      state: submittedCheckpoint.body.document.oaSubmissionState,
      itemId: submittedCheckpoint.body.document.oaItemId,
      submittedAt: submittedCheckpoint.body.document.oaSubmittedAt,
      revision: submittedCheckpoint.body.document.draftRevision,
    },
    { state: "unknown", itemId: null, submittedAt: null, revision: 1 },
  );

  const checkpointRefresh = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    cookie,
    origin: null,
  }), env, {}, runtime()));
  const refreshedUnknown = checkpointRefresh.body.documents.find((document) => document.id === submittedDocumentId);
  assert.equal(checkpointRefresh.status, 200);
  assert.equal(refreshedUnknown.oaSubmissionState, "unknown");
  assert.equal(refreshedUnknown.draftRevision, 1);

  const editUnknown = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    method: "POST",
    cookie,
    body: {
      id: submittedDocumentId,
      draftRevision: 1,
      title: "未知状态时不应保存",
      body: "未知状态资料正在 OA 提交前核对，不能同时修改正文。",
      url: "",
      category: "research",
      updatedAt: "2026-09-13",
      published: 0,
    },
  }), env, {}, runtime()));
  assert.equal(editUnknown.status, 409);
  assert.match(editUnknown.body.error, /核对该资料的提交状态/u);

  const staleUnknownToSubmitted = await patchSubmission(
    submittedDocumentId,
    2,
    "submitted",
    "11111111-2222-4333-8444-555555555555",
  );
  assert.equal(staleUnknownToSubmitted.status, 409);
  assert.match(staleUnknownToSubmitted.body.error, /版本已变化/u);

  const resolvedSubmitted = await patchSubmission(
    submittedDocumentId,
    1,
    "submitted",
    "11111111-2222-4333-8444-555555555555",
  );
  assert.equal(resolvedSubmitted.status, 200);
  assert.equal(resolvedSubmitted.body.document.oaSubmissionState, "submitted");
  assert.equal(resolvedSubmitted.body.document.draftRevision, 1);

  const unsubmittedCandidate = await createDocument("核对后确认未提交");
  assert.equal(unsubmittedCandidate.status, 200);
  assert.equal(unsubmittedCandidate.body.oaSubmissionState, "unsubmitted");
  const unsubmittedDocumentId = unsubmittedCandidate.body.id;
  const unsubmittedCheckpoint = await patchSubmission(unsubmittedDocumentId, 1, "unknown");
  assert.equal(unsubmittedCheckpoint.status, 200);
  assert.equal(unsubmittedCheckpoint.body.document.oaSubmissionState, "unknown");

  const staleUnknownToUnsubmitted = await patchSubmission(unsubmittedDocumentId, 2, "unsubmitted");
  assert.equal(staleUnknownToUnsubmitted.status, 409);
  assert.match(staleUnknownToUnsubmitted.body.error, /版本已变化/u);

  const resolvedUnsubmitted = await patchSubmission(unsubmittedDocumentId, 1, "unsubmitted");
  assert.equal(resolvedUnsubmitted.status, 200);
  assert.deepEqual(
    {
      state: resolvedUnsubmitted.body.document.oaSubmissionState,
      itemId: resolvedUnsubmitted.body.document.oaItemId,
      submittedAt: resolvedUnsubmitted.body.document.oaSubmittedAt,
      revision: resolvedUnsubmitted.body.document.draftRevision,
    },
    { state: "unsubmitted", itemId: null, submittedAt: null, revision: 1 },
  );

  const finalRefresh = await responseJson(await handleRequest(apiRequest("/api/admin/documents", {
    cookie,
    origin: null,
  }), env, {}, runtime()));
  assert.equal(finalRefresh.status, 200);
  const finalStates = Object.fromEntries(
    finalRefresh.body.documents.map((document) => [document.id, document.oaSubmissionState]),
  );
  assert.equal(finalStates[submittedDocumentId], "submitted");
  assert.equal(finalStates[unsubmittedDocumentId], "unsubmitted");
});

test("Chat admin can transiently extract a PDF without storing the original file", async (t) => {
  let captured;
  const env = makeEnvironment({
    AI: {
      async run() {
        throw new Error("text generation must not run");
      },
      async toMarkdown(document, options) {
        captured = { document, options };
        return {
          id: "conversion-1",
          name: document.name,
          mimeType: document.blob.type,
          format: "markdown",
          tokens: 32,
          data: "# 自动识别结果\n\nPDF 中的中文正文已经成功提取。",
        };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "e".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const result = await responseJson(await handleRequest(
    uploadRequest("研究报告.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    text: "# 自动识别结果\n\nPDF 中的中文正文已经成功提取。",
    fileName: "研究报告.pdf",
    mimeType: "application/pdf",
    characters: 27,
    tokens: 32,
    originalStored: false,
  });
  assert.equal(captured.document.name, "研究报告.pdf");
  assert.equal(captured.document.blob.type, "application/pdf");
  assert.equal(captured.options.conversionOptions.output.format, "markdown");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first()).n, 0);
});

test("PDF extraction returns text beyond 30000 characters intact for direct OA submission", async (t) => {
  const longText = "文".repeat(30_001);
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        return { format: "markdown", tokens: 30_001, data: longText };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "e".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const result = await responseJson(await handleRequest(
    uploadRequest("长报告.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.text, longText);
  assert.equal(result.body.characters, 30_001);
  assert.equal(result.body.originalStored, false);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first()).n, 0);
});

test("file extraction accepts a valid long Chinese filename after header decoding", async (t) => {
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        return { format: "markdown", tokens: 3, data: "这是一段由长文件名资料自动识别出的正文。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "b".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  const fileName = `${"研".repeat(67)}.pdf`;
  assert.ok(encodeURIComponent(fileName).length > 600);
  const result = await responseJson(await handleRequest(
    uploadRequest(fileName, "application/pdf", pdfBytes(), { cookie: `__Host-ma-session=${token}` }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 200);
  assert.equal(result.body.fileName, fileName);
});

test("file extraction requires an authenticated same-origin administrator", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 1, data: "不应执行的自动识别正文" };
      },
    },
  });
  t.after(() => env.DB.close());
  const bytes = pdfBytes();
  const anonymous = await handleRequest(uploadRequest("report.pdf", "application/pdf", bytes), env, {}, runtime());
  assert.equal(anonymous.status, 403);

  const token = "d".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const crossOrigin = await handleRequest(
    uploadRequest("report.pdf", "application/pdf", bytes, {
      cookie: `__Host-ma-session=${token}`,
      origin: "https://evil.example",
    }),
    env,
    {},
    runtime(),
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(calls, 0);
});

test("file extraction rejects a mismatched JPEG signature before invoking Cloudflare AI", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 1, data: "不应执行的自动识别正文" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "c".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  const result = await responseJson(await handleRequest(
    uploadRequest("malware.jpg", "image/jpeg", new TextEncoder().encode("not a jpeg"), {
      cookie: `__Host-ma-session=${token}`,
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(result.status, 415);
  assert.match(result.body.error, /格式/u);
  assert.equal(calls, 0);
});

test("file extraction allows one 100-file admin batch per IP each hour", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 2, data: "这是用于验证文件解析频率限制的正文内容。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "a".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  for (let index = 0; index < 100; index += 1) {
    const response = await handleRequest(
      uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
        cookie: `__Host-ma-session=${token}`,
        ip: "203.0.113.21",
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const limited = await responseJson(await handleRequest(
    uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
      ip: "203.0.113.21",
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /频繁/u);
  assert.equal(calls, 100);
});

test("file extraction keeps its independent 100 conversions per UTC day budget", async (t) => {
  let calls = 0;
  const env = makeEnvironment({
    AI: {
      async toMarkdown() {
        calls += 1;
        return { format: "markdown", tokens: 2, data: "这是用于验证文件解析每日额度的正文内容。" };
      },
    },
  });
  t.after(() => env.DB.close());
  const token = "9".repeat(64);
  await env.DB.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();

  for (let index = 0; index < 100; index += 1) {
    const response = await handleRequest(
      uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
        cookie: `__Host-ma-session=${token}`,
        ip: `203.0.113.${30 + Math.floor(index / 20)}`,
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const limited = await responseJson(await handleRequest(
    uploadRequest("report.pdf", "application/pdf", pdfBytes(), {
      cookie: `__Host-ma-session=${token}`,
      ip: "203.0.113.99",
    }),
    env,
    {},
    runtime(),
  ));
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /今日文件解析额度/u);
  assert.equal(calls, 100);
});

test("rate-limit identity uses the dedicated HMAC secret", () => {
  const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(source, /hmacHex\(\s*context\.env\.RATE_LIMIT_HMAC_KEY/u);
  assert.doesNotMatch(source, /hmacHex\(\s*context\.env\.APP_ENCRYPTION_KEY/u);
});

test("chat model defaults allow complete answers and sufficient Bailian wait time", () => {
  const source = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
  assert.match(source, /modelCall\(context, config, messages, maxTokens = 2_400, timeoutMs = 60_000\)/u);
  assert.match(source, /workersAiCall\(context, messages, maxTokens = 2_400\)/u);
});

test("chat keeps the 25 requests per IP per hour limit", async (t) => {
  let modelCalls = 0;
  const env = makeEnvironment({
    AI: {
      run: async () => {
        modelCalls += 1;
        return { choices: [{ message: { role: "assistant", content: "研究方向见资料 [1]" } }] };
      },
    },
  });
  t.after(() => env.DB.close());
  for (let index = 0; index < 25; index += 1) {
    const response = await handleRequest(
      apiRequest("/api/chat", {
        method: "POST",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      }),
      env,
      {},
      runtime(),
    );
    assert.equal(response.status, 200);
  }
  const blockedResponse = await handleRequest(
    apiRequest("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
    }),
    env,
    {},
    runtime(),
  );
  assertChatServerTiming(blockedResponse);
  const blocked = await responseJson(blockedResponse);
  assert.equal(blocked.status, 429);
  assert.equal(modelCalls, 25);
});

test("global model budget remains 300 calls per UTC day with its dedicated message", async (t) => {
  let modelCalls = 0;
  const env = makeEnvironment({
    AI: {
      run: async () => {
        modelCalls += 1;
        return { choices: [{ message: { role: "assistant", content: "研究方向见资料 [1]" } }] };
      },
    },
  });
  t.after(() => env.DB.close());
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO limits(key,count,expires) VALUES (?,?,?)")
    .bind(`model-day:${day}`, 300, Math.floor(Date.now() / 1_000) + 172_800)
    .run();
  const result = await responseJson(
    await handleRequest(
      apiRequest("/api/chat", {
        method: "POST",
        ip: "198.51.100.19",
        body: { messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" },
      }),
      env,
      {},
      runtime(),
    ),
  );
  assert.equal(result.status, 429);
  assert.equal(result.body.error, "今日 AI 咨询额度已用完，请稍后再试。");
  assert.equal(modelCalls, 0);
});

test("real Workers chat continues an explicit length stop once and accounts for the extra call", async () => {
  const calls = [];
  const env = makeEnvironment({ AI: { run: async (_model, input) => {
    calls.push(input);
    return { response: calls.length === 1 ? "团队研究灵巧操作。[1]进一步" : "研究机器人系统设计。[1]", finish_reason: calls.length === 1 ? "length" : "stop" };
  } } });
  const response = await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "详细介绍研究方向" }] } }), env, {}, runtime());
  const result = await response.json();
  assert.equal(result.mode, "ai");
  assert.equal(calls.length, 2);
  assert.equal(result.answer, "团队研究灵巧操作。进一步研究机器人系统设计。");
  assert.equal(calls[1].messages[0].content, calls[0].messages[0].content);
  assert.equal(calls[1].messages.at(-2).role, "assistant");
  assert.match(calls[1].messages.at(-1).content, /从上一段回答的断点继续/u);
  assert.equal(Number((await env.DB.prepare("SELECT count FROM limits WHERE key LIKE 'model-day:%'").first()).count), 2);
});

test("real Bailian chat observes finish_reason without exposing credentials or dropping the first answer", async () => {
  const env = makeEnvironment();
  await storeVerifiedBailianConfig(env);
  const calls = [];
  const response = await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "详细介绍研究方向" }] } }), env, {}, runtime(async (url, init) => {
    if (!String(url).includes("dashscope.aliyuncs.com")) return oaResponse();
    calls.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: "assistant", content: calls.length === 1 ? "研究机器人灵巧操作。[1]" : "同时研究机器人系统设计。[1]" }, finish_reason: calls.length === 1 ? "length" : "stop" }] });
  }));
  const result = await response.json();
  assert.equal(result.provider, "bailian");
  assert.equal(calls.length, 2);
  assert.match(result.answer, /灵巧操作。.*系统设计。/u);
  assert.doesNotMatch(JSON.stringify(result), /test-key-not-a-real-secret|encryptedKey/u);
});

test("failed continuation preserves a grounded partial response with a visible incomplete notice", async () => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => {
    if (++calls > 1) throw new Error("network timeout");
    return { response: "研究机器人灵巧操作。[1]", finish_reason: "length" };
  } } });
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "详细介绍研究方向" }] } }), env, {}, runtime())).json();
  assert.equal(calls, 2);
  assert.equal(result.mode, "ai");
  assert.match(result.answer, /研究机器人灵巧操作/u);
  assert.match(result.answer, /尚未完整生成/u);
});

test("an unsafe continuation is rejected by the same factual-output checks as a first answer", async () => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => ({ response: ++calls === 1 ? "研究灵巧操作。[1]" : "打开 https://untrusted.test [1]", finish_reason: calls === 1 ? "length" : "stop" }) } });
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "详细介绍研究方向" }] } }), env, {}, runtime())).json();
  assert.equal(calls, 3);
  assert.equal(result.mode, "retrieval");
  assert.doesNotMatch(result.answer, /untrusted/u);
});

test("public chat returns verified image metadata without passing capability tokens to the text model", async () => {
  const { createKnowledgeAssetToken } = await import("../src/knowledge-asset-token.mjs");
  const token = await createKnowledgeAssetToken("11111111-2222-4333-8444-555555555555", SERVICE_TOKEN);
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => { calls += 1; return { response: "不应调用" }; } } });
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "显示平台图片" }] } }), env, {}, runtime(async () => {
    const source = await oaResponse().json();
    source.chunks[0].assets = [{ token, mimeType: "image/png", alt: "差速轮式小车实验平台" }];
    return Response.json(source);
  }))).json();
  assert.equal(result.images[0].url, `/api/knowledge/assets/${token}`);
  assert.equal(result.images[0].alt, "差速轮式小车实验平台");
  assert.equal(calls, 0);
  assert.match(result.answer, /已审核资料图片/u);
});

test("public chat explains missing approved images without invoking the text model", async () => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => { calls += 1; return { response: "不应调用" }; } } });
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: {
    topic: "research", messages: [{ role: "user", content: "实验室机器人图片" }],
  } }), env, {}, runtime())).json();
  assert.equal(result.mode, "retrieval");
  assert.equal(result.fallbackReason, "no_images");
  assert.match(result.answer, /没有可展示的图片/u);
  assert.equal(calls, 0);
});

test("continuation respects the daily model ceiling and does not discard a completed partial answer", async () => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async () => { calls += 1; return { response: "研究灵巧操作。[1]", finish_reason: "length" }; } } });
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO limits (key,count,expires) VALUES (?,299,?)").bind(`model-day:${day}`, Math.floor(Date.now() / 1000) + 86400).run();
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: { topic: "research", messages: [{ role: "user", content: "详细介绍研究方向" }] } }), env, {}, runtime())).json();
  assert.equal(calls, 1);
  assert.equal(result.mode, "ai");
  assert.match(result.answer, /尚未完整生成/u);
});

test("health probes with tiny output budgets never invoke the long-answer continuation", async () => {
  let calls = 0;
  const env = makeEnvironment({ AI: { run: async (_model, input) => { calls += 1; assert.equal(input.max_tokens, 8); return { response: "连接", finish_reason: "length" }; } } });
  assert.equal((await handleRequest(apiRequest("/api/status"), env, {}, runtime())).status, 200);
  assert.equal(calls, 1);
});

test("chat preserves formula arrays and code while hiding only external citation markers", async (t) => {
  let prompt = "";
  const output = String.raw`**数学模型**：\(x[999] + a_{[1]} = \frac{v^2}{r}\)。[1]

\[
A=\begin{bmatrix}1&2\\3&4\end{bmatrix}
\]
矩阵描述系统。[1]

代码示例：` + "`values[999]`。[1]";
  const env = makeEnvironment({ AI: { run: async (_model, input) => {
    prompt = input.messages[0].content;
    return { response: output };
  } } });
  t.after(() => env.DB.close());
  const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: {
    topic: "research", messages: [{ role: "user", content: "请解释数学模型" }],
  } }), env, {}, runtime())).json();
  assert.equal(result.mode, "ai");
  assert.match(result.answer, /x\[999\]/u);
  assert.ok(result.answer.includes(String.raw`a_{[1]}`));
  assert.ok(result.answer.includes(String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}`));
  assert.ok(result.answer.includes("`values[999]`"));
  assert.doesNotMatch(result.answer, /。\[1\]/u);
  assert.ok(prompt.includes(String.raw`行内用 \( ... \)`));
  assert.ok(prompt.includes(String.raw`独立公式用 \[ ... \]`));
  assert.match(prompt, /不在回答结尾固定追加/u);
});

test("math and code cannot masquerade as grounding citations or bypass contact restrictions", async (t) => {
  for (const output of [String.raw`只有公式 \(x[1]\)。`, "只有代码 `a[1]`。",
    String.raw`公式 \(x[1]\)。[999]`, String.raw`公式 \(\text{https://unsafe.test}\)。[1]`,
    String.raw`公式 \(\text{person@example.test}\)。[1]`, String.raw`公式 \(13912345678\)。[1]`]) {
    const env = makeEnvironment({ AI: { run: async () => ({ response: output }) } });
    t.after(() => env.DB.close());
    const result = await (await handleRequest(apiRequest("/api/chat", { method: "POST", body: {
      topic: "research", messages: [{ role: "user", content: "请解释数学模型" }],
    } }), env, {}, runtime())).json();
    assert.equal(result.mode, "retrieval", output);
    assert.doesNotMatch(result.answer, /unsafe|person@example|13912345678/u);
  }
});
