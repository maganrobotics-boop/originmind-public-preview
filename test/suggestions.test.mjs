import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/app.mjs";
import { OA_PUBLIC_SUGGESTIONS_URL } from "../src/constants.mjs";
import { fallbackAnswer } from "../src/knowledge.mjs";
import {
  naturalizeSuggestions,
  naturalQuestions,
  parseChatSuggestions,
  suggestionRetrievalQuestion,
} from "../src/natural-suggestions.mjs";
import { decryptSecret, encryptSecret } from "../src/crypto.mjs";
import { cleanPublicChatText } from "../src/public-text.mjs";
import {
  parseOaSuggestions,
  retrieveOaSuggestions,
  suggestionKnowledgeReference,
  suggestionMatchesKnowledge,
} from "../src/oa-public.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const SERVICE_TOKEN = "A".repeat(43);
const SUGGESTIONS = Object.freeze([
  { id: "1", question: "《灵巧操作进展》有哪些值得关注的核心内容？", updatedAt: "2026-09-14" },
  { id: "2", question: "《OmindOS 巡检实践》有哪些值得关注的核心内容？", updatedAt: "2026-09-13" },
]);

const SOURCE_FIXTURES = Object.freeze([
  {
    title: "灵巧操作进展",
    excerpt: "触觉反馈能够帮助机器人在抓取物体时调整抓握力度。",
  },
  {
    title: "井下定位方案",
    excerpt: "无 GNSS 环境下，机器人通过激光雷达与惯性信息融合完成定位。",
  },
  {
    title: "四足矿井巡检",
    excerpt: "四足机器人能够在矿井和井下环境执行自主巡检任务。",
  },
  {
    title: "三维环境建图",
    excerpt: "机器人使用三维重建技术生成周围环境的三维地图。",
  },
  {
    title: "机器人语音控制",
    excerpt: "机器人接收语音指令后执行导航与操作任务。",
  },
]);

const FIVE_SOURCE_SUGGESTIONS = Object.freeze(SOURCE_FIXTURES.map((fixture, index) => ({
  id: String(index + 1),
  question: `《${fixture.title}》有哪些值得关注的核心内容？`,
  updatedAt: `2026-09-${String(14 - index).padStart(2, "0")}`,
})));

const CHAT_QUESTION_FIXTURES = Object.freeze([
  "触觉反馈能怎样帮助机器人抓稳物体？",
  "没有卫星信号时，机器人怎么定位？",
  "四足机器人能在矿井里完成哪些巡检任务？",
  "机器人怎样把周围环境重建成三维地图？",
  "怎样让机器人听懂指令并执行任务？",
  "机器人遇到故障后怎样恢复任务？",
]);

const SUGGESTION_TOKEN = `${"A".repeat(16)}.${"B".repeat(64)}`;

function knowledgeResponse(init) {
  const reference = suggestionKnowledgeReference(JSON.parse(init.body).question);
  return Response.json({ chunks: [{
    id: "1", title: reference.title, category: "research", sectionTitle: reference.sectionTitle || "",
    paragraphRef: "第 1 段", sourceLabel: "OA 公开知识", updatedAt: "2026-09-14",
    excerpt: reference.title === "灵巧操作进展"
      ? "触觉反馈能够帮助机器人在抓取物体时调整抓握力度。"
      : "无 GNSS 环境下，机器人通过激光雷达与惯性信息融合实现定位。",
  }] });
}

function assertNaturalPayload(payload) {
  assert.equal(payload.oaPublicStatus, "connected");
  assert.deepEqual(payload.suggestions.map((item) => item.question), [
    naturalQuestions([{ body: SOURCE_FIXTURES[0].excerpt }])[0],
    naturalQuestions([{ body: SOURCE_FIXTURES[1].excerpt }])[0],
  ]);
  for (const item of payload.suggestions) {
    assert.equal(typeof item.suggestionToken, "string");
    assert.doesNotMatch(item.question, /《|值得关注|\.(?:pptx?|pdf)|脱敏|脱密/iu);
  }
}

function environment(overrides = {}) {
  return {
    DB: new D1DatabaseAdapter(),
    APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    RELEASE_ID: `${"a".repeat(40)}-1`,
    ...overrides,
  };
}

function request(path, ip = "203.0.113.18") {
  return new Request(`${ORIGIN}${path}`, {
    headers: { "CF-Connecting-IP": ip },
  });
}

test("OA suggestion parser accepts only the exact bounded contract", () => {
  assert.deepEqual(parseOaSuggestions({ suggestions: SUGGESTIONS }), SUGGESTIONS);
  assert.deepEqual(parseOaSuggestions({ suggestions: FIVE_SOURCE_SUGGESTIONS }), FIVE_SOURCE_SUGGESTIONS);

  const invalid = [
    { suggestions: SUGGESTIONS, internal: true },
    { suggestions: [{ ...SUGGESTIONS[0], sourceUrl: "https://private.example" }] },
    { suggestions: [{ ...SUGGESTIONS[0], id: "2" }] },
    { suggestions: [{ ...SUGGESTIONS[0], updatedAt: "2026-02-30" }] },
    { suggestions: [{ ...SUGGESTIONS[0], question: "最近有哪些有趣内容？" }] },
    { suggestions: [SUGGESTIONS[0], { ...SUGGESTIONS[0], id: "2" }] },
    { suggestions: [
      ...FIVE_SOURCE_SUGGESTIONS,
      { id: "6", question: "《任务故障恢复》有哪些值得关注的核心内容？", updatedAt: "2026-09-09" },
    ] },
  ];
  for (const payload of invalid) {
    assert.throws(() => parseOaSuggestions(payload), /OA_RESPONSE_INVALID/u);
  }
});

test("Chat suggestion parser accepts five answerable questions and rejects a sixth", () => {
  const five = CHAT_QUESTION_FIXTURES.slice(0, 5).map((question, index) => ({
    id: String(index + 1),
    question,
    suggestionToken: SUGGESTION_TOKEN,
    updatedAt: `2026-09-${String(14 - index).padStart(2, "0")}`,
  }));
  assert.deepEqual(parseChatSuggestions(five), five);
  assert.throws(
    () => parseChatSuggestions([
      ...five,
      {
        id: "6",
        question: CHAT_QUESTION_FIXTURES[5],
        suggestionToken: SUGGESTION_TOKEN,
        updatedAt: "2026-09-09",
      },
    ]),
    /INVALID_SUGGESTIONS/u,
  );
});

test("suggestion references bind the generated title and optional section", () => {
  const sectionQuestion = "《灵巧操作进展》中的“触觉反馈”有哪些值得关注的内容？";
  assert.deepEqual(suggestionKnowledgeReference(sectionQuestion), {
    title: "灵巧操作进展",
    sectionTitle: "触觉反馈",
  });
  assert.equal(suggestionMatchesKnowledge(sectionQuestion, {
    title: "灵巧操作进展",
    sectionTitle: "触觉反馈",
  }), true);
  assert.equal(suggestionMatchesKnowledge(sectionQuestion, {
    title: "灵巧操作进展",
    sectionTitle: "视觉抓取",
  }), false);
  assert.equal(suggestionMatchesKnowledge(SUGGESTIONS[0].question, {
    title: "灵巧操作进展",
    sectionTitle: "任意公开章节",
  }), true);
});

test("OA suggestion adapter uses one hardened service-binding GET", async () => {
  let calls = 0;
  const result = await retrieveOaSuggestions({
    env: {
      PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
      OA_SERVICE: {
        async fetch(boundRequest) {
          calls += 1;
          assert.equal(boundRequest.url, OA_PUBLIC_SUGGESTIONS_URL);
          assert.equal(boundRequest.method, "GET");
          assert.equal(boundRequest.headers.get("x-originmind-public-lab-ai-service-token"), SERVICE_TOKEN);
          assert.equal(boundRequest.redirect, "manual");
          assert.equal(boundRequest.cache, "no-store");
          assert.equal(boundRequest.credentials, "omit");
          return Response.json({ suggestions: SUGGESTIONS });
        },
      },
    },
    runtime: { fetch: async () => { throw new Error("public fallback must not run"); } },
  });
  assert.deepEqual(result, { status: "connected", suggestions: SUGGESTIONS });
  assert.equal(calls, 1);
});

test("suggestion endpoint revalidates every connected set and exposes no static fallback", async (t) => {
  let calls = 0;
  const env = environment();
  t.after(() => env.DB.close());
  const runtime = {
    async fetch(url, init) {
      if (String(url) !== OA_PUBLIC_SUGGESTIONS_URL) return knowledgeResponse(init);
      calls += 1;
      assert.equal(String(url), OA_PUBLIC_SUGGESTIONS_URL);
      assert.equal(init.method, "GET");
      return Response.json({ suggestions: SUGGESTIONS });
    },
  };

  const first = await handleRequest(request("/api/suggestions"), env, {}, runtime);
  assert.equal(first.status, 200);
  assertNaturalPayload(await first.json());

  const revalidated = await handleRequest(request("/api/suggestions", "203.0.113.19"), env, {}, runtime);
  assert.equal(revalidated.status, 200);
  assertNaturalPayload(await revalidated.json());
  assert.equal(calls, 2);
});

test("source-bound chat ignores unrelated retrieval hits", async (t) => {
  const env = environment({ AI: { run: async () => { throw new Error("model must not run"); } } });
  t.after(() => env.DB.close());
  const response = await handleRequest(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.31",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: SUGGESTIONS[0].question }],
      }),
    }),
    env,
    {},
    {
      fetch: async () => Response.json({
        chunks: [{
          id: "1",
          title: "另一条公开知识",
          category: "research",
          sectionTitle: "灵巧操作进展",
          paragraphRef: "第 1 段",
          excerpt: "这段内容虽然被全文检索命中，但不属于推荐题目绑定的知识。",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
        }],
      }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "retrieval");
  assert.deepEqual(result.sources, []);
  assert.match(result.answer, /没有足够信息/u);
});

test("concurrent suggestion requests each revalidate with OA and create no replay cache", async (t) => {
  const env = environment({ RELEASE_ID: `${"c".repeat(40)}-1` });
  t.after(() => env.DB.close());
  let calls = 0;
  const runtime = {
    async fetch(url, init) {
      if (String(url) !== OA_PUBLIC_SUGGESTIONS_URL) return knowledgeResponse(init);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ suggestions: SUGGESTIONS });
    },
  };
  const responses = await Promise.all([
    handleRequest(request("/api/suggestions"), env, {}, runtime),
    handleRequest(request("/api/suggestions", "203.0.113.44"), env, {}, runtime),
  ]);
  assert.equal(calls, 2);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assertNaturalPayload(await response.json());
  }
  const cache = env.DB.sqlite.prepare(
    "SELECT id FROM settings WHERE id LIKE 'system-suggestions-oa-v1:%'",
  ).get();
  assert.equal(cache, undefined);
});

test("suggestion endpoint returns an empty list for invalid or unavailable OA output", async (t) => {
  const cases = [
    Response.json({ suggestions: [{ ...SUGGESTIONS[0], secret: "must not pass" }] }),
    new Response("unavailable", { status: 503 }),
  ];
  for (const [index, upstream] of cases.entries()) {
    const env = environment({ RELEASE_ID: `${"b".repeat(40)}-${index + 1}` });
    t.after(() => env.DB.close());
    const response = await handleRequest(
      request("/api/suggestions", `203.0.113.${20 + index}`),
      env,
      {},
      { fetch: async () => upstream.clone() },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.suggestions, []);
    assert.notEqual(result.oaPublicStatus, "connected");
  }
});

test("suggestion endpoint rejects query parameters", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const response = await handleRequest(
    request("/api/suggestions?topic=research"),
    env,
    {},
    { fetch: async () => { throw new Error("must not fetch"); } },
  );
  assert.equal(response.status, 400);
});

test("retrieved knowledge remains source evidence rather than an answer when the model is unavailable", async (t) => {
  const env = environment({
    AI: { run: async () => { throw new Error("model unavailable"); } },
  });
  t.after(() => env.DB.close());
  const response = await handleRequest(
    new Request(`${ORIGIN}/api/chat`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.30",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        topic: "research",
        messages: [{ role: "user", content: "灵巧操作研究有什么进展？" }],
      }),
    }),
    env,
    {},
    {
      fetch: async () => Response.json({
        chunks: [{
          id: "1",
          title: "灵巧操作研究",
          category: "research",
          sectionTitle: "研究进展",
          paragraphRef: "第 1 段",
          excerpt: "团队已公开机器人灵巧操作与系统设计方面的研究内容。",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
        }],
      }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "retrieval");
  assert.match(result.answer, /未能生成完整答复/u);
  assert.doesNotMatch(result.answer, /团队已公开机器人灵巧操作/u);
  assert.doesNotMatch(result.answer, /无法整理|换个.*问法/u);
});

test("fallback never concatenates duplicate or long approved excerpts", () => {
  const repeated = `公开内容${"甲".repeat(2200)}`;
  const answer = fallbackAnswer([{ body: repeated }, { body: repeated }, { body: "另一条公开内容。" }]);
  assert.match(answer, /未能生成完整答复/u);
  assert.doesNotMatch(answer, /公开内容|甲|另一条|知识库中与这个问题直接相关的内容包括/u);
});

test("questions come from excerpt topics, never filename metadata or unsupported placeholders", () => {
  const document = {
    title: "！Magan Robotic Manipulation_20260914_脱敏版.PPTX",
    body: "触觉反馈能够帮助机器人在抓取物体时调整抓握力度。",
  };
  const questions = naturalQuestions([document]);
  assert.equal(questions[0], naturalQuestions([{ body: document.body }])[0]);
  assert.doesNotMatch(questions.join(""), /Magan|20260914|PPT|脱敏|值得关注|《/u);
  assert.deepEqual(naturalQuestions([{ title: "矿井巡检.PPT", body: "暂无正文内容。" }]), []);
});

test("natural question wording is stable within one Beijing day and changes the next day", () => {
  const documents = [{
    title: "灵巧操作进展",
    body: "触觉反馈能够帮助机器人在抓取物体时调整抓握力度。",
  }];
  const beforeMidnight = new Date("2026-09-14T15:59:59.999Z");
  const sameBeijingDay = new Date("2026-09-14T03:00:00.000Z");
  const afterMidnight = new Date("2026-09-14T16:00:00.000Z");
  const first = naturalQuestions(documents, beforeMidnight);
  assert.ok(first.length > 0);
  assert.deepEqual(naturalQuestions(documents, sameBeijingDay), first);
  assert.notDeepEqual(naturalQuestions(documents, afterMidnight), first);
  for (const question of [...first, ...naturalQuestions(documents, afterMidnight)]) {
    assert.doesNotMatch(question, /《|值得关注|\.(?:pptx?|pdf)|脱敏|脱密/iu);
  }
});

test("naturalization emits five unique source-bound questions when OA has five answerable topics", async () => {
  const context = {
    env: {
      APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
      PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
    },
    runtime: {
      async fetch(_url, init) {
        const reference = suggestionKnowledgeReference(JSON.parse(init.body).question);
        const fixture = SOURCE_FIXTURES.find((candidate) => candidate.title === reference?.title);
        assert.ok(fixture, `unexpected retrieval question: ${JSON.parse(init.body).question}`);
        return Response.json({ chunks: [{
          id: "1",
          title: fixture.title,
          category: "research",
          sectionTitle: "",
          paragraphRef: "第 1 段",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
          excerpt: fixture.excerpt,
        }] });
      },
    },
  };
  const result = await naturalizeSuggestions(
    { status: "connected", suggestions: FIVE_SOURCE_SUGGESTIONS },
    context,
    Date.now() + 15_000,
    new Date("2026-09-14T08:00:00.000Z"),
  );
  assert.equal(result.status, "connected");
  assert.equal(result.suggestions.length, 5);
  assert.equal(new Set(result.suggestions.map((item) => item.question)).size, 5);
  assert.deepEqual(result.suggestions.map((item) => item.id), ["1", "2", "3", "4", "5"]);
  const sourceQuestions = [];
  for (const item of result.suggestions) {
    const sourceQuestion = await suggestionRetrievalQuestion(
      item.suggestionToken,
      item.question,
      context.env.APP_ENCRYPTION_KEY,
    );
    assert.ok(FIVE_SOURCE_SUGGESTIONS.some((source) => source.question === sourceQuestion));
    sourceQuestions.push(sourceQuestion);
    assert.doesNotMatch(item.question, /《|值得关注|\.(?:pptx?|pdf)|脱敏|脱密/iu);
  }
  assert.equal(new Set(sourceQuestions).size, 5);
});

test("naturalization returns only available answerable questions and never pads to five", async () => {
  const only = FIVE_SOURCE_SUGGESTIONS[0];
  const fixture = SOURCE_FIXTURES[0];
  const result = await naturalizeSuggestions(
    { status: "connected", suggestions: [only] },
    {
      env: {
        APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
        PUBLIC_LAB_AI_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      runtime: {
        fetch: async () => Response.json({ chunks: [{
          id: "1",
          title: fixture.title,
          category: "research",
          sectionTitle: "",
          paragraphRef: "第 1 段",
          sourceLabel: "OA 公开知识",
          updatedAt: "2026-09-14",
          excerpt: fixture.excerpt,
        }] }),
      },
    },
    Date.now() + 15_000,
    new Date("2026-09-14T08:00:00.000Z"),
  );
  assert.equal(result.status, "connected");
  assert.equal(result.suggestions.length, 1);
  assert.equal(
    await suggestionRetrievalQuestion(
      result.suggestions[0].suggestionToken,
      result.suggestions[0].question,
      "encryption-key-".padEnd(48, "e"),
    ),
    only.question,
  );
});

test("natural clicks bind to the original source without showing its upload filename", async (t) => {
  const env = environment();
  t.after(() => env.DB.close());
  const filename = "机器人抓取_20260914_脱敏版.PPTX";
  const sourceQuestion = `《${filename}》有哪些值得关注的核心内容？`;
  let sourceChanged = false;
  let retrievedQuestion;
  const runtime = { fetch: async (url, init) => {
    if (String(url) === OA_PUBLIC_SUGGESTIONS_URL) return Response.json({ suggestions: [
      { id: "1", question: sourceQuestion, updatedAt: "2026-09-14" },
    ] });
    retrievedQuestion = JSON.parse(init.body).question;
    return Response.json({ chunks: [{
      id: "1", title: filename, category: "research", sectionTitle: "触觉反馈",
      paragraphRef: "第 1 段", sourceLabel: "OA 公开知识", updatedAt: "2026-09-14",
      excerpt: sourceChanged ? "这项研究只讨论三维重建。" : "触觉反馈帮助机器人调整抓取物体时的力度。",
    }] });
  } };
  const listed = await handleRequest(request("/api/suggestions"), env, {}, runtime);
  const item = (await listed.json()).suggestions[0];
  assert.equal(item.question, naturalQuestions([{ body: "触觉反馈帮助机器人调整抓取物体时的力度。" }])[0]);
  assert.doesNotMatch(JSON.stringify(item), /PPTX|脱敏版|值得关注/u);
  const expectedSource = cleanPublicChatText(sourceQuestion).normalize("NFKC");
  assert.equal(await suggestionRetrievalQuestion(item.suggestionToken, item.question, env.APP_ENCRYPTION_KEY), cleanPublicChatText(sourceQuestion));
  const post = (overrides = {}) => handleRequest(new Request(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.71" },
    body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: item.question }], suggestionToken: item.suggestionToken, ...overrides }),
  }), env, {}, runtime);
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(retrievedQuestion, expectedSource);
  const answered = await response.json();
  assert.match(answered.answer, /未能生成完整答复/u);
  assert.doesNotMatch(answered.answer, /触觉反馈/u);
  assert.equal(answered.sources[0].excerpt, "触觉反馈帮助机器人调整抓取物体时的力度。");
  assert.equal((await post({ messages: [{ role: "user", content: "篡改后的问题" }] })).status, 400);
  const clear = JSON.parse(await decryptSecret(item.suggestionToken, env.APP_ENCRYPTION_KEY));
  const expired = await encryptSecret(JSON.stringify({ ...clear, expiresAt: Date.now() - 1 }), env.APP_ENCRYPTION_KEY);
  assert.equal((await post({ suggestionToken: expired })).status, 400);
  assert.equal((await post({ suggestionToken: `x${item.suggestionToken}` })).status, 400);
  sourceChanged = true;
  const changed = await (await post()).json();
  assert.deepEqual(changed.sources, []);
  assert.match(changed.answer, /没有足够信息/u);
});

test("model and retrieval fallback responses hide labels without breaking source binding or conversation tokens", async (t) => {
  for (const mode of ["ai", "retrieval"]) {
    const env = environment({ AI: { run: async () => {
      if (mode === "retrieval") throw new Error("model unavailable");
      return { response: "《巡检方案（脱敏版）》采用 ROS2 导航。[1]" };
    } } });
    t.after(() => env.DB.close());
    const response = await handleRequest(new Request(`${ORIGIN}/api/chat`, {
      method: "POST", headers: { "CF-Connecting-IP": "203.0.113.56", "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: "《巡检方案》有哪些值得关注的核心内容？" }] }),
    }), env, {}, { fetch: async () => Response.json({ chunks: [{
      id: "1", title: "巡检方案（脱敏版）", category: "research", sectionTitle: "方法（脱密版）", paragraphRef: "第 1 段",
      excerpt: "《巡检方案（脱敏版）》采用 ROS2 导航。", sourceLabel: "公开知识（匿名化）", updatedAt: "2026-09-14",
    }] }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, mode);
    if (mode === "ai") assert.match(result.answer, /ROS2/u);
    else {
      assert.match(result.answer, /未能生成完整答复/u);
      assert.doesNotMatch(result.answer, /ROS2/u);
    }
    assert.match(result.sources[0].excerpt, /ROS2/u);
    assert.equal(result.sources.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /脱敏|脱密|匿名化/u);
    assert.equal(typeof result.conversationToken, "string");
  }
});
