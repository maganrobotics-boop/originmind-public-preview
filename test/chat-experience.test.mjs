import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const messageActions = await readFile(new URL("../frontend/message-actions.js", import.meta.url), "utf8");
const source = messageActions + "\n" + await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
class TestNode {
  constructor(tag = "#text", text = "") { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes.map((node) => node instanceof TestNode ? node : new TestNode("#text", String(node)))); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
}
const document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => new TestNode("#text", text) };
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const api = runInNewContext(`
  ${section("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}
  ${section("function element(", "function icon(")}
  ${section("function referenceSectionStart", "function serviceLabel")}
  ({ CHAT_HISTORY_KEY, CHAT_CONVERSATIONS_KEY, CHAT_HISTORY_TTL_MS, CHAT_TOKEN_TTL_MS,
     CHAT_RECENT_LIMIT, readChatHistory, writeChatHistory, chatHistorySnapshot,
     chatConversationTitle, chatConversationsSnapshot, writeChatConversations,
     readChatConversations, recentChatConversations, renderAnswerBody, userFacingAnswer });
`, { document, Node: TestNode });
const installHelperApi = runInNewContext(`
  ${section("function isStandaloneWebApp", "const TOPIC_LABELS")}
  ({ isStandaloneWebApp, isAppleMobileDevice, registerPublicServiceWorker });
`, Object.create(null));
function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const now = 1_789_369_200_000;
function session(extra = {}) {
  return { messages: [{ role: "user", content: "机器人有哪些能力？" }, { role: "assistant", content: "支持**自主巡检**。" }],
    draft: "进一步说明", conversationToken: "opaque-server-token", tokenSavedAt: now,
    sending: false, scrollTop: 123, stickToEnd: false, ...extra };
}
function conversation(id, section = "technology", extra = {}) {
  return {
    id, section, title: "新聊天", createdAt: now - 1000, updatedAt: now,
    ...session(), ...extra,
  };
}
const allowedSections = ["general", "technology", "academic", "company", "association"];
function nodes(root, tag) { return [...(root.tag === tag ? [root] : []), ...root.children.flatMap((child) => nodes(child, tag))]; }

test("v2 storage restores multiple conversations in the same topic without leaking unrelated state", () => {
  const store = storage();
  const first = conversation("techconv01", "technology", {
    messages: [{ role: "user", content: "第一个技术问题" }, { role: "assistant", content: "第一条回答" }],
    draft: "继续第一个问题", contact: "do not save", apiKey: "do not save", error: "transient",
  });
  const second = conversation("techconv02", "technology", {
    messages: [{ role: "user", content: "第二个技术问题" }, { role: "assistant", content: "第二条回答" }],
    draft: "", updatedAt: now - 100,
  });
  const company = conversation("company001", "company", { draft: "产品问题", updatedAt: now - 200 });
  assert.equal(api.writeChatConversations(store, [first, second, company], second.id, now), true);

  const restored = api.readChatConversations(store, allowedSections, now + 1000);
  assert.equal(restored.conversations.length, 3);
  assert.equal(restored.conversations.filter((item) => item.section === "technology").length, 2);
  assert.equal(restored.activeConversationId, second.id);
  assert.equal(restored.conversations.find((item) => item.id === first.id).draft, "继续第一个问题");
  assert.equal(restored.conversations.find((item) => item.id === first.id).conversationToken, "opaque-server-token");
  assert.equal(restored.conversations.find((item) => item.id === first.id).scrollTop, 123);
  assert.equal(restored.conversations.find((item) => item.id === first.id).stickToEnd, false);
  assert.equal(restored.conversations.find((item) => item.id === company.id).draft, "产品问题");
  assert.doesNotMatch(store.getItem(api.CHAT_CONVERSATIONS_KEY), /contact|apiKey|transient/u);
});

test("v2 interrupted requests restore as an unsent draft without a duplicate user turn", () => {
  const store = storage();
  const pending = conversation("pending001", "technology", { draft: "", sending: true });
  pending.messages.push({ role: "user", content: "这个方案的局限是什么？" });
  api.writeChatConversations(store, [pending], pending.id, now);
  const restored = api.readChatConversations(store, allowedSections, now + 1000).conversations[0];
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.draft, "这个方案的局限是什么？");
  assert.equal(restored.sending, false);
  assert.match(restored.notice, /未完成/u);
});

test("v2 recent conversations use first-question titles and newest-first order", () => {
  const store = storage();
  const longQuestion = `  ${"新".repeat(31)}\n后续空白  `;
  const records = [
    conversation("recent001", "technology", {
      messages: [{ role: "user", content: "较早的话题" }, { role: "assistant", content: "回答" }],
      draft: "", updatedAt: now - 300,
    }),
    conversation("recent002", "technology", {
      messages: [{ role: "user", content: longQuestion }, { role: "assistant", content: "回答" }],
      draft: "", updatedAt: now - 100,
    }),
    conversation("draftonly", "company", { messages: [], draft: "只有草稿", updatedAt: now }),
  ];
  api.writeChatConversations(store, records, records[0].id, now);
  const restored = api.readChatConversations(store, allowedSections, now);
  assert.deepEqual(Array.from(restored.conversations, (item) => item.id), ["draftonly", "recent002", "recent001"]);
  const recent = api.recentChatConversations(restored.conversations);
  assert.deepEqual(Array.from(recent, (item) => item.id), ["recent002", "recent001"]);
  assert.equal(recent[0].title, `${"新".repeat(30)}…`);
  assert.equal(recent[1].title, "较早的话题");
  assert.equal(api.chatConversationTitle([], "备用标题"), "备用标题");
});

test("v2 discards signed context after 12 hours and conversations after 7 days", () => {
  const store = storage();
  const record = conversation("expires001");
  api.writeChatConversations(store, [record], record.id, now);
  const restored = api.readChatConversations(store, allowedSections, now + api.CHAT_TOKEN_TTL_MS).conversations[0];
  assert.equal(restored.conversationToken, "");
  assert.equal(restored.messages.length, 2);
  assert.equal(api.readChatConversations(store, allowedSections, now + api.CHAT_HISTORY_TTL_MS), null);
  assert.equal(store.values.size, 0);
});

test("v2 storage fails soft for corrupt, oversized and partially invalid records", () => {
  for (const value of ["{broken", "x".repeat(2_000_001), JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 2, conversations: "invalid" })]) {
    const store = storage();
    store.setItem(api.CHAT_CONVERSATIONS_KEY, value);
    assert.equal(api.readChatConversations(store, allowedSections, now), null);
    assert.equal(store.values.size, 0);
  }

  const store = storage();
  const snapshot = api.chatConversationsSnapshot([
    conversation("validrec01"),
    conversation("short", "technology"),
    conversation("wrongsec01", "private"),
  ], "short", now);
  store.setItem(api.CHAT_CONVERSATIONS_KEY, JSON.stringify(snapshot));
  const restored = api.readChatConversations(store, allowedSections, now);
  assert.deepEqual(Array.from(restored.conversations, (item) => item.id), ["validrec01"]);
  assert.equal(restored.activeConversationId, "validrec01");

  const blocked = { getItem() { throw Error("disabled"); }, setItem() { throw Error("quota"); }, removeItem() { throw Error("disabled"); } };
  assert.equal(api.readChatConversations(blocked, allowedSections, now), null);
  assert.equal(api.writeChatConversations(blocked, [conversation("blocked001")], "blocked001", now), false);
});

test("v2 large histories retain bounded messages and remove visible reference sections on reload", () => {
  const store = storage();
  const messages = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "字".repeat(2000) }));
  const record = conversation("bounded001", "technology", { messages, draft: "" });
  api.writeChatConversations(store, [record], record.id, now);
  const restored = api.readChatConversations(store, allowedSections, now).conversations[0];
  assert.ok(restored.messages.length <= 40);
  assert.ok(restored.messages.reduce((sum, message) => sum + message.content.length, 0) <= 80_000);
  assert.equal(restored.messages[0].role, "user");
  messages.splice(0, messages.length, { role: "user", content: "请介绍" }, { role: "assistant", content: "公开技术成果。[1]\n\n参考文献：\n[1] 来源标题" });
  record.messages = messages;
  api.writeChatConversations(store, [record], record.id, now);
  assert.equal(api.readChatConversations(store, allowedSections, now).conversations[0].messages[1].content, "公开技术成果。");
});

test("v2 writer trims oldest conversations before reaching its own read limit", () => {
  const store = storage();
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: (index % 2 ? "答" : "问").repeat(index % 2 ? 12_000 : 2_000),
  }));
  const records = Array.from({ length: 20 }, (_, index) => conversation(
    `large${String(index).padStart(3, "0")}`,
    "technology",
    {
      messages,
      draft: "",
      conversationToken: "t".repeat(40_000),
      updatedAt: now - index,
    },
  ));
  assert.equal(api.writeChatConversations(store, records, records[0].id, now), true);
  const serialized = store.getItem(api.CHAT_CONVERSATIONS_KEY);
  assert.ok(serialized.length <= 2_000_000);
  const restored = api.readChatConversations(store, allowedSections, now);
  assert.ok(restored);
  assert.equal(restored.activeConversationId, records[0].id);
  assert.ok(restored.conversations.length < records.length);
});

test("answers render paragraphs, emphasis, lists and accessible tables using semantic nodes", () => {
  const answer = "**建议先试点。**\n\n1. 明确场景\n2. 验证结果\n\n| 方案 | 优点 |\n| --- | --- |\n| 轮式 | 易维护 |\n| 四足 | 越障 |\n\n补充说明。";
  const body = api.renderAnswerBody(answer);
  assert.equal(nodes(body, "strong")[0].textContent, "建议先试点。");
  assert.equal(nodes(body, "ol").length, 1);
  assert.equal(nodes(body, "li").length, 2);
  assert.equal(nodes(body, "th").length, 2);
  assert.equal(nodes(body, "td").length, 4);
  assert.equal(nodes(body, "th")[0].attributes.scope, "col");
  assert.equal(nodes(body, "table").length, 1);
  const wrap = nodes(body, "div").find((node) => node.className === "answer-table-scroll");
  assert.equal(wrap.attributes.tabindex, "0");
  assert.equal(nodes(body, "p").at(-1).textContent, "补充说明。");
});

test("markup cannot create executable HTML, image loads or links", () => {
  const answer = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n![photo](https://example.test/tracker)\n\n**<svg onload=alert(1)>**';
  const body = api.renderAnswerBody(answer);
  for (const tag of ["script", "img", "svg", "iframe", "a"]) assert.equal(nodes(body, tag).length, 0, tag);
  assert.match(body.textContent, /<script>alert\(1\)<\/script>/u);
  assert.match(nodes(body, "strong")[0].textContent, /<svg/u);
});

test("code, escaped pipes and malformed tables retain their text", () => {
  const body = api.renderAnswerBody('```cpp\nif (a < b) {}\n```\n\n| 参数 | 值 |\n| --- | --- |\n| `a|b` | x\\|y |\n\n| 不完整 | 表格 |\n| 单列 |');
  assert.equal(nodes(body, "pre")[0].textContent, "if (a < b) {}");
  assert.equal(nodes(body, "td")[0].textContent, "a|b");
  assert.equal(nodes(body, "td")[1].textContent, "x|y");
  assert.match(body.textContent, /不完整/u);
  assert.match(body.textContent, /单列/u);
});

test("install helpers detect standalone and Apple mobile environments", () => {
  const { isStandaloneWebApp, isAppleMobileDevice } = installHelperApi;
  let mediaQuery = "";
  assert.equal(isStandaloneWebApp({
    matchMedia(query) { mediaQuery = query; return { matches: true }; },
  }, {}), true);
  assert.equal(mediaQuery, "(display-mode: standalone)");
  assert.equal(isStandaloneWebApp({ matchMedia: () => ({ matches: false }) }, { standalone: true }), true);
  assert.equal(isStandaloneWebApp({ matchMedia: () => ({ matches: false }) }, {}), false);

  assert.equal(isAppleMobileDevice({ userAgent: "Mozilla/5.0 (iPhone)", platform: "iPhone" }), true);
  assert.equal(isAppleMobileDevice({ userAgent: "Mozilla/5.0", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobileDevice({ userAgent: "Mozilla/5.0 (Linux; Android 16)", platform: "Linux armv8l", maxTouchPoints: 5 }), false);
});

test("service worker helper registers once at the right lifecycle point and fails soft", async () => {
  const { registerPublicServiceWorker } = installHelperApi;
  const immediateCalls = [];
  registerPublicServiceWorker({}, {
    serviceWorker: {
      register(url, options) { immediateCalls.push({ url, options }); return Promise.resolve(); },
    },
  }, { readyState: "complete" });
  assert.equal(immediateCalls.length, 1);
  assert.equal(immediateCalls[0].url, "/service-worker.js");
  assert.equal(immediateCalls[0].options.scope, "/");
  assert.equal(immediateCalls[0].options.updateViaCache, "none");

  const delayedCalls = [];
  let loadListener = null;
  let loadOptions = null;
  registerPublicServiceWorker({
    addEventListener(name, callback, options) {
      assert.equal(name, "load");
      loadListener = callback;
      loadOptions = options;
    },
  }, {
    serviceWorker: {
      register(url, options) { delayedCalls.push({ url, options }); return Promise.resolve(); },
    },
  }, { readyState: "interactive" });
  assert.equal(delayedCalls.length, 0);
  assert.equal(loadOptions.once, true);
  loadListener();
  assert.equal(delayedCalls.length, 1);

  assert.doesNotThrow(() => registerPublicServiceWorker({
    addEventListener() { throw new Error("must not listen without service worker support"); },
  }, {}, { readyState: "loading" }));
  registerPublicServiceWorker({}, {
    serviceWorker: { register: () => Promise.reject(new Error("registration blocked")) },
  }, { readyState: "complete" });
  await new Promise((resolve) => setImmediate(resolve));
});

function publicAppHarness(store, {
  failChat = false,
  pathname = "/technology",
  suggestions = [],
  navigatorOptions = {},
  standalone = false,
} = {}) {
  const all = [];
  class AppNode extends TestNode {
    constructor(tag) {
      super(tag); all.push(this); this.listeners = {}; this.value = "";
      this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 300;
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    fire(name, event = {}) {
      for (const callback of this.listeners[name] || []) callback({
        target: this, currentTarget: this, button: 0, preventDefault() {}, ...event,
      });
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelectorAll() { const result = []; result.item = () => null; return result; }
    contains(target) { return this === target || this.children.some((node) => node.contains?.(target)); }
    focus() {}
    blur() {}
    scrollIntoView() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
  }
  const root = new AppNode("div"); root.id = "app";
  const doc = new AppNode("document");
  doc.documentElement = new AppNode("html"); doc.body = new AppNode("body");
  doc.createElement = (tag) => new AppNode(tag);
  doc.createElementNS = (_namespace, tag) => new AppNode(tag);
  doc.createTextNode = (text) => new TestNode("#text", text);
  doc.getElementById = (id) => all.find((node) => node.id === id);
  const win = new AppNode("window");
  const timers = new Map(); let nextTimer = 0;
  Object.assign(win, {
    localStorage: store, location: {
      pathname,
      origin: "https://chat.omindos.ai",
      href: `https://chat.omindos.ai${pathname}`,
    },
    innerHeight: 800, confirm: () => true,
    matchMedia: (query) => ({
      matches: query === "(display-mode: standalone)" && standalone,
    }),
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { callback(); return 0; }, cancelAnimationFrame() {},
    history: {
      state: null,
      pushState(state, _unused, nextPathname) {
        this.state = state;
        win.location.pathname = new URL(nextPathname, win.location.origin).pathname;
      },
      replaceState(state, _unused, nextPathname) {
        this.state = state;
        win.location.pathname = new URL(nextPathname, win.location.origin).pathname;
      },
    },
  });
  const navigatorObject = {
    onLine: true,
    userAgent: "Mozilla/5.0",
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    ...navigatorOptions,
  };
  const suggestionPayload = {
    suggestions: suggestions.map((item, index) => (
      typeof item === "string"
        ? { question: item, suggestionToken: `suggestion-${index + 1}` }
        : item
    )),
    knowledgeReady: true,
  };
  const readyStatus = {
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
    documentParsingReady: true,
  };
  const requests = [];
  runInNewContext(source, {
    Node: TestNode, HTMLElement: AppNode, document: doc, window: win,
    TextDecoder, TextEncoder, URL, URLSearchParams, AbortController, AbortSignal, crypto,
    navigator: navigatorObject,
    fetch: async (url, options) => {
      requests.push({ url, body: options?.body });
      if (url === "/_health") return Response.json({ ready: true });
      if (url === "/api/status") return Response.json(readyStatus);
      if (url === "/api/suggestions") return Response.json(suggestionPayload);
      if (url === "/api/chat") {
        if (failChat) throw new Error("offline");
        return Response.json({ answer: "**可以试点。**\n\n- 明确目标\n- 验证结果", conversationToken: "new-server-token", oaPublicStatus: "connected" });
      }
      return Response.json({});
    },
  });
  return { all, root, win, doc, navigator: navigatorObject, requests, input: () => doc.getElementById("question") };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("empty chats use the laboratory assistant brand, scoped guidance and data prompt", async () => {
  for (const [pathname, expectedSubtitle] of [
    ["/", "从已审核的实验室公开知识中检索并回答"],
    ["/technology", "从“成果与应用”公开知识中检索并回答"],
  ]) {
    const app = publicAppHarness(storage(), { pathname });
    await settle();
    const hero = nodes(app.root, "section").find((node) => node.className === "empty-hero");
    assert.ok(hero, pathname);
    assert.equal(hero.getAttribute("aria-labelledby"), "empty-chat-title");
    assert.equal(nodes(hero, "h2")[0].textContent, "需要实验室大模型做什么？");
    assert.equal(nodes(hero, "p")[0].textContent, expectedSubtitle);
    assert.deepEqual(
      nodes(hero, "button")
        .filter((node) => node.className === "empty-capability-card")
        .map((node) => node.textContent),
      [
        "知识问答检索实验室资料并回答",
        "项目总结整理进展、问题与下一步",
        "资料处理导入 TXT/MD/PDF 后处理",
        "会议纪要生成纪要与行动项",
      ],
    );
    assert.equal(app.input().getAttribute("placeholder"), "询问实验室大数据");
    assert.equal(app.all.find((node) => node.id === "new-chat-question").getAttribute("placeholder"), "询问实验室大数据");

    const brandTitles = nodes(app.root, "strong")
      .filter((node) => node.className === "sidebar-brand-title")
      .map((node) => node.textContent);
    const brandSubtitles = nodes(app.root, "span")
      .filter((node) => node.className === "sidebar-brand-subtitle")
      .map((node) => node.textContent);
    assert.deepEqual(brandTitles, ["联合研发 OA", "联合研发 OA"]);
    assert.deepEqual(brandSubtitles, ["ORIGINMIND × ARTS ROBOTICS", "ORIGINMIND × ARTS ROBOTICS"]);
  }
});

test("live recommendations render as a five-item sparkle list in the page and new-chat dialog", async () => {
  const questions = [
    "实验室目前有哪些机器人？",
    "双臂机器人适合哪些任务？",
    "如何开展科研合作？",
    "OmindOS 可以做什么？",
    "学生可以参加哪些活动？",
    "第六条不应展示",
  ];
  const app = publicAppHarness(storage(), { pathname: "/", suggestions: questions });
  await settle();
  await settle();

  const panel = nodes(app.root, "section").find((node) => node.className === "composer-suggestions");
  assert.equal(panel.hidden, false);
  assert.equal(nodes(panel, "p")[0].textContent, "今日推荐 · 基于公开知识，每日更新");
  const suggestionList = nodes(panel, "div").find((node) => node.className === "suggestions");
  assert.equal(suggestionList.getAttribute("role"), "group");
  assert.equal(suggestionList.getAttribute("aria-label"), "根据近期入库知识生成的推荐话题");
  const mainButtons = nodes(suggestionList, "button");
  assert.equal(mainButtons.length, 5);
  assert.deepEqual(mainButtons.map((button) => button.textContent), questions.slice(0, 5).map((question) => `✦${question}`));
  for (const button of mainButtons) {
    assert.equal(button.children[0].className, "suggestion-sparkle");
    assert.equal(button.children[0].textContent, "✦");
    assert.equal(button.children[0].getAttribute("aria-hidden"), "true");
    assert.equal(button.children[1].tag, "span");
  }

  nodes(app.root, "button").find((node) => node.className === "sidebar-chat-button").fire("click");
  const dialog = nodes(app.root, "dialog").find((node) => node.id === "new-chat-dialog");
  assert.equal(dialog.open, true);
  const dialogPanel = nodes(dialog, "section").find((node) => node.className === "new-chat-suggestions");
  assert.equal(dialogPanel.hidden, false);
  assert.equal(nodes(dialogPanel, "p")[0].textContent, "今日推荐 · 基于公开知识，每日更新");
  const dialogButtons = nodes(dialogPanel, "button")
    .filter((node) => node.className === "new-chat-suggestion");
  assert.equal(dialogButtons.length, 5);
  assert.equal(dialogButtons.every((button) => button.children[0].className === "suggestion-sparkle"), true);
});

test("install controls provide platform guidance and complete the browser install lifecycle", async () => {
  for (const [navigatorOptions, expectedTitle, expectedDescription, expectedSteps] of [
    [
      { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 },
      "添加到主屏幕",
      /Safari 的系统菜单/u,
      ["点击 Safari 的分享按钮", "选择“添加到主屏幕”", "确认“作为网页 App 打开”，再点击“添加”"],
    ],
    [
      { userAgent: "Mozilla/5.0 (Linux; Android 16)", platform: "Linux armv8l", maxTouchPoints: 5 },
      "安装联合研发 OA",
      /浏览器菜单添加到桌面/u,
      ["打开浏览器菜单", "选择“安装应用”或“添加到桌面”", "按系统提示确认"],
    ],
  ]) {
    const app = publicAppHarness(storage(), { navigatorOptions });
    const installButton = nodes(app.root, "button").find((node) => node.className === "sidebar-install-button");
    assert.equal(installButton.textContent, "⇩安装应用");
    assert.equal(installButton.getAttribute("aria-label"), "安装联合研发 OA");
    assert.equal(installButton.getAttribute("aria-haspopup"), "dialog");
    installButton.fire("click");

    const dialog = nodes(app.root, "dialog").find((node) => node.id === "install-dialog");
    assert.equal(dialog.open, true);
    assert.equal(nodes(dialog, "h2")[0].textContent, expectedTitle);
    assert.match(nodes(dialog, "p")[0].textContent, expectedDescription);
    assert.deepEqual(nodes(dialog, "li").map((node) => node.textContent), expectedSteps);
  }

  const app = publicAppHarness(storage());
  const installButtons = nodes(app.root, "button").filter((node) => node.className === "sidebar-install-button");
  let prevented = 0;
  let prompted = 0;
  app.win.fire("beforeinstallprompt", {
    preventDefault() { prevented += 1; },
    prompt: async () => { prompted += 1; },
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  installButtons[0].fire("click");
  await settle();
  await settle();
  assert.equal(prevented, 1);
  assert.equal(prompted, 1);
  assert.match(app.root.textContent, /正在安装联合研发 OA/u);

  const installDialog = nodes(app.root, "dialog").find((node) => node.id === "install-dialog");
  installDialog.showModal();
  app.win.fire("appinstalled");
  assert.equal(installDialog.open, false);
  assert.equal(installButtons.every((button) => button.disabled === true), true);
  assert.equal(installButtons.every((button) => button.textContent === "⇩已安装"), true);
  assert.equal(installButtons.every((button) => button.getAttribute("aria-haspopup") === "false"), true);
  assert.match(app.root.textContent, /联合研发 OA 已安装到桌面/u);

  const standaloneApp = publicAppHarness(storage(), { standalone: true });
  const standaloneButtons = nodes(standaloneApp.root, "button")
    .filter((node) => node.className === "sidebar-install-button");
  assert.equal(standaloneButtons.every((button) => button.disabled === true), true);
  assert.equal(standaloneButtons.every((button) => button.getAttribute("aria-label") === "联合研发 OA 已安装"), true);
});

test("the complete UI migrates v1 through startup, saves drafts and clears the active v2 conversation", async () => {
  const store = storage();
  const uiNow = Date.now();
  api.writeChatHistory(store, "technology", session({ tokenSavedAt: uiNow }), uiNow);
  const app = publicAppHarness(store);
  await settle();
  assert.equal(app.input().value, "进一步说明");
  assert.match(app.root.textContent, /自主巡检/u);
  assert.equal(app.requests.filter((request) => request.url === "/api/chat").length, 0);
  assert.equal(store.getItem(api.CHAT_HISTORY_KEY + "technology"), null);
  assert.equal(api.readChatConversations(store, allowedSections).conversations.length, 1);

  app.input().value = "刷新前未提交的草稿";
  app.input().fire("input");
  app.win.fire("pagehide");
  const refreshed = publicAppHarness(store);
  await settle();
  assert.equal(refreshed.input().value, "刷新前未提交的草稿");
  refreshed.all.find((node) => node.className === "chat-info-row chat-info-clear").fire("click");
  assert.equal(api.readChatConversations(store, allowedSections), null);
  assert.doesNotMatch(refreshed.root.textContent, /自主巡检/u);
});

test("clearing a general chat replaces browser history with the new conversation", async () => {
  const store = storage();
  const current = conversation("general001", "general", {
    messages: [{ role: "user", content: "实验室有哪些机器人？" }, { role: "assistant", content: "这里是回答。" }],
    draft: "",
    updatedAt: Date.now(),
  });
  api.writeChatConversations(store, [current], current.id, Date.now());
  const app = publicAppHarness(store, { pathname: "/" });
  await settle();
  assert.equal(app.win.history.state.conversationId, current.id);

  app.all.find((node) => node.className === "chat-info-row chat-info-clear").fire("click");
  assert.equal(app.win.location.pathname, "/");
  assert.equal(app.win.history.state.topic, "general");
  assert.notEqual(app.win.history.state.conversationId, current.id);
  assert.match(app.root.textContent, /已删除当前聊天/u);
  assert.doesNotMatch(app.root.textContent, /已删除聊天当前聊天/u);
});

test("the complete UI persists completed answers and retains failed questions as drafts", async () => {
  for (const failChat of [false, true]) {
    const store = storage(); const app = publicAppHarness(store, { failChat });
    await settle();
    app.input().value = "请介绍技术方案"; app.input().fire("input");
    app.all.find((node) => node.tag === "form" && node.className === "composer").fire("submit");
    await settle(); await settle();
    const collection = api.readChatConversations(store, allowedSections);
    const restored = collection.conversations.find((item) => item.id === collection.activeConversationId);
    assert.equal(restored.sending, false);
    if (failChat) {
      assert.equal(restored.messages.length, 0);
      assert.equal(restored.draft, "请介绍技术方案");
    } else {
      assert.equal(restored.messages.length, 2);
      assert.equal(restored.conversationToken, "new-server-token");
      assert.equal(restored.title, "请介绍技术方案");
      assert.equal(nodes(app.root, "strong").some((node) => node.textContent === "可以试点。"), true);
    }
  }
});

test("the complete UI switches recent conversations and starts a general chat from the sidebar", async () => {
  const store = storage();
  const uiNow = Date.now();
  const older = conversation("uiside001", "technology", {
    messages: [{ role: "user", content: "较早的会话" }, { role: "assistant", content: "较早回答内容" }],
    draft: "较早草稿", updatedAt: uiNow - 2000, tokenSavedAt: uiNow - 2000,
  });
  const newer = conversation("uiside002", "technology", {
    messages: [{ role: "user", content: "较新的会话" }, { role: "assistant", content: "较新回答内容" }],
    draft: "较新草稿", updatedAt: uiNow - 1000, tokenSavedAt: uiNow - 1000,
  });
  api.writeChatConversations(store, [older, newer], older.id, uiNow);

  const app = publicAppHarness(store);
  await settle();
  assert.equal(app.input().value, "较早草稿");
  assert.match(app.root.textContent, /较早回答内容/u);
  const recentTitles = app.all
    .filter((node) => node.className === "sidebar-recent-title")
    .slice(0, 2)
    .map((node) => node.textContent);
  assert.deepEqual(recentTitles, ["较新的会话", "较早的会话"]);

  app.all.find((node) => node.className === "sidebar-recent-item" && node.textContent === "较新的会话").fire("click");
  assert.equal(app.input().value, "较新草稿");
  assert.match(app.root.textContent, /较新回答内容/u);
  assert.doesNotMatch(app.root.textContent, /较早回答内容/u);

  const launch = app.all.find((node) => node.className === "sidebar-chat-button");
  launch.fire("click");
  const dialog = app.all.find((node) => node.id === "new-chat-dialog");
  const newChatInput = app.all.find((node) => node.id === "new-chat-question");
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /当前知识范围：全部公开知识/u);
  newChatInput.value = "第三个技术问题";
  newChatInput.fire("input");
  app.all.find((node) => node.className === "new-chat-form").fire("submit");
  await settle(); await settle();

  const restored = api.readChatConversations(store, allowedSections);
  assert.equal(restored.conversations.filter((item) => item.section === "technology").length, 2);
  assert.equal(restored.conversations.filter((item) => item.section === "general").length, 1);
  const active = restored.conversations.find((item) => item.id === restored.activeConversationId);
  assert.equal(active.title, "第三个技术问题");
  assert.equal(active.messages.length, 2);
  assert.equal(active.messages[1].content, "**可以试点。**\n\n- 明确目标\n- 验证结果");
  const chatRequest = app.requests.filter((request) => request.url === "/api/chat").at(-1);
  assert.equal(JSON.parse(chatRequest.body).topic, "research");
  assert.equal(dialog.open, false);
  const renderedRecentTitles = nodes(app.root, "span")
    .filter((node) => node.className === "sidebar-recent-title")
    .slice(0, 3)
    .map((node) => node.textContent);
  assert.deepEqual(renderedRecentTitles, ["第三个技术问题", "较新的会话", "较早的会话"]);
});

test("switching away from a pristine conversation never overwrites another saved draft", async () => {
  const store = storage();
  const uiNow = Date.now();
  const saved = conversation("protected1", "technology", {
    messages: [{ role: "user", content: "已保存的问题" }, { role: "assistant", content: "已保存的回答" }],
    draft: "不要覆盖这段草稿",
    updatedAt: uiNow,
    tokenSavedAt: uiNow,
  });
  api.writeChatConversations(store, [saved], saved.id, uiNow);
  const app = publicAppHarness(store);
  await settle();

  const openTopic = (title) => app.all.find((node) => (
    node.className === "sidebar-topic-link" && node.textContent.includes(title)
  )).fire("click");
  openTopic("科研与合作");
  openTopic("成果与应用");
  openTopic("公司与产品");
  app.win.fire("pagehide");

  const restored = api.readChatConversations(store, allowedSections);
  assert.equal(restored.conversations.find((item) => item.id === saved.id).draft, "不要覆盖这段草稿");
});
