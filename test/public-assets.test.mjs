import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const executeFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(root, "frontend");
const publicDir = path.join(root, "public");
const assetDir = path.join(publicDir, "assets");
const buildScript = path.join(root, "scripts", "build-frontend.mjs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function expectedFrontend() {
  const [template, appSource, baseStyle, math, messageActions, actionStyle] = await Promise.all([
    readFile(path.join(frontendDir, "index.html"), "utf8"),
    readFile(path.join(frontendDir, "app.js")),
    readFile(path.join(frontendDir, "styles.css")),
    readFile(path.join(root, "node_modules/katex/dist/katex.mjs")),
    readFile(path.join(frontendDir, "message-actions.js"), "utf8"),
    readFile(path.join(frontendDir, "message-actions.css")),
  ]);
  const mathName = `katex-${digest(math)}.mjs`;
  const app = Buffer.from(`${messageActions}\n${appSource.toString("utf8").replace("__KATEX_ASSET__", `/assets/${mathName}`)}\nvoid openIncomingSharedAnswer();\n`);
  const style = Buffer.concat([baseStyle, Buffer.from("\n"), actionStyle]);
  const appName = `app-${digest(app)}.js`;
  const styleName = `styles-${digest(style)}.css`;
  const html = template
    .replace("__APP_ASSET__", `/assets/${appName}`)
    .replace("__STYLE_ASSET__", `/assets/${styleName}`);
  return { template, html, app, style, math, appName, styleName, mathName };
}

async function fileSnapshot(paths) {
  const result = [];
  for (const file of paths) {
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file, { bigint: true })]);
    result.push({
      file: path.relative(root, file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mtimeNs: String(metadata.mtimeNs),
    });
  }
  return result;
}

async function frontendAnswerFormatter() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function referenceSectionStart");
  const end = script.indexOf("function serviceLabel", start);
  assert.ok(start >= 0 && end > start, "frontend answer formatter must remain directly testable");
  const clean = script.slice(script.indexOf("function cleanPublicChatText"), script.indexOf("function knowledgeSuggestionsFromPayload"));
  return runInNewContext(`${clean}\n${script.slice(start, end)}\nuserFacingAnswer;`, Object.create(null));
}

async function frontendImportHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const MAX_TEXT_IMPORT_BYTES");
  const end = script.indexOf("const TOPICS", start);
  assert.ok(start >= 0 && end > start, "frontend import helpers must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ MAX_TEXT_IMPORT_BYTES, MAX_BINARY_IMPORT_BYTES, MAX_BATCH_IMPORT_FILES, MAX_BATCH_IMPORT_BYTES, BATCH_IMPORT_CONCURRENCY, importFilePath, classifyImportFile, ignoredImportFile, prepareImportFiles, safeMarkdownImportLabel, importedSection, combineImportedSections, suggestedBatchTitle, CHAT_DIRECT_OA_THRESHOLD_CHARACTERS, MAX_OA_STORAGE_FRAGMENT_CHARACTERS, normalizeImportedText, decodeImportedUtf8, utf8ByteLength, estimatedOaStorageFragmentCount, oaImportReceipt, returnedKnowledgeItemIdFromSearch, withoutReturnedKnowledgeItemQuery });`,
    { TextDecoder, TextEncoder, URL, URLSearchParams },
  );
}

async function frontendOaStatusHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const SYSTEM_STATUS_REFRESH_MS");
  const end = script.indexOf("function createPublicApp", start);
  assert.ok(start >= 0 && end > start, "frontend OA status helpers must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ reconciledChatOaEvidence, systemStatusRefreshPlan, oaRetrievalStatusDetail, beijingDayKey, suggestionsRefreshDelay, suggestionsRefreshNeeded });`,
    Object.create(null),
  );
}

async function frontendSuggestionHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function cleanPublicChatText");
  const end = script.indexOf("const TOPIC_LABELS", start);
  assert.ok(start >= 0 && end > start, "frontend suggestion normalization must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\nknowledgeSuggestionsFromPayload;`,
    Object.create(null),
  );
}

async function frontendTopicHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const GENERAL_CHAT_TOPIC");
  const end = script.indexOf("function cleanPublicChatText", start);
  assert.ok(start >= 0 && end > start, "frontend chat topics must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ GENERAL_CHAT_TOPIC, TOPICS, CHAT_TOPICS, DEFAULT_TOPIC_ID, topicIdForPath });`,
    Object.create(null),
  );
}

async function frontendAnalyticsHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const PUBLIC_ANALYTICS_EVENT_TYPES");
  const end = script.indexOf("function makeRequestId", start);
  assert.ok(start >= 0 && end > start, "frontend analytics queue must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ createAnalyticsQueue, PUBLIC_ANALYTICS_MAX_BATCH_SIZE });`,
    {
      CHAT_TOPICS: [
        { id: "general" },
        { id: "technology" },
        { id: "academic" },
        { id: "company" },
        { id: "association" },
      ],
    },
  );
}

async function frontendConversationHelpers() {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("const CHAT_HISTORY_KEY");
  const end = script.indexOf("function appendAnswerInline", start);
  assert.ok(start >= 0 && end > start, "frontend conversation helpers must remain directly testable");
  return runInNewContext(
    `${script.slice(start, end)}\n({ CHAT_CONVERSATIONS_KEY, CHAT_CONVERSATION_LIMIT, CHAT_RECENT_LIMIT, chatConversationTitle, chatConversationsSnapshot, writeChatConversations, readChatConversations, recentChatConversations });`,
    { userFacingAnswer: (value) => String(value || "") },
  );
}

async function frontendReturnedImportHarness({
  ok,
  payload,
  returnedKnowledgeItemId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  initialOaSubmissionState = "unsubmitted",
  failSubmittedPatchCount = 0,
  deferStatus = false,
}) {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function clearReturnedKnowledgeContext");
  const end = script.indexOf("async function runAdminAction", start);
  assert.ok(start >= 0 && end > start, "returned-import lifecycle must remain directly testable");
  const draft = {
    id: "11111111-2222-4333-8444-555555555555",
    title: "修订稿",
    body: "已按审核意见修改后的正文内容。",
    url: "",
    category: "research",
    updatedAt: "2026-09-13",
    draftRevision: 3,
    oaSubmissionState: initialOaSubmissionState,
    submissionRequestId: "",
  };
  const calls = {
    request: null,
    requestUrl: "",
    importRequests: [],
    statusRequests: [],
    adminRequests: [],
    events: [],
    renders: 0,
    replacedUrl: "",
  };
  const state = {
    returnedKnowledgeItemId,
    notice: "",
    documents: [draft],
    oaStatusSyncRequired: false,
    oaStatusSyncing: false,
    loading: false,
    config: { keyConfigured: false },
    inquiries: [],
    initialized: false,
    activeTab: "inquiries",
  };
  let remainingSubmittedPatchFailures = failSubmittedPatchCount;
  const api = runInNewContext(`${script.slice(start, end)}\n({ submitDocumentToOa, fetchAdminData });`, {
    state,
    OA_CHAT_IMPORT_URL: "https://oa.omindos.ai/api/knowledge/import-chat",
    OA_CHAT_IMPORT_STATUS_URL: "https://oa.omindos.ai/api/knowledge/import-chat/status",
    CHAT_DIRECT_OA_THRESHOLD_CHARACTERS: 30_000,
    SAFE_RETURNED_KNOWLEDGE_ITEM_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    AbortSignal,
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      if (url === "https://oa.omindos.ai/api/knowledge/import-chat/status") {
        calls.statusRequests.push(request);
        calls.events.push("oa:status");
        if (deferStatus) return new Promise(() => {});
        return {
          ok: true,
          json: async () => ({ documentId: request.document.id, submitted: false }),
        };
      }
      calls.requestUrl = url;
      calls.request = request;
      calls.importRequests.push(request);
      calls.events.push("oa:import");
      return { ok, json: async () => payload };
    },
    jsonOptions: (body, method = "POST") => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    adminRequest: async (endpoint, options = {}) => {
      if (!options.method) {
        if (endpoint === "config") return { keyConfigured: false };
        if (endpoint === "documents") return { documents: state.documents };
        if (endpoint === "inquiries") return { inquiries: [] };
      }
      const request = {
        endpoint,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.adminRequests.push(request);
      calls.events.push(`chat:${request.body?.submissionState || request.method.toLowerCase()}`);
      if (request.body?.submissionState === "submitted" && remainingSubmittedPatchFailures > 0) {
        remainingSubmittedPatchFailures -= 1;
        throw new Error("Chat PATCH failed");
      }
      const current = state.documents.find((document) => document.id === request.body?.id) || draft;
      return {
        saved: true,
        document: {
          ...current,
          oaSubmissionState: request.body?.submissionState || current.oaSubmissionState,
          oaItemId: request.body?.oaItemId || "",
          oaSubmittedAt: "2026-09-13T06:00:00.000Z",
        },
      };
    },
    oaImportReceipt: (result) => ({ items: result.item ? [result.item] : [], partCount: Number(result.partCount) || 1 }),
    withoutReturnedKnowledgeItemQuery: (href) => {
      const url = new URL(href);
      url.searchParams.delete("returnedKnowledgeItem");
      return `${url.pathname}${url.search}${url.hash}`;
    },
    window: {
      location: { href: "https://chat.omindos.ai/manage?keep=1&returnedKnowledgeItem=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#upload" },
      history: {
        state: null,
        replaceState: (_state, _title, url) => { calls.replacedUrl = url; },
      },
    },
    renderAdminShell: () => { calls.renders += 1; },
  });
  return { api, calls, draft, state };
}

test("public analytics batches only anonymous allowlisted events in groups of at most five", async () => {
  const { createAnalyticsQueue, PUBLIC_ANALYTICS_MAX_BATCH_SIZE } = await frontendAnalyticsHelpers();
  const requests = [];
  const analytics = createAnalyticsQueue((url, options) => {
    requests.push({ url, options });
    return Promise.resolve({ ok: true });
  });

  assert.equal(PUBLIC_ANALYTICS_MAX_BATCH_SIZE, 5);
  assert.equal(analytics.track("unknown", { section: "general" }), false);
  assert.equal(analytics.track("page_view", { section: "private" }), false);
  assert.equal(analytics.track("suggestion_click", { section: "general" }), false);
  assert.equal(analytics.track("page_view", {
    section: "general",
    question: "不得上传的用户问题",
    answer: "不得上传的回答",
    conversationId: "local-only",
  }), true);
  for (const suggestion of [
    "实验室目前有哪些机器人设备？",
    "实验室主要研究哪些机器人方向？",
    "四足机器人能在矿井里完成哪些巡检任务？",
    "OriginMind 怎样组织机器人的技能和任务？",
    "协会有哪些机器人实践活动？",
  ]) {
    assert.equal(analytics.track("suggestion_impression", { section: "general", suggestion }), true);
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.map(({ url }) => url), ["/api/analytics", "/api/analytics"]);
  const batches = requests.map(({ options }) => JSON.parse(options.body).events);
  assert.deepEqual(batches.map((events) => events.length), [5, 1]);
  assert.equal(requests.every(({ options }) => (
    options.method === "POST" && options.credentials === "same-origin" && options.keepalive === true
  )), true);
  assert.deepEqual({ ...batches[0][0] }, { type: "page_view", section: "general" });
  assert.equal(JSON.stringify(batches).includes("用户问题"), false);
  assert.equal(JSON.stringify(batches).includes("conversationId"), false);
});

test("analytics UI and event hooks retain the agreed privacy and period contract", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  assert.match(script, /analytics\.track\("page_view",\s*\{ section \}\)/u);
  assert.match(script, /analytics\.track\("new_chat",\s*\{ section: newChatSection \}\)/u);
  assert.match(script, /analytics\.track\("install_success",\s*\{ section: state\.section \}\)/u);
  assert.match(script, /analytics\.track\("suggestion_impression",[\s\S]{0,180}?suggestion:\s*metadata\.suggestion/u);
  assert.match(script, /analytics\.track\("suggestion_click",[\s\S]{0,180}?suggestion:\s*question/u);
  assert.match(script, /analyticsSection:\s*session\.section/u);
  assert.match(script, /adminRequest\(`analytics\?days=\$\{days\}`\)/u);
  assert.match(script, /\[\[1,\s*"今天"\],\s*\[7,\s*"近 7 天"\],\s*\[30,\s*"近 30 天"\]\]/u);
  assert.match(script, /tabButton\("analytics",\s*"数据统计"\)/u);
  for (const label of ["页面浏览", "提问次数", "推荐点击率", "响应成功率", "安装成功", "逐日趋势", "主题表现", "热门推荐"]) {
    assert.ok(script.includes(label), label);
  }
  assert.match(style, /\.analytics-kpi-grid\s*\{[\s\S]{0,180}?grid-template-columns:\s*repeat\(auto-fit,/u);
  assert.match(style, /\.analytics-table-wrap\s*\{[\s\S]{0,180}?overflow-x:\s*auto/u);
  assert.match(style, /@media \(max-width: 820px\)[\s\S]{0,220}?\.analytics-kpi-grid/u);
});

test("the deterministic build contains exactly the current content-hashed frontend", async () => {
  const expected = await expectedFrontend();
  assert.equal(expected.template.split("__APP_ASSET__").length - 1, 1);
  assert.equal(expected.template.split("__STYLE_ASSET__").length - 1, 1);

  const top = (await readdir(publicDir)).sort();
  assert.deepEqual(top, [
    "LICENSES.md",
    "_headers",
    "assets",
    "favicon.svg",
    "index.html",
    "manifest.webmanifest",
    "service-worker.js",
    "zip-import-addon.js",
  ]);
  assert.deepEqual(
    (await readdir(assetDir)).sort(),
    [expected.appName, expected.mathName, "pwa", expected.styleName].sort(),
  );
  assert.equal(await readFile(path.join(publicDir, "index.html"), "utf8"), expected.html);
  assert.deepEqual(await readFile(path.join(assetDir, expected.appName)), expected.app);
  assert.deepEqual(await readFile(path.join(assetDir, expected.mathName)), expected.math);
  assert.match(expected.app.toString("utf8"), new RegExp(expected.mathName.replaceAll(".", "\\.")));
  assert.doesNotMatch(expected.app.toString("utf8"), /__KATEX_ASSET__/u);
  assert.deepEqual(await readFile(path.join(assetDir, expected.styleName)), expected.style);
});

test("build --check verifies outputs without mutating them", async () => {
  const expected = await expectedFrontend();
  const outputs = [
    path.join(publicDir, "index.html"),
    path.join(assetDir, expected.appName),
    path.join(assetDir, expected.mathName),
    path.join(assetDir, expected.styleName),
  ];
  const before = await fileSnapshot(outputs);
  const result = await executeFile(process.execPath, [buildScript, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(result.stdout, /^Frontend checked: app-[a-f0-9]{16}\.js, katex-[a-f0-9]{16}\.mjs, styles-[a-f0-9]{16}\.css\n$/u);
  assert.deepEqual(await fileSnapshot(outputs), before);
});

test("HTML uses only self-hosted generated assets and retains public metadata", async () => {
  const expected = await expectedFrontend();
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  assert.equal(html.includes("__APP_ASSET__"), false);
  assert.equal(html.includes("__STYLE_ASSET__"), false);
  assert.match(html, /<html\b[^>]*\blang=["']zh-CN["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["'][^>]*\bcontent=["'][^"']*\binteractive-widget=resizes-content\b[^"']*["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex,nofollow["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']description["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']theme-color["'][^>]*\bcontent=["']#ffffff["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']apple-mobile-web-app-capable["'][^>]*\bcontent=["']yes["']/iu);
  assert.match(html, /<meta\b[^>]*\bname=["']apple-mobile-web-app-title["'][^>]*\bcontent=["']联合研发 OA["']/iu);
  assert.match(html, /<link\b[^>]*\brel=["']manifest["'][^>]*\bhref=["']\/manifest\.webmanifest["']/iu);
  assert.match(html, /<link\b[^>]*\brel=["']apple-touch-icon["'][^>]*\bhref=["']\/assets\/pwa\/apple-touch-icon-180-v1\.png["']/iu);
  assert.ok(html.includes("联合研发 OA"));
  assert.ok(html.includes(`/assets/${expected.appName}`));
  assert.ok(html.includes(`/assets/${expected.styleName}`));

  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]);
  const styleSources = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]);
  assert.deepEqual(scriptSources, [`/assets/${expected.appName}`, "/zip-import-addon.js"]);
  assert.deepEqual(styleSources, [`/assets/${expected.styleName}`]);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu);
  assert.ok([...scriptSources, ...styleSources].every((source) => source.startsWith("/assets/") || source === "/zip-import-addon.js"));
});

test("installable web app metadata has complete versioned icons", async () => {
  const manifest = JSON.parse(await readFile(path.join(publicDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.name, "联合研发 OA");
  assert.equal(manifest.short_name, "联合研发 OA");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#ffffff");
  assert.equal(manifest.prefer_related_applications, false);

  const expectedIcons = new Map([
    ["/assets/pwa/icon-192-v1.png", { size: "192x192", purpose: "any" }],
    ["/assets/pwa/icon-512-v1.png", { size: "512x512", purpose: "any" }],
    ["/assets/pwa/icon-maskable-512-v1.png", { size: "512x512", purpose: "maskable" }],
  ]);
  assert.equal(manifest.icons.length, expectedIcons.size);
  for (const icon of manifest.icons) {
    const expected = expectedIcons.get(icon.src);
    assert.ok(expected, icon.src);
    assert.equal(icon.sizes, expected.size);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.purpose, expected.purpose);
    const bytes = await readFile(path.join(publicDir, icon.src.slice(1)));
    const [width, height] = expected.size.split("x").map(Number);
    assert.deepEqual(pngDimensions(bytes), { width, height });
  }

  const appleIcon = await readFile(
    path.join(publicDir, "assets/pwa/apple-touch-icon-180-v1.png"),
  );
  assert.deepEqual(pngDimensions(appleIcon), { width: 180, height: 180 });
});

test("service worker caches only same-origin versioned static assets", async () => {
  const source = await readFile(path.join(publicDir, "service-worker.js"), "utf8");
  const listeners = new Map();
  const stored = new Map();
  const networkCalls = [];
  const response = {
    ok: true,
    type: "basic",
    clone() { return this; },
  };
  runInNewContext(source, {
    URL,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({
        match: async (request) => stored.get(request.url),
        put: async (request, value) => { stored.set(request.url, value); },
      }),
    },
    fetch: async (request) => {
      networkCalls.push(request.url);
      return response;
    },
    self: {
      location: { origin: "https://chat.omindos.ai" },
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
      addEventListener: (type, handler) => { listeners.set(type, handler); },
    },
  });

  const dispatchFetch = (url, options = {}) => {
    let handled = null;
    listeners.get("fetch")({
      request: new Request(url, options),
      respondWith(value) { handled = Promise.resolve(value); },
    });
    return handled;
  };

  const versioned = "https://chat.omindos.ai/assets/app-0123456789abcdef.js";
  const firstVersioned = dispatchFetch(versioned);
  assert.ok(firstVersioned);
  await firstVersioned;
  assert.equal(networkCalls.length, 1);
  await dispatchFetch(versioned);
  assert.equal(networkCalls.length, 1, "second request must use the static cache");

  for (const url of [
    "https://chat.omindos.ai/",
    "https://chat.omindos.ai/manage",
    "https://chat.omindos.ai/api/chat",
    "https://chat.omindos.ai/_health",
    "https://chat.omindos.ai/assets/app.js",
    "https://chat.omindos.ai/assets/app-0123456789abcdef.js?changed=1",
    "https://oa.omindos.ai/assets/app-0123456789abcdef.js",
  ]) {
    assert.equal(dispatchFetch(url), null, url);
  }
  assert.equal(
    dispatchFetch(versioned, { method: "POST", body: "not cached" }),
    null,
  );
  assert.equal(networkCalls.length, 1);
});

test("static header fallback keeps install metadata fresh", async () => {
  const headers = await readFile(path.join(publicDir, "_headers"), "utf8");
  assert.match(
    headers,
    /\/manifest\.webmanifest\s+Cache-Control:\s*public, max-age=3600/u,
  );
  assert.match(
    headers,
    /\/service-worker\.js\s+Cache-Control:\s*no-cache, no-store, must-revalidate\s+Service-Worker-Allowed:\s*\//u,
  );
  assert.match(
    headers,
    /\/assets\/\*\s+Cache-Control:\s*public, max-age=31536000, immutable/u,
  );
});

test("frontend answer formatting hides citations without truncating ordinary source-like words", async () => {
  const format = await frontendAnswerFormatter();
  assert.equal(format("事实[1]。另一个事实。【１—２】"), "事实。另一个事实。");
  assert.equal(format("回答。[1]\n\n> 参考资料\n[1] OA"), "回答。");
  assert.equal(format("Answer.[1]\n\nBibliography:\n[1] OA"), "Answer.");
  assert.equal(format("回答。[1]\n\n参考：\n[1] OA"), "回答。");
  assert.equal(format("回答。[1]\n\n出处：\n[1] OA"), "回答。");
  assert.equal(format("Answer.[1]\n\nCitation:\n[1] OA"), "Answer.");
  assert.equal(format("Answer.[1]\n\nSources [1] OA"), "Answer.");
  assert.equal(format("回答。[1]\n\n[1] OA 标题\n[2] 第二标题"), "回答。");
  assert.equal(format("回答。[1]\n\n• [1] OA 标题"), "回答。");
  assert.equal(format("回答。[1]\n[1] OA 标题"), "回答。");
  assert.equal(format("Available Resources: robotics lab.[1]"), "Available Resources: robotics lab.");
  assert.equal(format("Preference: concise answers.[1]"), "Preference: concise answers.");
  assert.equal(format("open-source: selected components are public.[1]"), "open-source: selected components are public.");
  assert.equal(format("回答。[1] 可参考资料：[1] OA"), "暂时没有可显示的回答。");
  assert.equal(format("回答。[1] 可查看**参考资料**：[1] OA"), "暂时没有可显示的回答。");
  assert.equal(format("回答。[1] 嵌套标记 [[1]]"), "暂时没有可显示的回答。");
});

test("text imports use normalized fatal UTF-8 decoding and a five MiB byte cap", async () => {
  const helpers = await frontendImportHelpers();
  assert.equal(helpers.MAX_TEXT_IMPORT_BYTES, 5 * 1024 * 1024);
  assert.equal(helpers.CHAT_DIRECT_OA_THRESHOLD_CHARACTERS, 30_000);
  assert.equal(helpers.MAX_OA_STORAGE_FRAGMENT_CHARACTERS, 20_000);
  assert.equal(helpers.normalizeImportedText("\uFEFFＡ\r\nB\rC\u0000\u0007"), "A\nB\nC");
  assert.equal(helpers.decodeImportedUtf8(new TextEncoder().encode("\uFEFFＭＤ\r\n正文")), "MD\n正文");
  assert.throws(
    () => helpers.decodeImportedUtf8(Uint8Array.from([0xc3, 0x28])),
    /必须使用有效的 UTF-8 编码/u,
  );
  assert.equal(helpers.utf8ByteLength("中"), 3);
  assert.equal(helpers.estimatedOaStorageFragmentCount("a".repeat(40_001)), 3);

  const current = helpers.oaImportReceipt({ item: { id: "one", status: "pending" }, partCount: 7 }, "short body");
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].id, "one");
  assert.equal(current.partCount, 7);
  const legacy = helpers.oaImportReceipt({ items: [{ contentPartCount: 2 }, { contentPartCount: 3 }] }, "short body");
  assert.equal(legacy.items.length, 2);
  assert.equal(legacy.partCount, 5);

  const returnedId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch(`?returnedKnowledgeItem=${returnedId}`), returnedId.toLowerCase());
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch("?returnedKnowledgeItem=not-an-id"), "");
  assert.equal(helpers.returnedKnowledgeItemIdFromSearch(`?returnedKnowledgeItem=${returnedId}&returnedKnowledgeItem=${returnedId}`), "");
  assert.equal(
    helpers.withoutReturnedKnowledgeItemQuery(`https://chat.omindos.ai/manage?keep=1&returnedKnowledgeItem=${returnedId}#upload`),
    "/manage?keep=1#upload",
  );
});

test("batch import helpers validate, sort and combine files deterministically", async () => {
  const helpers = await frontendImportHelpers();
  assert.equal(helpers.MAX_BINARY_IMPORT_BYTES, 10 * 1024 * 1024);
  assert.equal(helpers.MAX_BATCH_IMPORT_FILES, 100);
  assert.equal(helpers.MAX_BATCH_IMPORT_BYTES, 500 * 1024 * 1024);
  assert.equal(helpers.BATCH_IMPORT_CONCURRENCY, 3);

  const files = [
    { name: "figure_10.png", webkitRelativePath: "论文/images/figure_10.png", size: 200 },
    { name: "paper.md", webkitRelativePath: "论文/paper.md", size: 300 },
    { name: "figure_2.png", webkitRelativePath: "论文/images/figure_2.png", size: 100 },
  ];
  const descriptors = helpers.prepareImportFiles(files);
  assert.deepEqual(
    Array.from(descriptors, (item) => item.path),
    ["论文/images/figure_2.png", "论文/images/figure_10.png", "论文/paper.md"],
  );
  assert.equal(descriptors[0].kind, "图片");
  assert.equal(descriptors[2].kind, "Markdown");
  assert.equal(helpers.suggestedBatchTitle(descriptors), "论文");
  assert.equal(helpers.ignoredImportFile({ name: ".DS_Store" }), true);
  assert.equal(helpers.ignoredImportFile({ name: "photo.png", webkitRelativePath: "__MACOSX/photo.png" }), true);
  assert.equal(
    helpers.prepareImportFiles([{ name: ".DS_Store", size: 10 }, { name: "photo.png", size: 10 }]).length,
    1,
  );

  const body = helpers.combineImportedSections([
    { descriptor: descriptors[0], text: "图二识别出来的有效文字内容。" },
    { descriptor: descriptors[1], duplicate: true },
    { descriptor: descriptors[2], text: "# 正文\r\n\r\n论文中的有效正文内容。" },
  ], true);
  assert.match(body, /^## 图片：论文\/images\/figure_2\.png/u);
  assert.match(body, /---\n\n## Markdown：论文\/paper\.md/u);
  assert.doesNotMatch(body, /figure_10/u);
  assert.equal(helpers.safeMarkdownImportLabel("a#<b>`c.png"), "a＃bc.png");

  assert.throws(
    () => helpers.prepareImportFiles([{ name: "bad.svg", size: 50 }]),
    /仅支持/u,
  );
  assert.throws(
    () => helpers.prepareImportFiles([
      { name: "same.png", webkitRelativePath: "A/same.png", size: 50 },
      { name: "SAME.PNG", webkitRelativePath: "a/SAME.PNG", size: 50 },
    ]),
    /重复文件路径/u,
  );
  assert.throws(
    () => helpers.prepareImportFiles(Array.from({ length: 101 }, (_, index) => ({
      name: `${index}.png`,
      size: 1,
    }))),
    /每批最多导入 100 个/u,
  );
});

test("returned-import context survives failure and is cleared only after OA acknowledges the revision", async () => {
  const failed = await frontendReturnedImportHarness({ ok: false, payload: { error: "暂时失败" } });
  await assert.rejects(() => failed.api.submitDocumentToOa(failed.draft, {
    retainedAsChatDraft: false,
    submissionContext: { returnedKnowledgeItemId: failed.state.returnedKnowledgeItemId },
  }), /暂时失败/u);
  assert.equal(failed.state.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(failed.calls.replacedUrl, "");
  assert.equal(failed.calls.request.returnedKnowledgeItemId, failed.state.returnedKnowledgeItemId);

  const succeeded = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "pending" }, partCount: 3 },
  });
  await succeeded.api.submitDocumentToOa(succeeded.draft, {
    retainedAsChatDraft: false,
    submissionContext: { returnedKnowledgeItemId: succeeded.state.returnedKnowledgeItemId },
  });
  assert.equal(succeeded.calls.request.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(succeeded.state.returnedKnowledgeItemId, "");
  assert.equal(succeeded.calls.replacedUrl, "/manage?keep=1#upload");
  assert.match(succeeded.state.notice, /更新原 OA 条目并重新进入待审核状态/u);
});

test("local drafts never inherit an unrelated returned-import context", async () => {
  const oaItemId = "22222222-3333-4444-8555-666666666666";
  const local = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: oaItemId, status: "pending" }, partCount: 1 },
  });
  await local.api.submitDocumentToOa(local.draft);
  assert.equal(local.calls.requestUrl, "https://oa.omindos.ai/api/knowledge/import-chat");
  assert.equal(Object.hasOwn(local.calls.request, "returnedKnowledgeItemId"), false);
  assert.equal(local.calls.adminRequests.length, 2);
  assert.deepEqual(local.calls.adminRequests[0], {
    endpoint: "documents",
    method: "PATCH",
    body: {
      id: local.draft.id,
      draftRevision: local.draft.draftRevision,
      submissionState: "unknown",
    },
  });
  assert.deepEqual(local.calls.adminRequests[1], {
    endpoint: "documents",
    method: "PATCH",
    body: {
      id: local.draft.id,
      draftRevision: local.draft.draftRevision,
      submissionState: "submitted",
      oaItemId,
    },
  });
  assert.deepEqual(local.calls.events, ["chat:unknown", "oa:import", "chat:submitted"]);
  assert.equal(local.state.documents[0].oaSubmissionState, "submitted");
  assert.equal(local.state.documents[0].oaItemId, oaItemId);
  assert.equal(local.state.returnedKnowledgeItemId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(local.calls.replacedUrl, "");

  const invalid = await frontendReturnedImportHarness({
    ok: true,
    payload: { item: { id: oaItemId, status: "pending" }, partCount: 1 },
  });
  await assert.rejects(
    () => invalid.api.submitDocumentToOa(invalid.draft, {
      submissionContext: { returnedKnowledgeItemId: "not-an-id" },
    }),
    /退回资料上下文无效/u,
  );
  assert.equal(invalid.calls.request, null);
  assert.equal(invalid.calls.adminRequests.length, 0);
});

test("a failed final Chat PATCH leaves the draft unknown and starts OA reconciliation", async () => {
  const uncertain = await frontendReturnedImportHarness({
    ok: true,
    payload: {
      item: { id: "22222222-3333-4444-8555-666666666666", status: "pending" },
      partCount: 1,
    },
    returnedKnowledgeItemId: "",
    failSubmittedPatchCount: 1,
    deferStatus: true,
  });

  await assert.rejects(
    () => uncertain.api.submitDocumentToOa(uncertain.draft),
    /OA 已接收，但 Chat 未能保存提交状态/u,
  );
  assert.deepEqual(uncertain.calls.events, [
    "chat:unknown",
    "oa:import",
    "chat:submitted",
    "oa:status",
  ]);
  assert.equal(uncertain.calls.importRequests.length, 1);
  assert.equal(uncertain.calls.statusRequests.length, 1);
  assert.equal(uncertain.state.documents[0].oaSubmissionState, "unknown");
  assert.equal(uncertain.state.oaStatusSyncRequired, true);
  assert.equal(uncertain.state.oaStatusSyncing, true);
});

test("initial admin loading starts legacy OA reconciliation without awaiting it", async () => {
  const legacy = await frontendReturnedImportHarness({
    ok: true,
    payload: {},
    returnedKnowledgeItemId: "",
    initialOaSubmissionState: "unknown",
    deferStatus: true,
  });

  await legacy.api.fetchAdminData(true);
  assert.equal(legacy.state.initialized, true);
  assert.equal(legacy.calls.statusRequests.length, 1);
  assert.equal(legacy.state.oaStatusSyncing, true);

  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("async function fetchAdminData");
  const end = script.indexOf("async function runAdminAction", start);
  const fetchAdminDataSource = script.slice(start, end);
  assert.match(fetchAdminDataSource, /void reconcileUnknownDocumentStatuses\(\)/u);
  assert.doesNotMatch(fetchAdminDataSource, /await reconcileUnknownDocumentStatuses\(\)/u);
});

test("OA status reconciliation ignores stale chat evidence and preserves structural readiness", async () => {
  const helpers = await frontendOaStatusHelpers();
  const green = {
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
  };

  const failed = helpers.reconciledChatOaEvidence(
    green,
    { oaPublicStatus: "timeout", sources: [] },
    4,
    4,
  );
  assert.ok(failed);
  assert.equal(failed.service.oaReady, true);
  assert.equal(failed.service.knowledgeReady, true);
  assert.equal(failed.service.retrievalReady, false);
  assert.equal(failed.service.systemReady, false);
  assert.equal(failed.service.oaFailureStatus, "timeout");
  assert.equal(failed.error, "OA 知识检索响应超时");
  assert.equal(helpers.oaRetrievalStatusDetail(failed.service), "OA 检索响应较慢");

  const recovered = helpers.reconciledChatOaEvidence(
    failed.service,
    { oaPublicStatus: "connected", sources: [] },
    5,
    5,
  );
  assert.ok(recovered);
  assert.equal(recovered.service.knowledgeReady, true);
  assert.equal(recovered.service.retrievalReady, true);
  assert.equal(recovered.service.systemReady, true);

  const stale = helpers.reconciledChatOaEvidence(
    recovered.service,
    { oaPublicStatus: "connected", sources: [{ id: "oa:1" }] },
    3,
    4,
  );
  assert.equal(stale, null);

  const fromPending = helpers.reconciledChatOaEvidence(
    null,
    { oaPublicStatus: "connected", sources: [{ id: "oa:1" }] },
    5,
    5,
  );
  assert.ok(fromPending);
  assert.equal(fromPending.service.oaReady, true);
  assert.equal(fromPending.service.knowledgeReady, true);
  assert.equal(fromPending.service.retrievalReady, true);
  assert.equal(fromPending.service.systemReady, false);
});

test("OA status retries back off to the normal refresh interval and reset after recovery", async () => {
  const helpers = await frontendOaStatusHelpers();
  const unhealthy = { systemReady: false, modelPending: false, oaPending: false };
  let retryDelay = 5_000;
  const observed = [];
  for (let index = 0; index < 6; index += 1) {
    const plan = helpers.systemStatusRefreshPlan(unhealthy, retryDelay);
    observed.push(plan.delay);
    retryDelay = plan.nextRetryDelay;
  }
  assert.equal(JSON.stringify(observed), JSON.stringify([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]));

  const healthy = helpers.systemStatusRefreshPlan(
    { systemReady: true, modelPending: false, oaPending: false },
    retryDelay,
  );
  assert.equal(healthy.delay, 60_000);
  assert.equal(healthy.nextRetryDelay, 5_000);
});

test("a recommendation refresh due during a status probe runs as soon as status is ready", async () => {
  const helpers = await frontendOaStatusHelpers();
  const dueDuringProbe = {
    loaded: true,
    loading: false,
    pending: true,
    fetchedAt: 1_000,
    now: 61_000,
  };
  assert.equal(helpers.suggestionsRefreshNeeded({ ...dueDuringProbe, ready: false }), false);
  assert.equal(helpers.suggestionsRefreshNeeded({ ...dueDuringProbe, ready: true }), true);
});

test("recommendations stay stable for a Beijing day and refresh at the next midnight", async () => {
  const helpers = await frontendOaStatusHelpers();
  const beforeMidnight = Date.UTC(2026, 8, 14, 15, 59, 30);
  const midnight = Date.UTC(2026, 8, 14, 16, 0, 0);
  assert.equal(helpers.beijingDayKey(beforeMidnight), "2026-09-14");
  assert.equal(helpers.beijingDayKey(midnight), "2026-09-15");
  assert.equal(helpers.suggestionsRefreshDelay(beforeMidnight), 30_000);
  assert.equal(helpers.suggestionsRefreshDelay(midnight), 24 * 60 * 60_000);
  assert.equal(helpers.suggestionsRefreshNeeded({
    ready: true,
    loaded: true,
    loading: false,
    pending: false,
    fetchedAt: beforeMidnight - 60_000,
    now: beforeMidnight,
  }), false);
  assert.equal(helpers.suggestionsRefreshNeeded({
    ready: true,
    loaded: true,
    loading: false,
    pending: false,
    fetchedAt: beforeMidnight,
    now: midnight,
  }), true);
});

test("vanilla frontend preserves every same-origin API and visibility contract", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  for (const route of [
    "/api/status",
    "/api/suggestions",
    "/api/chat",
    "/api/inquiries",
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/logout",
  ]) {
    assert.ok(script.includes(route), route);
  }
  assert.ok(script.includes("/api/admin/${endpoint}"));
  for (const endpoint of ["config", "test", "oa-test", "extract", "documents", "inquiries"]) {
    assert.match(script, new RegExp(`adminRequest\\(["']${endpoint}["']`, "u"), endpoint);
  }
  assert.match(script, /(?:window\.)?location\.pathname\s*===?\s*["']\/manage["']/u);
  assert.match(script, /\bconst\s+APP_NAME\s*=\s*["']ARTS Robotics AI Assistant["']\s*;/u);
  for (const section of [
    "成果与应用",
    "科研与合作",
    "公司与产品",
    "协会与活动",
  ]) {
    assert.ok(script.includes(section), section);
  }
  for (const removedStaticQuestion of [
    "四足巡检机器人最近有什么新进展？",
    "最近公开了哪些机器人技术成果？",
    "ARTS Robotics 最近公开了哪些研究成果？",
    "近期有哪些新的科研合作与交流？",
    "新上线的四个 AI 模块有什么区别？",
    "OmindOS 最近新增了哪些能力？",
    "IUS 最近有哪些活动或项目？",
    "近期开放了哪些学生创新机会？",
  ]) {
    assert.equal(script.includes(removedStaticQuestion), false, removedStaticQuestion);
  }
  assert.match(script, /id:\s*["']technology["'][\s\S]*?requestTopic:\s*["']research["']/u);
  assert.match(script, /id:\s*["']academic["'][\s\S]*?requestTopic:\s*["']research["']/u);
  assert.match(script, /id:\s*["']company["'][\s\S]*?requestTopic:\s*["']business["']/u);
  assert.match(script, /id:\s*["']association["'][\s\S]*?requestTopic:\s*["']student["']/u);
  assert.match(script, /\bpublished\s*:\s*0\b/u);
  assert.ok(script.includes("保存并提交 OA 待审"));
  assert.ok(script.includes("未经审核的资料不会用于回答。"));
  assert.ok(script.includes(".txt,.md,.pdf,.jpg,.jpeg,.png,.webp"));
  assert.ok(script.includes("PDF、扫描件和图片"));
  assert.ok(script.includes("发送至 Cloudflare AI 临时解析"));
  assert.ok(script.includes("本站不保存原件"));
  assert.ok(script.includes("解析正文不设 30000 字上限"));
  assert.ok(script.includes("TXT、Markdown 单个文件最多 5 MB"));
  assert.ok(script.includes("每批最多 100 个、总计 500 MB"));
  assert.ok(script.includes("最多 3 个并行任务"));
  assert.ok(script.includes("合并为一条 Markdown 正文"));
  assert.ok(script.includes("OA 作为 1 条资料统一审核"));
  assert.ok(script.includes("每个不超过 20000 字"));
  assert.ok(script.includes("OA 接收成功后才清空"));
  assert.ok(script.includes("批量导入将替换当前正文"));
  assert.ok(script.includes("请重新上传修改后的完整文件"));
  assert.ok(script.includes("成功提交后会更新原条目并保留审计链"));
  assert.ok(script.includes("本次仅替换正文，标题、分类、资料日期、来源链接和可见范围沿用原 OA 条目"));
  for (const control of ["title.input", "category", "date.input", "url.input", "body"]) {
    assert.match(script, new RegExp(`${control.replace(".", "\\.")}\\.disabled\\s*=\\s*Boolean\\(state\\.busy\\)`, "u"));
  }
  assert.match(script, /\.slice\(0,\s*120\)/u);
  assert.match(script, /multiple:\s*true/u);
  assert.match(script, /webkitdirectory:\s*true/u);
  assert.match(script, /className:\s*["']import-progress["']/u);
  assert.match(script, /重试失败项/u);
  assert.match(script, /focusImportedField\(imported\s*\?\s*["']document-body["']/u);
  assert.match(script, /adminRequest\(["']extract["'][\s\S]*?body:\s*descriptor\.file/u);
  assert.match(script, /"X-File-Name":\s*encodeURIComponent\(descriptor\.file\.name\)/u);
  assert.match(script, /new TextDecoder\(["']utf-8["'],\s*\{\s*fatal:\s*true\s*\}\)/u);
  assert.match(script, /decodeImportedUtf8\(await descriptor\.file\.arrayBuffer\(\)\)/u);
  assert.doesNotMatch(script, /await file\.text\(\)/u);
  assert.doesNotMatch(script, /!isText\s*&&\s*text\.length\s*>\s*CHAT_DIRECT_OA_THRESHOLD_CHARACTERS/u);
  assert.doesNotMatch(script, /id:\s*["']document-body["'][\s\S]{0,160}maxlength:\s*["']30000["']/u);
  assert.match(script, /signal:\s*AbortSignal\.timeout\(120_000\)/u);
  assert.match(script, /submissionRequestId:\s*["']["']/u);
  assert.doesNotMatch(script, /每条资料最多 30000 字/u);
  assert.match(script, /if \(!returnedKnowledgeItemId && state\.draft\.id && normalizedBody\.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS\)[\s\S]*?已有 Chat 草稿不能直接改为大型正文/u);
  assert.match(script, /const id = state\.draft\.id \|\| state\.draft\.submissionRequestId \|\| makeRequestId\(\)/u);
  assert.match(script, /state\.draft\.submissionRequestId = id/u);
  assert.match(script, /await submitDocumentToOa\(\{ \.\.\.state\.draft, id \}, \{[\s\S]*?submissionContext: \{ returnedKnowledgeItemId \}[\s\S]*?\}\);[\s\S]*?state\.draft = emptyDraft\(\)/u);
  assert.match(script, /if \(returnedKnowledgeItemId \|\| normalizedBody\.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS\)[\s\S]*?await submitDocumentToOa[\s\S]*?return;[\s\S]*?adminRequest\("documents"/u);
  const directSubmitStart = script.indexOf("if (returnedKnowledgeItemId || normalizedBody.length > CHAT_DIRECT_OA_THRESHOLD_CHARACTERS)");
  const directSubmitEnd = script.indexOf("const draft = { ...state.draft }", directSubmitStart);
  assert.ok(directSubmitStart >= 0 && directSubmitEnd > directSubmitStart);
  assert.doesNotMatch(script.slice(directSubmitStart, directSubmitEnd), /state\.draft\.id\s*=\s*id/u);
  const submitToOa = script.slice(script.indexOf("async function submitDocumentToOa"), script.indexOf("async function lookupDocumentSubmissionState"));
  assert.doesNotMatch(submitToOa, /state\.returnedKnowledgeItemId/u);
  assert.match(submitToOa, /\.\.\.\(returnedKnowledgeItemId \? \{ returnedKnowledgeItemId \} : \{\}\)/u);
  const checkpointIndex = submitToOa.indexOf('submissionState: "unknown"');
  const oaPostIndex = submitToOa.indexOf("fetch(OA_CHAT_IMPORT_URL");
  assert.ok(checkpointIndex >= 0 && oaPostIndex > checkpointIndex);
  const assetUploadIndex = submitToOa.indexOf("await uploadKnowledgeAssetsToOa");
  const submittedPatchIndex = submitToOa.indexOf('submissionState: "submitted"');
  assert.ok(assetUploadIndex >= 0 && submittedPatchIndex > assetUploadIndex);
  assert.match(script, /Promise\.allSettled\(unknown\.slice\(index, index \+ 5\)\.map\(lookupDocumentSubmissionState\)\)/u);
  assert.match(script, /if \(state\.oaStatusSyncing\)[\s\S]*?state\.oaStatusSyncQueued = true/u);
  assert.match(script, /if \(rerun && !state\.returnedKnowledgeItemId\) void reconcileUnknownDocumentStatuses\(\)/u);
  assert.equal(submitToOa.match(/clearReturnedKnowledgeContext\(returnedKnowledgeItemId\)/gu)?.length, 1);
  assert.ok(submitToOa.indexOf("clearReturnedKnowledgeContext(returnedKnowledgeItemId)") > submitToOa.indexOf("const oaItemId"));
  assert.match(script, /state\.returnedKnowledgeItemId = "";[\s\S]*?history\.replaceState[\s\S]*?withoutReturnedKnowledgeItemQuery/u);
  assert.match(script, /if \(state\.returnedKnowledgeItemId\) \{[\s\S]*?本地草稿已暂时隐藏，不能编辑或提交[\s\S]*?\} else if \(!state\.documents\.length\)/u);
  assert.match(script, /submitDocumentToOa\(document\)\);/u);
  const externalApis = [...script.matchAll(/https?:\/\/[^\s"'`]+\/api\/[^\s"'`]+/giu)].map((match) => match[0]);
  assert.deepEqual(externalApis, [
    "https://oa.omindos.ai/api/knowledge/import-chat",
    "https://oa.omindos.ai/api/knowledge/import-chat/status",
    "https://oa.omindos.ai/api/knowledge/assets",
    "https://oa.omindos.ai/api/knowledge/assets/finalize",
  ]);

  for (const forbidden of [
    "马教授 AI 助手",
    "ask_professor_assistant",
    "legacy_seed",
    "非 OA 审核",
    "published:o.published",
  ]) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(script, /\bpublished\s*:\s*(?:1|true)\b/u);
});

test("ZIP helper keeps the main file picker open to images and accepts normal ZIP filenames", async () => {
  const source = await readFile(path.join(frontendDir, "zip-import-addon.js"), "utf8");
  assert.doesNotMatch(source, /setAttribute\(["']accept["'],\s*["']\.md,\.zip/u);
  assert.doesNotMatch(source, /addEventListener\(["']change["']/u);
  assert.doesNotMatch(source, /stopImmediatePropagation|dispatchEvent\(new Event\(["']change["']/u);
  assert.doesNotMatch(source, /flags\s*&\s*0x0800[\s\S]{0,80}ZIP 内文件名必须使用 UTF-8 编码/u);
  assert.match(source, /decodeZipName\(new Uint8Array\(arrayBuffer,\s*nameStart,\s*nameLength\)\)/u);
});

test("document rows show exact persisted OA labels and submit only unsubmitted drafts", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");
  const start = script.indexOf("function renderDocumentsPanel");
  const end = script.indexOf("function parseTranscript", start);
  assert.ok(start >= 0 && end > start, "document panel must remain directly testable");
  const panel = script.slice(start, end);

  assert.match(
    panel,
    /const submissionLabel = submissionState === "submitted"\s*\? "OA 待审核"\s*: submissionState === "unsubmitted"\s*\? "待提交 OA 审核"/u,
  );
  assert.equal((panel.match(/["']OA 待审核["']/gu) || []).length, 1);
  assert.equal((panel.match(/["']待提交 OA 审核["']/gu) || []).length, 1);

  const guardStart = panel.indexOf('if (submissionState === "unsubmitted")');
  const otherStateStart = panel.indexOf("} else {", guardStart);
  const rowBodyStart = panel.indexOf("const documentBody", otherStateStart);
  assert.ok(guardStart >= 0 && otherStateStart > guardStart && rowBodyStart > otherStateStart);
  const unsubmittedActions = panel.slice(guardStart, otherStateStart);
  const otherStateActions = panel.slice(otherStateStart, rowBodyStart);
  assert.match(unsubmittedActions, /textButton\([^)]*"提交 OA 待审"/u);
  assert.match(unsubmittedActions, /submitDocumentToOa\(document\)/u);
  assert.doesNotMatch(otherStateActions, /提交 OA 待审|submitDocumentToOa\(document\)/u);
  assert.equal((panel.match(/submitDocumentToOa\(document\)/gu) || []).length, 1);
});

test("public chat persists multiple conversations and derives a bounded recent list", async () => {
  const helpers = await frontendConversationHelpers();
  assert.equal(helpers.CHAT_CONVERSATIONS_KEY, "arts-public-chat-conversations-v2");
  assert.equal(helpers.CHAT_CONVERSATION_LIMIT, 20);
  assert.equal(helpers.CHAT_RECENT_LIMIT, 8);

  const now = Date.UTC(2026, 8, 14, 8);
  const conversation = (id, section, question, updatedAt) => ({
    id,
    section,
    title: "新聊天",
    createdAt: updatedAt - 1_000,
    updatedAt,
    messages: question ? [
      { role: "user", content: question },
      { role: "assistant", content: `${question}的回答` },
    ] : [],
    conversationToken: "",
    tokenSavedAt: 0,
    draft: question ? "" : "尚未发送的草稿",
    scrollTop: 12,
    stickToEnd: false,
    sending: false,
    error: "",
    notice: "",
  });
  const older = conversation("conversation_old", "technology", "较早的话题", now - 2_000);
  const newer = conversation("conversation_new", "company", "最近的话题", now - 1_000);
  const draftOnly = conversation("conversation_draft", "academic", "", now - 500);

  const snapshot = helpers.chatConversationsSnapshot([older, newer, draftOnly], older.id, now);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.activeConversationId, older.id);
  assert.deepEqual([...snapshot.conversations].map(({ id }) => id), [draftOnly.id, newer.id, older.id]);
  assert.equal(snapshot.conversations[1].title, "最近的话题");

  const recent = [...helpers.recentChatConversations([older, newer, draftOnly])];
  assert.deepEqual(recent.map(({ id }) => id), [newer.id, older.id]);
  assert.equal(helpers.chatConversationTitle([
    { role: "user", content: "这是一段超过三十个字符、应当自动截断为最近聊天标题的测试问题文本内容" },
  ]).endsWith("…"), true);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(helpers.writeChatConversations(storage, [older, newer, draftOnly], newer.id, now), true);
  assert.ok(values.has(helpers.CHAT_CONVERSATIONS_KEY));
  const restored = helpers.readChatConversations(
    storage,
    ["technology", "academic", "company", "association"],
    now,
  );
  assert.equal(restored.activeConversationId, newer.id);
  assert.deepEqual([...restored.conversations].map(({ id }) => id), [draftOnly.id, newer.id, older.id]);
});

test("public chat presents four fixed knowledge domains in desktop and mobile sidebars", async () => {
  const [script, style, topicHelpers] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
    frontendTopicHelpers(),
  ]);
  const topicBlock = script.slice(script.indexOf("const TOPICS = ["), script.indexOf("const DEFAULT_TOPIC_ID"));
  assert.deepEqual(
    [...topicBlock.matchAll(/\btitle:\s*["']([^"']+)["']/gu)].map((match) => match[1]),
    ["成果与应用", "科研与合作", "公司与产品", "协会与活动"],
  );
  assert.match(script, /const GENERAL_CHAT_TOPIC\s*=\s*Object\.freeze\(\{[\s\S]{0,240}?id:\s*["']general["'][\s\S]{0,160}?path:\s*["']\/["'][\s\S]{0,160}?title:\s*["']聊天["'][\s\S]{0,160}?detail:\s*["']全部公开知识["']/u);
  assert.match(script, /const CHAT_TOPICS\s*=\s*Object\.freeze\(\[GENERAL_CHAT_TOPIC,\s*\.\.\.TOPICS\]\)/u);
  assert.equal(topicHelpers.DEFAULT_TOPIC_ID, "general");
  assert.equal(topicHelpers.topicIdForPath("/"), "general");
  assert.equal(topicHelpers.topicIdForPath("/technology"), "technology");
  assert.equal(JSON.stringify([...topicHelpers.TOPICS].map((topic) => topic.id)), JSON.stringify([
    "technology", "academic", "company", "association",
  ]));
  assert.equal(JSON.stringify([...topicHelpers.CHAT_TOPICS].map((topic) => topic.id)), JSON.stringify([
    "general", "technology", "academic", "company", "association",
  ]));
  assert.ok(script.includes("const topic = CHAT_TOPICS.find((item) => item.id === section) || GENERAL_CHAT_TOPIC;"));
  assert.match(script, /readChatConversations\(historyStorage,\s*CHAT_TOPICS\.map\(\(topic\) => topic\.id\)\)/u);

  assert.match(
    script,
    /const desktopSidebar\s*=\s*element\(["']aside["'],\s*\{[\s\S]{0,160}?className:\s*["']chat-sidebar["']/u,
  );
  assert.match(script, /desktopSidebar\.append\(sidebarContent\(\)\)/u);
  assert.match(
    script,
    /const pinnedLabel[\s\S]{0,180}?text:\s*["']大模型与资料["'][\s\S]{0,300}?className:\s*["']sidebar-topic-list["']/u,
  );
  assert.match(
    script,
    /const recentLabel[\s\S]{0,200}?text:\s*["']最近聊天["'][\s\S]{0,320}?className:\s*["']sidebar-recent-list["']/u,
  );
  const recentStart = script.indexOf("function renderRecentConversations()");
  const recentEnd = script.indexOf("function createConversation", recentStart);
  assert.ok(recentStart >= 0 && recentEnd > recentStart, "recent-chat renderer must remain directly inspectable");
  assert.match(script.slice(recentStart, recentEnd), /textButton\(["']["'],\s*["']sidebar-recent-item["']\)/u);

  assert.match(
    script,
    /const topicDrawer\s*=\s*element\(["']dialog["'],\s*\{[\s\S]{0,180}?id:\s*["']topic-drawer["'][\s\S]{0,120}?className:\s*["']topic-drawer["']/u,
  );
  assert.match(script, /drawerPanel\.append\(sidebarContent\(\{\s*mobile:\s*true\s*\}\)\)/u);
  assert.ok(script.includes("topicDrawer.showModal()"));
  assert.ok(script.includes('menuButton.setAttribute("aria-controls", "topic-drawer")'));

  const marker = "/* ChatGPT-inspired application shell (final visual overrides). */";
  const styleStart = style.indexOf(marker);
  assert.ok(styleStart >= 0, "final ChatGPT-style CSS overrides must remain identifiable");
  const shellStyle = style.slice(styleStart);
  assert.match(
    shellStyle,
    /@media \(max-width:\s*899px\)[\s\S]{0,650}?\.chat-app \.chat-sidebar\s*\{[\s\S]{0,80}?display:\s*none/u,
  );
  assert.match(
    shellStyle,
    /\.topic-drawer \.drawer-panel\s*\{[\s\S]{0,160}?width:\s*min\(86vw,\s*var\(--chat-sidebar-width,\s*280px\)\)/u,
  );
});

test("the sidebar chat action opens a general new-chat dialog with suggestions and a form", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(
    script,
    /const chatButton\s*=\s*textButton\(["']["'],\s*["']sidebar-chat-button["']\)[\s\S]{0,240}?aria-controls["'],\s*["']new-chat-dialog["'][\s\S]{0,300}?text:\s*["']聊天["'][\s\S]{0,220}?openNewChat\(chatButton\)/u,
  );
  assert.match(
    script,
    /id:\s*["']new-chat-dialog["'][\s\S]{0,120}?className:\s*["']new-chat-dialog["']/u,
  );
  assert.match(
    script,
    /function openNewChat\([^)]*\)[\s\S]{0,900}?newChatDialog\.showModal\(\)/u,
  );
  assert.match(script, /let newChatSection\s*=\s*GENERAL_CHAT_TOPIC\.id/u);
  assert.match(
    script,
    /function openNewChat\([^)]*\)[\s\S]{0,360}?newChatSection\s*=\s*GENERAL_CHAT_TOPIC\.id[\s\S]{0,180}?newChatContextValue\.textContent\s*=\s*GENERAL_CHAT_TOPIC\.detail/u,
  );
  assert.match(script, /className:\s*["']new-chat-suggestions["']/u);
  assert.match(script, /className:\s*["']new-chat-suggestion-list["']/u);
  assert.match(script, /className:\s*["']new-chat-suggestion-caption["'][\s\S]{0,120}?今日推荐 · 基于公开知识，每日更新/u);
  assert.match(
    script,
    /const newChatForm\s*=\s*element\(["']form["'],\s*\{\s*className:\s*["']new-chat-form["']/u,
  );
  assert.match(
    script,
    /newChatPanel\.append\(newChatHeader,\s*newChatContext,\s*newChatSuggestionPanel,\s*newChatForm\)/u,
  );
  assert.match(
    script,
    /function renderNewChatSuggestions\(\)[\s\S]{0,900}?textButton\(["']["'],\s*["']new-chat-suggestion["']\)[\s\S]{0,650}?startNew:\s*true/u,
  );
  assert.match(
    script,
    /newChatForm\.addEventListener\(["']submit["'][\s\S]{0,220}?startNewChatQuestion\(newChatInput\.value\)/u,
  );
  assert.match(
    script,
    /function startNewChatQuestion\([^)]*\)[\s\S]{0,420}?createConversation\(newChatSection\)[\s\S]{0,240}?dispatchQuestion\(question,\s*conversation\.id,\s*suggestionToken\)/u,
  );

  const shellStyle = style.slice(style.indexOf("/* ChatGPT-inspired application shell (final visual overrides). */"));
  const mobileStyle = shellStyle.slice(
    shellStyle.indexOf("@media (max-width: 899px)"),
    shellStyle.indexOf("@media (min-width: 900px)", shellStyle.indexOf("@media (max-width: 899px)")),
  );
  assert.match(shellStyle, /\.chat-app \.sidebar-bottom\s*\{[\s\S]{0,220}?margin-top:\s*auto/u);
  assert.match(shellStyle, /\.chat-app \.sidebar-chat-button\s*\{[\s\S]{0,240}?background:\s*var\(--chat-blue\)/u);
  assert.match(shellStyle, /\.new-chat-dialog\[open\]\s*\{[\s\S]{0,120}?display:\s*flex/u);
  assert.match(shellStyle, /\.new-chat-suggestion-list\s*\{[\s\S]{0,220}?flex-direction:\s*column[\s\S]{0,160}?justify-content:\s*flex-start[\s\S]{0,100}?margin-top:\s*auto/u);
  assert.match(shellStyle, /\.new-chat-suggestion-caption\s*\{[\s\S]{0,180}?text-align:\s*left/u);
  assert.match(shellStyle, /\.new-chat-suggestion-list > button:nth-child\(n \+ 6\)[\s\S]{0,100}?display:\s*none/u);
  assert.match(shellStyle, /\.new-chat-form\s*\{[\s\S]{0,100}?display:\s*flex/u);
  assert.match(mobileStyle, /\.new-chat-dialog\[open\]\s*\{[\s\S]{0,100}?align-items:\s*flex-end/u);
});

test("knowledge recommendations accept only bounded questions returned by the API", async () => {
  const normalize = await frontendSuggestionHelpers();
  assert.deepEqual(
    [...normalize({
      suggestions: [
        { question: "  知识库问题一？  " },
        { question: "知识库问题一？" },
        { question: "知识库问题二？" },
        { question: "x".repeat(301) },
        { question: "知识库问题三？" },
        { question: "知识库问题四？" },
        { question: "知识库问题五？" },
        { question: "不会被选中的第六个问题？" },
      ],
    })],
    ["知识库问题一？", "知识库问题二？", "知识库问题三？", "知识库问题四？", "知识库问题五？"],
  );
  assert.deepEqual([...normalize({ suggestions: ["静态字符串不属于接口契约", {}, null] })], []);
  assert.deepEqual([...normalize({ suggestions: [] })], []);
  assert.deepEqual([...normalize(null)], []);
});

test("public chat keeps a compact composer with vertically stacked knowledge suggestions", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  const shellStyle = style.slice(style.indexOf("/* ChatGPT-inspired application shell (final visual overrides). */"));
  const mobileStyle = shellStyle.slice(
    shellStyle.indexOf("@media (max-width: 899px)"),
    shellStyle.indexOf("@media (min-width: 900px)", shellStyle.indexOf("@media (max-width: 899px)")),
  );

  assert.match(script, /className:\s*["']topic-title["']/u);
  assert.match(script, /textButton\(["']["'],\s*["']menu-button["']\)/u);
  assert.match(script, /rows:\s*["']1["']/u);
  assert.match(script, /placeholder:\s*["']询问实验室大数据["']/u);
  assert.match(script, /textButton\(["']发送["'],\s*["']send-button["']\)/u);
  assert.match(script, /sendButton\.textContent\s*=\s*session\.sending\s*\?\s*["']回答中["']\s*:\s*["']发送["']/u);
  assert.ok(script.includes("正在检索并生成回答…"));
  assert.equal(script.includes("正在整理回答…"), false);
  assert.match(script, /className:\s*["']composer-suggestions["']/u);
  assert.match(script, /className:\s*["']suggestion-caption["'][\s\S]{0,120}?今日推荐 · 基于公开知识，每日更新/u);
  assert.match(script, /suggestionPanel\.hidden\s*=\s*true/u);
  assert.match(script, /composerArea\.append\(errorRegion,\s*noticeRegion,\s*composer\)/u);
  assert.match(script, /conversation\.append\(messageScroll,\s*suggestionPanel,\s*composerArea\)/u);
  assert.match(
    script,
    /suggestionPanel\.hidden\s*=\s*!recommendationsReady\(\)\s*\|\|\s*session\.messages\.length\s*>\s*0\s*\|\|\s*session\.sending\s*\|\|\s*state\.suggestions\.length\s*===\s*0/u,
  );
  assert.match(script, /function recommendationsReady\(\) \{[\s\S]{0,180}?knowledgeRetrievalReady\(\)\s*&&\s*systemStatusController\s*===\s*null/u);
  assert.match(script, /function knowledgeRetrievalReady\(\) \{[\s\S]{0,220}?state\.networkReady\s*===\s*true[\s\S]{0,220}?state\.service\?\.knowledgeReady\s*===\s*true[\s\S]{0,220}?state\.service\?\.retrievalReady\s*===\s*true/u);
  assert.match(script, /requestJson\(["']\/api\/suggestions["'],\s*\{[\s\S]{0,180}?cache:\s*["']no-store["']/u);
  assert.doesNotMatch(script, /SUGGESTIONS_REFRESH_MS\s*=\s*60_000/u);
  assert.match(script, /function suggestionsRefreshDelay\([^)]*\)[\s\S]{0,320}?BEIJING_UTC_OFFSET_MS/u);
  assert.match(script, /if \(force\) \{[\s\S]{0,120}?state\.suggestions\s*=\s*\[\][\s\S]{0,120}?renderSuggestions\(\)/u);
  assert.match(script, /suggestionsRefreshDueAt[\s\S]{0,700}?suggestionsRefreshPending\s*=\s*true[\s\S]{0,100}?loadSuggestions\(\{ force: true \}\)/u);
  assert.match(script, /if \(!recommendationsReady\(\) \|\| state\.suggestionsLoading\) \{[\s\S]{0,180}?suggestionsRefreshPending\s*=\s*true/u);
  assert.match(script, /suggestionsRefreshNeeded\(\{[\s\S]{0,360}?pending:\s*suggestionsRefreshPending[\s\S]{0,360}?void loadSuggestions/u);
  assert.match(script, /current\s*=\s*knowledgeSuggestionsFromPayload\(payload\)/u);
  assert.match(script, /let current\s*=\s*\[\][\s\S]{0,420}?catch\s*\{[\s\S]{0,160}?Never replace verified knowledge with static guesses/u);
  assert.match(script, /button\.append\([\s\S]{0,220}?className:\s*["']suggestion-sparkle["'][\s\S]{0,180}?aria-hidden["']:\s*["']true["'][\s\S]{0,180}?element\(["']span["'],\s*\{\s*text:\s*suggestion\s*\}\)/u);
  assert.match(script, /button\.addEventListener\(["']click["'],[\s\S]{0,120}?dispatchSuggestion\(suggestion,\s*conversationId\)/u);
  const dispatchStart = script.indexOf("async function dispatchSuggestion");
  const dispatchEnd = script.indexOf("function scheduleSuggestionsRefresh", dispatchStart);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, "suggestion dispatch must remain directly inspectable");
  const dispatchSuggestion = script.slice(dispatchStart, dispatchEnd);
  assert.match(dispatchSuggestion, /epoch\s*===\s*suggestionsEpoch/u);
  assert.match(
    dispatchSuggestion,
    /if \(epoch\s*!==\s*suggestionsEpoch\s*\|\|\s*!current\.includes\(question\)\s*\|\|\s*!recommendationsReady\(\)\) return/u,
  );
  assert.match(script, /function invalidateSuggestions\(\)[\s\S]{0,400}?suggestionsEpoch\s*\+=\s*1[\s\S]{0,400}?suggestionsRefreshPending\s*=\s*false/u);
  assert.match(script, /if \(statusRefreshDue\) \{\s*void loadSystemStatus\(\{ showPending: true \}\);\s*\} else if \(suggestionsRefreshDue\)/u);
  assert.doesNotMatch(script, /\b(?:featuredSuggestions|fallbackSuggestions|suggestionsForTopic)\b/u);
  assert.equal(script.includes("聊聊新话题"), false);
  assert.doesNotMatch(script, /className:\s*["']suggestion-arrow["']/u);
  for (const removedClass of ["context-panel", "conversation-toolbar", "composer-footer", "site-footer", "topic-select"]) {
    assert.doesNotMatch(script, new RegExp(`className:\\s*["']${removedClass}["']`, "u"), removedClass);
  }
  for (const removedCopy of [
    "从一个问题，走近机器人研究。",
    "机器人自主自动与操作实验室",
    "AI 回答仅供参考，不构成 ARTS Robotics",
    "OriginMind x ARTS Robotics",
  ]) {
    assert.equal(script.includes(removedCopy), false, removedCopy);
  }
  assert.match(shellStyle, /\.chat-app\s+\.composer\s*\{[\s\S]{0,120}?display:\s*flex/u);
  assert.match(style, /\.chat-app\s+\.composer-suggestions\s*\{[\s\S]*?flex:\s*0 0 auto[\s\S]*?width:\s*100%/u);
  assert.match(shellStyle, /\.chat-app\s+\.suggestions\s*\{[\s\S]{0,260}?flex-direction:\s*column[\s\S]{0,180}?justify-content:\s*flex-start[\s\S]{0,260}?overflow-y:\s*auto[\s\S]{0,100}?flex-wrap:\s*nowrap/u);
  assert.match(shellStyle, /\.chat-app\s+\.suggestion-caption\s*\{[\s\S]{0,220}?text-align:\s*left/u);
  assert.match(shellStyle, /\.chat-app\s+\.suggestion-button\s*\{[\s\S]{0,520}?display:\s*grid[\s\S]{0,180}?width:\s*min\(100%,\s*680px\)[\s\S]{0,180}?min-height:\s*44px[\s\S]{0,220}?grid-template-columns:\s*24px minmax\(0,\s*1fr\)[\s\S]{0,260}?border:\s*0[\s\S]{0,100}?border-radius:\s*12px[\s\S]{0,260}?text-align:\s*left/u);
  assert.match(shellStyle, /\.chat-app\s+\.suggestion-button:nth-child\(n \+ 6\)\s*\{[\s\S]{0,60}?display:\s*none/u);
  assert.match(shellStyle, /\.chat-app\s+\.suggestions\s*\{[\s\S]{0,260}?align-items:\s*flex-start/u);
  assert.match(mobileStyle, /\.chat-app \.suggestions\s*\{[\s\S]{0,120}?align-items:\s*flex-start/u);
  assert.match(shellStyle, /\.chat-app\s+\.composer:focus-within\s*\{[\s\S]{0,180}?outline:\s*2px solid #0b57d0/u);
  assert.match(shellStyle, /\.chat-app\s+\.composer\s+textarea\s*\{[\s\S]{0,180}?min-height:\s*50px/u);
  assert.match(shellStyle, /\.chat-app\s+\.send-button\s*\{[\s\S]{0,180}?height:\s*44px/u);
  assert.ok(script.includes('document.body.classList.add("public-chat-page")'));
  assert.ok(script.includes("window.visualViewport"));
  assert.ok(script.includes('app.style.setProperty("--chat-viewport-height"'));
  assert.ok(script.includes('app.style.setProperty("--chat-viewport-offset"'));
  assert.match(style, /body\.public-chat-page\s*\{[\s\S]*?overflow:\s*hidden/u);
  assert.match(style, /\.chat-app\s*\{[\s\S]*?height:\s*var\(--chat-viewport-height,\s*100dvh\)[\s\S]*?transform:\s*translateY\(var\(--chat-viewport-offset,\s*0px\)\)/u);
  assert.match(script, /function\s+userFacingAnswer\s*\(/u);
  assert.match(script, /content:\s*userFacingAnswer\(payload\.answer\)/u);
  assert.doesNotMatch(script, /className:\s*["']source-(?:list|button|dialog)["']/u);
  assert.doesNotMatch(style, /\.source-(?:list|button|dialog)\b/u);
});

test("public chat keeps five compact live status lights below the fixed header title", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  for (const [key, label] of [
    ["network", "网络"],
    ["oa", "OA"],
    ["qwen", "千问"],
    ["knowledge", "OA 知识"],
    ["system", "系统"],
  ]) {
    assert.match(script, new RegExp(`key:\\s*["']${key}["']\\s*,\\s*label:\\s*["']${label}["']`, "u"), key);
  }
  assert.match(script, /className:\s*["']topic-header["'][\s\S]{0,220}?\[\s*topicTitle,\s*topicSubtitle,\s*systemStatus,/u);
  assert.match(script, /LAB_MODEL_CAPABILITIES[\s\S]*@知识问答[\s\S]*@项目总结[\s\S]*@资料处理[\s\S]*@会议纪要/u);
  assert.match(script, /header\.append\(menuButton,\s*topicHeader,\s*chatInfoButton/u);
  assert.match(script, /SYSTEM_STATUS_REFRESH_MS\s*=\s*60_000/u);
  assert.match(script, /SYSTEM_STATUS_RETRY_MS\s*=\s*5_000/u);
  assert.match(script, /SYSTEM_STATUS_TIMEOUT_MS\s*=\s*15_000/u);
  assert.match(script, /fetch\(["']\/_health["']/u);
  assert.match(script, /requestJson\(["']\/api\/status["']/u);
  assert.match(script, /timeoutMessage\s*=\s*["']请求超时，请稍后重试。["']/u);
  assert.match(script, /adminRequest\(["']extract["'][\s\S]{0,360}?timeoutMessage:\s*["']文件处理超时，请压缩或拆分文件后重试。["']/u);
  assert.match(script, /service\.systemReady\s*===\s*true/u);
  assert.match(script, /service\?\.knowledgeReady\s*===\s*true\s*&&\s*service\?\.retrievalReady\s*===\s*true/u);
  assert.match(script, /function\s+reconcileChatOaStatus\s*\(/u);
  assert.match(script, /const oaEvidenceEpoch\s*=\s*\+\+systemStatusEpoch/u);
  assert.match(script, /reconcileChatOaStatus\(payload,\s*oaEvidenceEpoch\)/u);
  assert.match(script, /["']connected["'][\s\S]{0,180}?["']auth_error["'][\s\S]{0,180}?["']rate_limited["'][\s\S]{0,180}?["']timeout["'][\s\S]{0,180}?["']invalid_response["']/u);
  assert.match(script, /evidenceEpoch\s*!==\s*currentEpoch/u);
  assert.match(script, /reconcileChatOaStatus[\s\S]{0,900}?scheduleNextSystemStatusRefresh\(\)/u);
  assert.match(script, /nextRetryDelay:\s*Math\.min\(SYSTEM_STATUS_REFRESH_MS,\s*delay\s*\*\s*2\)/u);
  assert.match(script, /if \(document\.hidden\)[\s\S]{0,120}?systemStatusRefreshDueAt\s*=\s*Date\.now\(\)/u);
  assert.match(script, /Array\.isArray\(payload\.sources\)\s*&&\s*payload\.sources\.length\s*>\s*0/u);
  assert.doesNotMatch(script, /OA 检索繁忙/u);
  assert.doesNotMatch(script, /OA 公开知识暂不可用，请核对两端 Token 和 OA 部署状态/u);
  assert.ok(script.includes("OA 检索检测超时，系统会自动重试；无需重复填写 Token。"));
  assert.match(script, /textButton\(\s*["']["']\s*,\s*["']system-status-strip["']\s*\)/u);
  assert.ok(script.includes('systemStatus.setAttribute("aria-controls", "system-status-details")'));
  assert.ok(script.includes('systemStatus.setAttribute("aria-expanded", "false")'));
  assert.match(script, /id:\s*["']system-status-details["'][\s\S]{0,180}?role:\s*["']region["']/u);
  assert.match(script, /systemStatusAnnouncement[\s\S]{0,220}?role:\s*["']status["'][\s\S]{0,120}?["']aria-live["']:\s*["']polite["']/u);
  assert.match(script, /nodes\.panelDetail\.textContent\s*=\s*detail/u);
  assert.match(script, /systemStatusAnnouncement\.textContent\s*=\s*description/u);
  assert.match(style, /\.system-status-strip\s*\{[\s\S]*?height:\s*24px/u);
  assert.match(style, /\.system-status-details\s*\{[\s\S]*?position:\s*absolute/u);
  assert.match(style, /\.chat-app\s+\.site-header\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)/u);
  assert.match(style, /\.system-light-dot\.is-ok\s*\{[\s\S]*?background:\s*#067a3d/u);
});

test("public modules keep direct paths while the mobile drawer reuses sidebar topic links", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  const mappings = [
    ["technology", "/technology", "research"],
    ["academic", "/research", "research"],
    ["company", "/originmind", "business"],
    ["association", "/ius", "student"],
  ];
  for (const [id, directPath, requestTopic] of mappings) {
    assert.match(
      script,
      new RegExp(`id:\\s*["']${id}["'][\\s\\S]*?path:\\s*["']${directPath}["'][\\s\\S]*?requestTopic:\\s*["']${requestTopic}["']`, "u"),
      directPath,
    );
  }
  assert.match(script, /const initialSection\s*=\s*topicIdForPath\(window\.location\.pathname\)/u);
  assert.match(script, /window\.history\.pushState\(/u);
  assert.match(script, /window\.addEventListener\(["']popstate["']/u);
  assert.match(script, /className:\s*["']sidebar-topic-link["'][\s\S]{0,160}?href:\s*topic\.path/u);
  assert.doesNotMatch(script, /className:\s*["']drawer-topic-link["']/u);
  assert.match(script, /desktopSidebar\.append\(sidebarContent\(\)\)/u);
  assert.match(script, /drawerPanel\.append\(sidebarContent\(\{\s*mobile:\s*true\s*\}\)\)/u);
  assert.ok(script.includes('menuButton.setAttribute("aria-controls", "topic-drawer")'));
  assert.ok(script.includes('menuButton.setAttribute("aria-expanded", "false")'));
  assert.ok(script.includes("topicDrawer.showModal()"));
  assert.ok(script.includes('topicDrawer.addEventListener("close"'));
  const shellStyle = style.slice(style.indexOf("/* ChatGPT-inspired application shell (final visual overrides). */"));
  assert.match(shellStyle, /\.topic-drawer\s*\{[\s\S]{0,100}?position:\s*fixed/u);
  assert.match(shellStyle, /\.chat-app \.sidebar-topic-link,[\s\S]{0,220}?min-height:\s*44px/u);
  assert.match(
    shellStyle,
    /\.topic-drawer \.drawer-panel\s*\{[\s\S]{0,160}?width:\s*min\(86vw,\s*var\(--chat-sidebar-width,\s*280px\)\)/u,
  );
});

test("public chat exposes an accessible full-screen chat information surface", async () => {
  const script = await readFile(path.join(frontendDir, "app.js"), "utf8");

  assert.match(script, /textButton\(\s*["']["']\s*,\s*["']chat-info-button["']\s*\)/u);
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-label", "聊天信息")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-controls", "chat-info-dialog")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-haspopup", "dialog")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-expanded", "false")'));
  assert.ok(script.includes('chatInfoButton.setAttribute("aria-expanded", "true")'));
  assert.match(script, /className:\s*["']more-glyph["'][\s\S]{0,500}?className:\s*["']more-dot["']/u);
  assert.equal((script.match(/className:\s*["']more-dot["']/gu) || []).length, 3);

  assert.match(script, /const\s+chatInfoDialog\s*=\s*element\(\s*["']dialog["']/u);
  assert.match(script, /\bid:\s*["']chat-info-dialog["']/u);
  assert.match(script, /\bclassName:\s*["']chat-info-dialog["']/u);
  assert.match(script, /element\(\s*["']h2["'][\s\S]{0,180}?\btext:\s*["']聊天信息["']/u);
  for (const label of ["查找聊天记录", "清空聊天记录"]) {
    assert.ok(script.includes(label), label);
  }
  for (const label of ["查找聊天记录", "清空聊天记录"]) {
    assert.match(script, new RegExp(`chatInfoActionRow\\(\\s*["']${label}["']`, "u"), label);
  }
  assert.match(script, /\bsrc:\s*["']\/favicon\.svg["']/u);

  assert.match(script, /function\s+openChatInfo\s*\([^)]*\)\s*\{[\s\S]{0,700}?chatInfoDialog\.showModal\(\)/u);
  assert.match(script, /function\s+closeChatInfo\s*\([^)]*\)\s*\{[\s\S]{0,500}?chatInfoDialog\.close\(\)/u);
  assert.ok(script.includes('chatInfoDialog.addEventListener("cancel"'));
  assert.match(
    script,
    /chatInfoDialog\.addEventListener\(\s*["']close["'][\s\S]{0,600}?chatInfoDialogOpener[\s\S]{0,400}?\.focus\(/u,
  );
  assert.match(script, /function\s+findChatMessage\s*\(/u);
  assert.match(script, /window\.prompt\(\s*["']查找聊天记录["']/u);
  assert.match(
    script,
    /chatInfoActionRow\(\s*["']清空聊天记录["']\s*,\s*\(\)\s*=>\s*\{[\s\S]{0,500}?window\.confirm\([^)]*清空当前聊天记录[^)]*\)[\s\S]{0,500}?resetCurrentConversation\(/u,
  );
});

test("chat information omits unavailable placeholder controls", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  for (const removedCopy of [
    "暂未开放",
    "添加成员",
    "消息免打扰",
    "置顶聊天",
    "提醒",
    "设置当前聊天背景",
    "投诉",
  ]) {
    assert.equal(script.includes(removedCopy), false, removedCopy);
  }
  assert.doesNotMatch(script, /chatInfo(?:Unavailable|Add)|chat-info-(?:unavailable|toggle|switch|add)/u);
  assert.doesNotMatch(style, /\.chat-info-(?:unavailable|toggle|switch|add)\b/u);
});

test("chat record search moves focus and marks the matching message semantically", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /className:\s*`message \$\{message\.role\}`[\s\S]{0,220}?tabindex:\s*["']-1["']/u);
  assert.match(script, /closeChatInfo\(\{\s*restoreFocus:\s*false\s*\}\)/u);
  assert.match(script, /match\.setAttribute\(\s*["']aria-current["']\s*,\s*["']true["']\s*\)/u);
  assert.match(script, /聊天记录搜索结果：\$\{originalLabel\}/u);
  assert.match(script, /match\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u);
  assert.match(script, /match\.removeAttribute\(\s*["']aria-current["']\s*\)/u);
  assert.match(script, /data-search-original-label/u);
  assert.match(style, /\.message\.search-match\s+\.message-body\s*\{[\s\S]*?outline:\s*3px solid #9a6500/u);
});

test("public chat uses a ChatGPT-style two-column shell with a single-column mobile fallback", async () => {
  const style = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  const marker = "/* ChatGPT-inspired application shell (final visual overrides). */";
  const styleStart = style.indexOf(marker);
  assert.ok(styleStart >= 0, "final ChatGPT-style CSS overrides must remain identifiable");
  const shellStyle = style.slice(styleStart);

  assert.match(
    shellStyle,
    /\.chat-app\s*\{\s*--chat-sidebar-width:[\s\S]{0,280}?display:\s*grid[\s\S]{0,160}?grid-template-areas:\s*[\r\n ]*["']sidebar header["'][\r\n ]*["']sidebar main["'][\s\S]{0,160}?grid-template-columns:\s*var\(--chat-sidebar-width\)\s+minmax\(0,\s*1fr\)/u,
  );
  for (const [selector, area] of [
    ["chat-sidebar", "sidebar"],
    ["site-header", "header"],
    ["chat-layout", "main"],
  ]) {
    assert.match(
      shellStyle,
      new RegExp(`\\.chat-app \\.${selector}\\s*\\{[\\s\\S]{0,180}?grid-area:\\s*${area}`, "u"),
      selector,
    );
  }
  assert.match(shellStyle, /\.chat-app \.chat-sidebar\s*\{[\s\S]{0,220}?border-right:\s*1px solid var\(--chat-line\)[\s\S]{0,100}?background:\s*#f9f9f9/u);
  assert.match(shellStyle, /\.chat-app \.message-list\s*\{[\s\S]{0,120}?max-width:\s*var\(--chat-content-width\)/u);
  assert.match(shellStyle, /\.chat-app \.composer\s*\{[\s\S]{0,320}?min-height:\s*68px[\s\S]{0,220}?border-radius:\s*24px/u);
  assert.match(
    shellStyle,
    /@media \(max-width:\s*899px\)[\s\S]{0,320}?grid-template-areas:\s*[\r\n ]*["']header["'][\r\n ]*["']main["'][\s\S]{0,180}?grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
  );
  assert.match(
    shellStyle,
    /@media \(max-width:\s*899px\)[\s\S]{0,800}?\.chat-app \.site-header \.menu-button\s*\{[\s\S]{0,80}?display:\s*grid/u,
  );
});

test("frontend source avoids executable HTML and dynamic-code sinks", async () => {
  const [script, style] = await Promise.all([
    readFile(path.join(frontendDir, "app.js"), "utf8"),
    readFile(path.join(frontendDir, "styles.css"), "utf8"),
  ]);
  for (const forbidden of [
    /\.innerHTML\b/u,
    /\binsertAdjacentHTML\s*\(/u,
    /\bdocument\.write\s*\(/u,
    /\bdangerouslySetInnerHTML\b/u,
    /\beval\s*\(/u,
    /\bnew\s+Function\s*\(/u,
  ]) {
    assert.doesNotMatch(script, forbidden);
  }
  assert.doesNotMatch(script, /(?:import\s*(?:\(|[^;]*?\bfrom\s*)|export\s+[^;]*?\bfrom\s*)["']https?:/u);
  assert.doesNotMatch(style, /@import\b|url\(\s*["']?https?:/iu);
});
