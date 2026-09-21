import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  frontendAssetPaths,
  isTransientSmokeStatus,
  smokeAdminAuthentication,
  smokeCloudflare,
  smokeSavedAdminAuthentication,
  validateReleaseEvidence,
  validateServiceEvidence,
  validateDocumentExtractionEvidence,
  validateSuggestionEvidence,
} from "./smoke-cloudflare.mjs";

const releaseId = `${"a".repeat(40)}-1`;
const recommendationQuestion = "触觉反馈能怎样帮助机器人抓稳物体？";
const recommendationToken = `${"A".repeat(16)}.${"B".repeat(64)}`;
const suggestionEvidence = {
  suggestions: [
    { id: "1", question: recommendationQuestion, suggestionToken: recommendationToken, updatedAt: "2026-09-14" },
    { id: "2", question: "人和协作机器人一起工作时，怎样保障安全？", suggestionToken: recommendationToken, updatedAt: "2026-09-13" },
    { id: "3", question: "没有卫星信号时，机器人怎么定位？", suggestionToken: recommendationToken, updatedAt: "2026-09-12" },
    { id: "4", question: "机器人怎样把周围环境重建成三维地图？", suggestionToken: recommendationToken, updatedAt: "2026-09-11" },
    { id: "5", question: "四足机器人能在矿井里完成哪些巡检任务？", suggestionToken: recommendationToken, updatedAt: "2026-09-10" },
  ],
  oaPublicStatus: "connected",
};
const evidence = {
  health: { app: "arts-robotics-ai-assistant", ready: true, releaseId },
  status: {
    storageReady: true,
    modelReady: true,
    qwenReady: true,
    oaReady: true,
    knowledgeReady: true,
    retrievalReady: true,
    budgetReady: true,
    systemReady: true,
    documentParsingReady: true,
    provider: "workers-ai",
    model: "test-model",
  },
  suggestions: suggestionEvidence,
  chat: {
    mode: "ai",
    answer: "团队主要研究机器人灵巧操作。",
    provider: "workers-ai",
    oaPublicStatus: "connected",
    releaseId,
    sources: [{ id: "oa:1", origin: "oa_public" }],
  },
  adminAuth: { status: 401, error: "密码不正确" },
};

test("release evidence accepts only the exact OA-backed Chat release", () => {
  assert.deepEqual(validateReleaseEvidence(evidence, releaseId), {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId,
    oaPublicStatus: "connected",
    provider: "workers-ai",
    model: "test-model",
    sources: 1,
    suggestions: 5,
    adminKdfCompatible: true,
  });
});

test("suggestion evidence requires a nonempty exact connected OA contract", () => {
  assert.deepEqual(validateSuggestionEvidence(suggestionEvidence), suggestionEvidence.suggestions);
  for (const payload of [
    undefined,
    { suggestions: [], oaPublicStatus: "connected" },
    { suggestions: suggestionEvidence.suggestions, oaPublicStatus: "unavailable" },
    { ...suggestionEvidence, extra: true },
    { suggestions: [{ ...suggestionEvidence.suggestions[0], id: "2" }], oaPublicStatus: "connected" },
    {
      suggestions: [
        ...suggestionEvidence.suggestions,
        {
          id: "6",
          question: "机器人怎样自主规划路线并避开障碍？",
          suggestionToken: recommendationToken,
          updatedAt: "2026-09-09",
        },
      ],
      oaPublicStatus: "connected",
    },
  ]) {
    assert.throws(
      () => validateReleaseEvidence({ ...evidence, suggestions: payload }, releaseId),
      /recommendation|answerable/u,
    );
  }
});

test("release evidence rejects stale releases and legacy or local-only knowledge", () => {
  assert.throws(
    () => validateReleaseEvidence({ ...evidence, health: { ...evidence.health, releaseId: `${"b".repeat(40)}-1` } }, releaseId),
    /expected ready/u,
  );
  for (const origin of ["legacy_seed", "chat_admin", "chat_draft"]) {
    assert.throws(
      () => validateReleaseEvidence({
        ...evidence,
        chat: { ...evidence.chat, sources: [{ id: "unsafe", origin }] },
      }, releaseId),
      /exclusively OA-approved/u,
    );
  }
});

test("release evidence rejects unavailable OA and retrieval-only fallback", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      chat: { ...evidence.chat, mode: "retrieval", oaPublicStatus: "unavailable", sources: [] },
    }, releaseId),
    /OA-backed AI answer/u,
  );
});

test("release evidence rejects visible citation markers and reference sections", () => {
  for (const answer of [
    "团队主要研究机器人灵巧操作。[1]",
    "团队主要研究机器人灵巧操作[1]。",
    "团队主要研究机器人灵巧操作。[1,2]",
    "团队主要研究机器人灵巧操作。［1，2］",
    "团队主要研究机器人灵巧操作。［１，２］",
    "团队主要研究机器人灵巧操作。【1—2】",
    "团队主要研究机器人灵巧操作。【1】",
    "团队主要研究机器人灵巧操作。[[1]]",
    "团队主要研究机器人灵巧操作。\n\n参考资料：内部列表",
    "团队主要研究机器人灵巧操作。\n\n**参考资料**\n内部列表",
    "团队主要研究机器人灵巧操作。\n\n### 参考来源\n内部列表",
    "团队主要研究机器人灵巧操作。 参考资料：内部列表",
    "团队主要研究机器人灵巧操作。\n\n- **参考资料**\n内部列表",
    "团队主要研究机器人灵巧操作。\n\n1. 参考资料：\n内部列表",
    "团队主要研究机器人灵巧操作。\n\n参考资料列表：\n内部列表",
    "团队主要研究机器人灵巧操作。\n\n参考资料如下所示：\n内部列表",
    "团队主要研究机器人灵巧操作。\n\n> 参考资料\n内部列表",
    "团队主要研究机器人灵巧操作。 可参考资料：内部列表",
    "团队主要研究机器人灵巧操作。\n\n参考：内部列表",
    "团队主要研究机器人灵巧操作。\n\n出处：内部列表",
    "Team focus.\n\nReferences:\nInternal list",
    "Team focus.\n\nSources:\nInternal list",
    "Team focus.\n\nCitation:\nInternal list",
    "Team focus.\n\nBibliography:\nInternal list",
    "Team focus.\n\nWorks Cited\nInternal list",
  ]) {
    assert.throws(
      () => validateReleaseEvidence({
        ...evidence,
        chat: { ...evidence.chat, answer },
      }, releaseId),
      /citation-free OA-backed AI answer/u,
    );
  }
});

test("release evidence preserves ordinary English words containing source-like substrings", () => {
  for (const answer of [
    "Available Resources: robotics lab and test platform.",
    "Preference: concise answers.",
    "The project is open-source: selected components are public.",
  ]) {
    assert.doesNotThrow(() => validateReleaseEvidence({
      ...evidence,
      chat: { ...evidence.chat, answer },
    }, releaseId));
  }
});

test("release evidence rejects any unready homepage service light", () => {
  for (const field of ["qwenReady", "oaReady", "knowledgeReady", "retrievalReady", "budgetReady", "systemReady"]) {
    assert.throws(
      () => validateReleaseEvidence({
        ...evidence,
        status: { ...evidence.status, [field]: false },
      }, releaseId),
      (error) => error instanceof Error && error.retryable === true && /five-light homepage/u.test(error.message),
      field,
    );
  }
});

test("release evidence fails fast when the status contract is malformed", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      status: { ...evidence.status, knowledgeReady: undefined },
    }, releaseId),
    (error) => error instanceof Error && error.retryable !== true && /five-light homepage/u.test(error.message),
  );
});

test("release evidence treats an in-flight status probe as retryable", () => {
  assert.throws(
    () => validateReleaseEvidence({
      ...evidence,
      status: { ...evidence.status, modelReady: false, qwenReady: false, modelPending: true },
    }, releaseId),
    (error) => error instanceof Error && error.retryable === true && /five-light homepage/u.test(error.message),
  );
});

test("release evidence requires a completed administrator password check", () => {
  for (const adminAuth of [undefined, { status: 503, error: "服务暂时不可用，请稍后重试。" }]) {
    assert.throws(
      () => validateReleaseEvidence({ ...evidence, adminAuth }, releaseId),
      /compatible administrator password check/u,
    );
  }
});


test("edge propagation responses are retried without retrying authorization failures", () => {
  for (const status of [404, 408, 421, 425, 500, 502, 503, 504]) {
    assert.equal(isTransientSmokeStatus(status), true);
  }
  for (const status of [undefined, 400, 401, 403, 405, 429]) {
    assert.equal(isTransientSmokeStatus(status), false);
  }
});

test("administrator authentication runs once after retryable release checks settle", async () => {
  let smokeCalls = 0;
  let authCalls = 0;
  const sleeps = [];
  const serviceEvidence = {
    app: "arts-robotics-ai-assistant",
    ready: true,
    releaseId,
    oaPublicStatus: "connected",
    provider: "workers-ai",
    model: "test-model",
    sources: 1,
    suggestions: 5,
  };
  const result = await smokeCloudflare("https://chat.example.com", {
    attempts: 3,
    releaseId,
    smokeAttempt: async () => {
      smokeCalls += 1;
      if (smokeCalls < 3) throw Object.assign(new Error("edge pending"), { status: 503 });
      return serviceEvidence;
    },
    verifyAdmin: async () => {
      authCalls += 1;
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  assert.equal(smokeCalls, 3);
  assert.equal(authCalls, 1);
  assert.deepEqual(sleeps, [1_500, 3_000]);
  assert.deepEqual(result, { ...serviceEvidence, adminKdfCompatible: true });
});

test("service smoke fetches recommendations and sends the first one to chat", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const origin = "https://chat.example.com";
  const appBody = "export const smoke = true;\n".padEnd(240, " ");
  const styleBody = ".smoke { display: block; }\n".padEnd(240, " ");
  const appHash = createHash("sha256").update(appBody).digest("hex").slice(0, 16);
  const styleHash = createHash("sha256").update(styleBody).digest("hex").slice(0, 16);
  const appPath = `/assets/app-${appHash}.js`;
  const stylePath = `/assets/styles-${styleHash}.css`;
  const html = `<html><head><link rel="stylesheet" href="${stylePath}"></head><body>${"shell".repeat(50)}<script type="module" src="${appPath}"></script></body></html>`;
  const calls = [];
  let submittedQuestion = null;
  const apiResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (["/", "/technology", "/research", "/originmind", "/ius", "/manage"].includes(pathname)) {
      return new Response(html, {
        headers: { "Content-Type": "text/html", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (pathname === appPath || pathname === stylePath) {
      return new Response(pathname === appPath ? appBody : styleBody, {
        headers: {
          "Content-Type": pathname === appPath ? "application/javascript" : "text/css",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (pathname === "/_health") return apiResponse(evidence.health);
    if (pathname === "/api/release-smoke-missing") return apiResponse({ error: "missing" }, 404);
    if (pathname === "/api/suggestions") return apiResponse(suggestionEvidence);
    if (pathname === "/api/status") return apiResponse(evidence.status);
    if (pathname === "/api/chat" && options.headers?.Origin === "https://invalid.example") {
      return apiResponse({ error: "origin" }, 403);
    }
    if (pathname === "/api/chat") {
      assert.equal(JSON.parse(options.body).suggestionToken, recommendationToken);
      submittedQuestion = JSON.parse(options.body).messages[0].content;
      return apiResponse(evidence.chat);
    }
    throw new Error(`unexpected smoke path: ${pathname}`);
  };

  const result = await smokeCloudflare(origin, {
    attempts: 1,
    releaseId,
    verifyAdmin: async () => {},
  });
  assert.equal(calls.filter((call) => call.pathname === "/api/suggestions").length, 1);
  assert.equal(submittedQuestion, recommendationQuestion);
  assert.equal(result.suggestions, suggestionEvidence.suggestions.length);
  assert.equal(result.adminKdfCompatible, true);
});

test("the administrator-only production smoke validates the exact origin once", async () => {
  const origins = [];
  const result = await smokeAdminAuthentication("https://chat.omindos.ai", {
    verifyAdmin: async (origin) => origins.push(origin),
  });
  assert.deepEqual(origins, ["https://chat.omindos.ai"]);
  assert.deepEqual(result, { adminKdfCompatible: true });
  await assert.rejects(
    smokeAdminAuthentication("http://chat.omindos.ai", { verifyAdmin: async () => {} }),
    /exact HTTPS origin/u,
  );
});

test("administrator probes retry only transient failures and never retry a 429", async () => {
  let calls = 0;
  const sleeps = [];
  await smokeAdminAuthentication("https://chat.omindos.ai", {
    verifyAdmin: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("edge pending"), { status: 503 });
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1_500]);

  let rateLimitedCalls = 0;
  await assert.rejects(
    smokeAdminAuthentication("https://chat.omindos.ai", {
      verifyAdmin: async () => {
        rateLimitedCalls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      sleepImpl: async () => assert.fail("429 must not sleep or retry"),
    }),
    /rate limited/u,
  );
  assert.equal(rateLimitedCalls, 1);
});

test("the saved administrator password is consumed, verified, and not returned", async () => {
  const password = "saved-administrator-password";
  const environment = { CHAT_ADMIN_PASSWORD: password };
  const calls = [];
  const result = await smokeSavedAdminAuthentication("https://chat.omindos.ai", {
    environment,
    logoutAttempts: 1,
    verifyAdmin: async (origin, suppliedPassword) => calls.push({ origin, suppliedPassword }),
  });
  assert.deepEqual(calls, [{ origin: "https://chat.omindos.ai", suppliedPassword: password }]);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
  assert.deepEqual(result, { adminPasswordVerified: true, smokeSessionRevoked: true });
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("saved-password smoke logs in once and retries logout with the same session", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const password = "saved-administrator-password";
  const token = "b".repeat(64);
  const calls = [];
  let logoutCalls = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ signedIn: true }), {
        status: 200,
        headers: {
          ...headers,
          "Set-Cookie": `__Host-ma-session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`,
        },
      });
    }
    if (url.endsWith("/api/admin/extract")) {
      const mimeType = options.headers["Content-Type"];
      const fileName = decodeURIComponent(options.headers["X-File-Name"]);
      const text = `OriginMind ${mimeType} extraction smoke result.`;
      return new Response(JSON.stringify({
        text,
        fileName,
        mimeType,
        characters: text.length,
        tokens: 8,
        originalStored: false,
      }), { status: 200, headers });
    }
    logoutCalls += 1;
    return new Response(JSON.stringify({ saved: true }), {
      status: logoutCalls === 1 ? 503 : 200,
      headers,
    });
  };
  const sleeps = [];
  const result = await smokeSavedAdminAuthentication("https://chat.omindos.ai", {
    environment: { CHAT_ADMIN_PASSWORD: password },
    logoutAttempts: 2,
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(result, {
    adminPasswordVerified: true,
    smokeSessionRevoked: true,
    documentExtractionVerified: true,
    files: [
      {
        fileName: "originmind-release-smoke.pdf",
        mimeType: "application/pdf",
        characters: "OriginMind application/pdf extraction smoke result.".length,
        originalStored: false,
      },
      {
        fileName: "originmind-release-smoke.png",
        mimeType: "image/png",
        characters: "OriginMind image/png extraction smoke result.".length,
        originalStored: false,
      },
    ],
  });
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/admin/extract")).length, 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/logout")).length, 2);
  assert.ok(calls.filter((call) => call.url.endsWith("/api/auth/logout")).every(
    (call) => call.options.headers.Cookie === `__Host-ma-session=${token}`,
  ));
  assert.deepEqual(sleeps, [1_500]);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("document extraction evidence requires exact transient PDF or image metadata", () => {
  const fixture = { name: "release-smoke.pdf", mimeType: "application/pdf" };
  const text = "OriginMind smoke extraction text.";
  assert.deepEqual(validateDocumentExtractionEvidence({
    text,
    fileName: fixture.name,
    mimeType: fixture.mimeType,
    characters: text.length,
    tokens: 4,
    originalStored: false,
  }, fixture), {
    fileName: fixture.name,
    mimeType: fixture.mimeType,
    characters: text.length,
    originalStored: false,
  });
  for (const payload of [
    { text: "wrong", fileName: fixture.name, mimeType: fixture.mimeType, characters: 5, tokens: 1, originalStored: false },
    { text, fileName: "other.pdf", mimeType: fixture.mimeType, characters: text.length, tokens: 1, originalStored: false },
    { text, fileName: fixture.name, mimeType: fixture.mimeType, characters: text.length, tokens: 1, originalStored: true },
  ]) {
    assert.throws(() => validateDocumentExtractionEvidence(payload, fixture), /verified transient extraction/u);
  }
});

test("saved-password smoke revokes its session even when login response validation fails", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const token = "c".repeat(64);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.endsWith("/api/auth/login")) {
      return new Response(JSON.stringify({ signedIn: false }), {
        status: 200,
        headers: {
          ...headers,
          "Set-Cookie": `__Host-ma-session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`,
        },
      });
    }
    return new Response(JSON.stringify({ saved: true }), { status: 200, headers });
  };
  await assert.rejects(
    smokeSavedAdminAuthentication("https://chat.omindos.ai", {
      environment: { CHAT_ADMIN_PASSWORD: "saved-administrator-password" },
    }),
    /saved administrator password was not accepted/u,
  );
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/login")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/auth/logout")).length, 1);
  assert.equal(calls[1].options.headers.Cookie, `__Host-ma-session=${token}`);
});

test("frontend smoke accepts one deterministic content-hashed script and stylesheet", () => {
  assert.deepEqual(
    frontendAssetPaths(
      '<link rel="stylesheet" href="/assets/styles-0123456789abcdef.css"><script type="module" src="/assets/app-fedcba9876543210.js"></script>',
    ),
    [
      {
        pathname: "/assets/app-fedcba9876543210.js",
        hash: "fedcba9876543210",
        mediaType: "javascript",
      },
      {
        pathname: "/assets/styles-0123456789abcdef.css",
        hash: "0123456789abcdef",
        mediaType: "css",
      },
    ],
  );
  assert.throws(() => frontendAssetPaths("<main>stale shell</main>"), /does not reference/u);
  assert.throws(
    () => frontendAssetPaths(
      '<script src="/assets/app-0123456789abcdef.js"></script><script src="/assets/app-fedcba9876543210.js"></script><link rel="stylesheet" href="/assets/styles-0123456789abcdef.css">',
    ),
    /does not reference/u,
  );
});

test("release propagation and safe fallback can settle but only the exact AI release passes", async () => {
  const staleRelease = `${"b".repeat(40)}-2`;
  const snapshots = [
    { ...evidence, health: { ...evidence.health, releaseId: staleRelease } },
    { ...evidence, chat: { ...evidence.chat, releaseId: staleRelease } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval" } },
    evidence,
  ];
  let calls = 0;
  let authCalls = 0;
  const delays = [];
  const result = await smokeCloudflare("https://test.workers.dev", {
    releaseId,
    smokeAttempt: async () => validateServiceEvidence(snapshots[calls++], releaseId),
    verifyAdmin: async () => { authCalls += 1; return evidence.adminAuth; },
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(calls, 4);
  assert.equal(authCalls, 1);
  assert.deepEqual(delays, [1500, 3000, 4500]);
  assert.equal(result.releaseId, releaseId);
  assert.equal(result.adminKdfCompatible, true);
});

test("a permanently stale release or retrieval fallback exhausts the bounded attempts and never passes", async () => {
  for (const snapshot of [
    { ...evidence, health: { ...evidence.health, releaseId: `${"b".repeat(40)}-1` } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval" } },
  ]) {
    let calls = 0;
    let authCalls = 0;
    await assert.rejects(smokeCloudflare("https://test.workers.dev", {
      releaseId, attempts: 3,
      smokeAttempt: async () => { calls += 1; return validateServiceEvidence(snapshot, releaseId); },
      verifyAdmin: async () => { authCalls += 1; return evidence.adminAuth; },
      sleepImpl: async () => {},
    }));
    assert.equal(calls, 3);
    assert.equal(authCalls, 0);
  }
});

test("malformed identities, unsafe sources and visible reference output remain non-retryable failures", () => {
  const invalid = [
    { ...evidence, health: { ...evidence.health, app: "unrelated-service" } },
    { ...evidence, health: { ...evidence.health, releaseId: "unknown" } },
    { ...evidence, chat: { ...evidence.chat, releaseId: undefined } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval", sources: [] } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval", sources: [{ origin: "chat_draft" }] } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval", answer: "技术说明。[1]" } },
    { ...evidence, chat: { ...evidence.chat, mode: "retrieval", oaPublicStatus: "auth_error" } },
  ];
  for (const snapshot of invalid) {
    assert.throws(() => validateServiceEvidence(snapshot, releaseId), (error) => error.retryable !== true);
  }
});
