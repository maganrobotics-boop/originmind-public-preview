import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS_SECTIONS,
  analyticsReport,
  beijingDayKey,
  recordAnalyticsEvents,
} from "../src/analytics.mjs";
import { handleRequest } from "../src/app.mjs";
import { sha256Hex } from "../src/crypto.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const SERVICE_TOKEN = "A".repeat(43);
const QUESTION = "实验室目前有哪些机器人设备？";
const SECOND_QUESTION = "实验室主要研究哪些机器人方向？";

function environment(overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(),
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "analytics-encryption-key".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "analytics-rate-limit-key".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID: `${"a".repeat(40)}-1`,
    ...overrides,
  };
}

function request(path, {
  method = "GET",
  body,
  cookie,
  origin = ORIGIN,
  ip = "203.0.113.90",
  userAgent,
} = {}) {
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", origin);
  }
  if (cookie) headers.set("Cookie", cookie);
  if (userAgent) headers.set("User-Agent", userAgent);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function emptyOaRuntime() {
  return {
    fetch: async () => Response.json(
      { chunks: [] },
      { headers: { "Content-Type": "application/json" } },
    ),
  };
}

async function analyticsRows(database) {
  return (await database.prepare(`
    SELECT day,event,section,dimension,count
    FROM analytics_daily
    ORDER BY day,event,section,dimension
  `).all()).results;
}

async function ownerCookie(database) {
  const token = "9".repeat(64);
  await database.prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), Date.now() + 60_000)
    .run();
  return `__Host-ma-session=${token}`;
}

test("analytics migration creates only anonymous aggregate dimensions", async (t) => {
  const database = new D1DatabaseAdapter();
  t.after(() => database.close());
  const columns = (await database.prepare("PRAGMA table_info(analytics_daily)").all()).results;
  assert.deepEqual(columns.map((column) => column.name), ["day", "event", "section", "dimension", "count"]);
  assert.equal(columns.some((column) => /ip|visitor|cookie|question|conversation/iu.test(column.name)), false);

  await recordAnalyticsEvents(database, [
    { type: "page_view", section: "general" },
    { type: "page_view", section: "general" },
  ], new Date("2026-09-14T16:30:00.000Z"));
  const rows = await analyticsRows(database);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    day: "2026-09-15",
    event: "page_view",
    section: "general",
    dimension: "",
    count: 2,
  });
});

test("public analytics accepts only same-origin bounded product events", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const events = [
    { type: "page_view", section: "general" },
    { type: "suggestion_impression", section: "technology", suggestion: QUESTION },
    { type: "suggestion_click", section: "technology", suggestion: QUESTION },
    { type: "new_chat", section: "general" },
    { type: "install_success", section: "general" },
  ];
  const accepted = await handleRequest(
    request("/api/analytics", { method: "POST", body: { events } }),
    env,
    {},
    emptyOaRuntime(),
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true });
  assert.equal((await analyticsRows(env.DB)).length, 5);

  const hostile = await handleRequest(request("/api/analytics", {
    method: "POST",
    origin: "https://attacker.example",
    body: { events: [{ type: "page_view", section: "general" }] },
  }), env, {}, emptyOaRuntime());
  assert.equal(hostile.status, 403);

  for (const body of [
    { events: [] },
    { events: Array.from({ length: 6 }, () => ({ type: "new_chat", section: "general" })) },
    { events: [{ type: "page_view", section: "general", secret: "must not pass" }] },
    { events: [{ type: "suggestion_impression", section: "general", suggestion: "访客输入的任意问题" }] },
    { events: [{ type: "chat_submit", section: "general" }] },
    { events: [{ type: "page_view", section: "research" }] },
  ]) {
    const response = await handleRequest(
      request("/api/analytics", { method: "POST", body, ip: `203.0.113.${100 + Math.random() * 20}` }),
      env,
      {},
      emptyOaRuntime(),
    );
    assert.equal(response.status, 400);
  }
  assert.equal((await analyticsRows(env.DB)).length, 5);
});

test("analytics report is Beijing-day bounded and returns stable rates and zero-filled series", async (t) => {
  const database = new D1DatabaseAdapter();
  t.after(() => database.close());
  const now = new Date("2026-09-14T10:00:00.000Z");
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  await recordAnalyticsEvents(database, [
    { type: "page_view", section: "general" },
    { type: "chat_submit", section: "general", source: "typed" },
    { type: "chat_success", section: "general", source: "typed" },
    { type: "suggestion_impression", section: "general", suggestion: QUESTION },
    { type: "suggestion_click", section: "general", suggestion: QUESTION },
  ], now);
  await recordAnalyticsEvents(database, [
    { type: "page_view", section: "academic" },
    { type: "chat_submit", section: "academic", source: "suggestion" },
    { type: "suggestion_impression", section: "academic", suggestion: SECOND_QUESTION },
    { type: "new_chat", section: "general" },
    { type: "install_success", section: "general" },
  ], now);
  await recordAnalyticsEvents(database, [
    { type: "page_view", section: "technology" },
  ], yesterday);

  const report = await analyticsReport(database, 1, now);
  assert.deepEqual(report.period, { days: 1, from: "2026-09-14", to: "2026-09-14" });
  assert.deepEqual(report.totals, {
    pageViews: 2,
    chatSubmits: 2,
    chatSuccesses: 1,
    suggestionImpressions: 2,
    suggestionClicks: 1,
    newChats: 1,
    installs: 1,
  });
  assert.deepEqual(report.rates, { suggestionCtr: 50, chatSuccessRate: 50 });
  assert.deepEqual(report.series, [{ day: "2026-09-14", ...report.totals }]);
  assert.deepEqual(report.sections.map((item) => item.section), ANALYTICS_SECTIONS);
  assert.deepEqual(report.sections.find((item) => item.section === "general"), {
    section: "general",
    pageViews: 1,
    chatSubmits: 1,
    suggestionImpressions: 1,
    suggestionClicks: 1,
  });
  assert.deepEqual(report.topSuggestions[0], {
    suggestion: QUESTION,
    impressions: 1,
    clicks: 1,
    ctr: 100,
  });
  assert.equal((await analyticsReport(database, 7, now)).series.length, 7);
});

test("admin analytics requires the owner session and rejects unknown ranges", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  await recordAnalyticsEvents(env.DB, [{ type: "page_view", section: "general" }]);
  const anonymous = await handleRequest(request("/api/admin/analytics?days=1"), env, {}, emptyOaRuntime());
  assert.equal(anonymous.status, 403);

  const cookie = await ownerCookie(env.DB);
  const response = await handleRequest(
    request("/api/admin/analytics?days=1", { cookie }),
    env,
    {},
    emptyOaRuntime(),
  );
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.period.days, 1);
  assert.equal(report.period.to, beijingDayKey());
  assert.equal(report.totals.pageViews, 1);

  for (const path of ["/api/admin/analytics?days=2", "/api/admin/analytics?days=7&extra=1", "/api/admin/analytics?days=1&days=7"]) {
    const invalid = await handleRequest(request(path, { cookie }), env, {}, emptyOaRuntime());
    assert.equal(invalid.status, 400);
  }
});

test("chat records submit and successful response without storing typed question text", async (t) => {
  const secretQuestion = "这段手工输入的问题正文绝不能写入统计表";
  const env = environment();
  t.after(() => env.DB.close());
  const response = await handleRequest(request("/api/chat", {
    method: "POST",
    body: {
      topic: "research",
      analyticsSection: "academic",
      messages: [{ role: "user", content: secretQuestion }],
    },
  }), env, {}, emptyOaRuntime());
  assert.equal(response.status, 200);
  const rows = await analyticsRows(env.DB);
  assert.deepEqual(rows.map((row) => ({ event: row.event, section: row.section, dimension: row.dimension, count: row.count })), [
    { event: "chat_submit", section: "academic", dimension: "typed", count: 1 },
    { event: "chat_success", section: "academic", dimension: "typed", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(secretQuestion, "u"));

  const invalid = await handleRequest(request("/api/chat", {
    method: "POST",
    body: {
      topic: "research",
      analyticsSection: "invalid-section",
      messages: [{ role: "user", content: "另一个问题" }],
    },
    ip: "203.0.113.91",
  }), env, {}, emptyOaRuntime());
  assert.equal(invalid.status, 400);
  assert.equal((await analyticsRows(env.DB)).length, 2);
});

test("release smoke chat requests never pollute visitor analytics", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const response = await handleRequest(request("/api/chat", {
    method: "POST",
    userAgent: "OriginMind-Chat-Release-Smoke/1.0",
    body: {
      topic: "research",
      analyticsSection: "general",
      messages: [{ role: "user", content: "实验室研究什么？" }],
    },
  }), env, {}, emptyOaRuntime());
  assert.equal(response.status, 200);
  assert.deepEqual(await analyticsRows(env.DB), []);
});

test("analytics storage failure never turns a valid chat into an error", async (t) => {
  const underlying = new D1DatabaseAdapter();
  t.after(() => underlying.close());
  const failingDatabase = {
    prepare(sql) {
      if (/insert\s+into\s+analytics_daily/iu.test(sql)) {
        return {
          bind() {
            return { run: async () => { throw new Error("analytics unavailable"); } };
          },
        };
      }
      return underlying.prepare(sql);
    },
  };
  const env = environment({ DB: failingDatabase });
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const response = await handleRequest(request("/api/chat", {
    method: "POST",
    body: {
      topic: "research",
      analyticsSection: "general",
      messages: [{ role: "user", content: "实验室研究什么？" }],
    },
  }), env, {}, emptyOaRuntime());
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).answer, "string");
});
