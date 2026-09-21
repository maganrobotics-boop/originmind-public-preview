import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/app.mjs";
import { fallbackAnswer } from "../src/knowledge.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
// Synthetic public text only: no uploaded screenshot, personal metadata or production data.
const excerpt = "7. 实验室培养特点\n\n示例实验室注重真实机器人任务，强调软硬协同与成果归档。\n\n一、实验室定位\n\n研究自主移动与智能操作。";
const chunks = [{
  id: "1", title: "示例实验室介绍", category: "research", sectionTitle: "培养特点",
  paragraphRef: "第7段", sourceLabel: "OA 公开知识", updatedAt: "2026-09-17", excerpt,
}, {
  id: "2", title: "示例实验室介绍", category: "research", sectionTitle: "人员介绍",
  paragraphRef: "第2段", sourceLabel: "OA 公开知识", updatedAt: "2026-09-17",
  excerpt: "示例实验室由周示例老师负责。",
}];

async function ask(t, { mode = "ai", question = "这个实验室是谁负责的", answer, answers, documents = chunks } = {}) {
  let prompt = "";
  let calls = 0;
  const env = {
    DB: new D1DatabaseAdapter(), APP_ORIGIN: ORIGIN,
    ADMIN_EMAIL: "owner@example.test", APP_ENCRYPTION_KEY: "encryption-key-".padEnd(48, "e"),
    RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43), RELEASE_ID: `${"a".repeat(40)}-1`,
  };
  if (mode !== "unavailable") env.AI = { run: async (_model, input) => {
    calls += 1;
    prompt = input.messages[0].content;
    if (mode === "failed") throw new Error("isolated model failure");
    return { response: answers?.[calls - 1] ?? answer ?? "示例实验室由**周示例老师**负责。[2]" };
  } };
  t.after(() => env.DB.close());
  const response = await handleRequest(new Request(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.97" },
    body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: question }] }),
  }), env, {}, { fetch: async () => Response.json({ chunks: documents }) });
  assert.equal(response.status, 200);
  return { result: await response.json(), prompt, calls };
}

for (const body of [excerpt, "普通介绍，不含 Markdown。", "| 场景 | 功能 |\n|---|---|\n|矿井|巡检|", "$$ L = T - V $$", "简介。".repeat(8000)]) {
  test(`fallback never uses an unverified excerpt (${body.slice(0, 20)})`, () => {
    const docs = [{ title: "示例文档", body }];
    const before = structuredClone(docs);
    const result = fallbackAnswer(docs);
    assert.match(result, /未能生成完整答复/u);
    assert.doesNotMatch(result, /实验室培养特点|实验室定位|普通介绍|场景|L = T|简介/u);
    assert.deepEqual(docs, before);
  });
}

test("no-document fallback does not falsely claim that a model was called", () => {
  assert.match(fallbackAnswer([]), /没有足够信息/u);
  assert.doesNotMatch(fallbackAnswer([]), /未能生成完整答复/u);
});

for (const [mode, reason, answer] of [
  ["unavailable", "model_unavailable"],
  ["failed", "generation_failed"],
  ["ai", "answer_validation_failed", "7. 实验室培养特点\n\n这里只介绍培养方式，没有回答谁负责。"],
  ["ai", "answer_validation_failed", "无关内容。[99]"],
]) {
  test(`who-is-responsible does not become a document dump when ${reason}`, async (t) => {
    const { result } = await ask(t, { mode, answer });
    assert.equal(result.mode, "retrieval");
    assert.equal(result.fallbackReason, reason);
    assert.match(result.answer, /未能生成完整答复/u);
    assert.doesNotMatch(result.answer, /实验室培养特点|实验室定位|软硬协同|无关内容|周示例/u);
    assert.equal(result.sources.length, 2);
    assert.match(result.sources[0].excerpt, /实验室培养特点/u);
    assert.equal(typeof result.conversationToken, "string");
  });
}

test("direct grounded answer names the responsible person and preserves hidden source validation", async (t) => {
  const { result, prompt } = await ask(t);
  assert.equal(result.mode, "ai");
  assert.equal(result.answer, "示例实验室由**周示例老师**负责。");
  assert.doesNotMatch(result.answer, /培养特点|实验室定位|\[2\]/u);
  assert.match(prompt, /第一句先回答对应的人物/u);
  assert.match(prompt, /不从作者、顾问或项目成员身份推断负责人/u);
  assert.match(prompt, /不沿用摘录中从第七节等位置开始的原始章节编号/u);
  assert.match(prompt, /每个有资料依据的具体事实后必须紧跟 \[1\]/u);
});

test("an image request without approved assets returns an explicit result without model generation", async (t) => {
  const { result, calls } = await ask(t, {
    question: "实验室机器人图片",
    answers: ["这里有实验室机器人图片。", "已找到与实验室机器人相关的已审核图片，页面会在回答下方展示关联原图。[1]"],
  });
  assert.equal(calls, 0);
  assert.equal(result.mode, "retrieval");
  assert.equal(result.fallbackReason, "no_images");
  assert.match(result.answer, /没有可展示的图片/u);
});

test("an explicit image request displays approved images without depending on model generation", async (t) => {
  const token = `v1_${"A".repeat(80)}`;
  const documents = [{ ...chunks[0], assets: [{ token, mimeType: "image/png", alt: "实验室机器人平台" }] }];
  const { result, calls } = await ask(t, { mode: "unavailable", question: "实验室机器人图片", documents });
  assert.equal(calls, 0);
  assert.equal(result.mode, "ai");
  assert.match(result.answer, /已审核资料图片/u);
  assert.deepEqual(result.images, [{ url: `/api/knowledge/assets/${token}`, mimeType: "image/png", alt: "实验室机器人平台" }]);
});

test("an explicitly requested technical explanation remains complete, not globally shortened", async (t) => {
  const detail = "系统先完成定位，再执行规划、动作与反馈验证，出现异常时重新检查状态并恢复任务。";
  const answer = `## 系统流程\n\n${`${detail}[1]\n\n`.repeat(90)}## 验证\n\n采用公式 \\( L = T - V \\)。[1]\n\n最后验证恢复后的任务结果，确认闭环完成。[1]`;
  const { result, prompt } = await ask(t, { question: "请详细介绍机器人的定位、规划、操作与恢复流程", answer });
  assert.equal(result.mode, "ai");
  assert.ok(result.answer.length > 3000);
  assert.match(result.answer, /最后验证恢复后的任务结果，确认闭环完成。$/u);
  assert.match(result.answer, /L = T - V/u);
  assert.match(prompt, /仍应充分、完整回答，不设固定短篇幅/u);
});

test("missing evidence neither invents a responsible person nor copies other sections", async (t) => {
  const { result, calls } = await ask(t, { documents: [] });
  assert.equal(calls, 0);
  assert.equal(result.fallbackReason, "no_documents");
  assert.match(result.answer, /没有足够信息/u);
  assert.doesNotMatch(result.answer, /周示例|实验室培养特点/u);
});

