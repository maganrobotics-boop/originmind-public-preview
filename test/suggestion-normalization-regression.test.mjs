import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/app.mjs";
import { OA_PUBLIC_SUGGESTIONS_URL } from "../src/constants.mjs";
import { naturalQuestions, naturalizeSuggestions, parseChatSuggestions, suggestionRetrievalQuestion } from "../src/natural-suggestions.mjs";
import { OVERVIEW_QUESTIONS } from "../src/suggestion-excerpts.mjs";
import { suggestionKnowledgeReference } from "../src/oa-public.mjs";
import { D1DatabaseAdapter } from "./d1-adapter.mjs";

const ORIGIN = "https://chat.omindos.ai";
const KEY = "encryption-key-".padEnd(48, "e");
const BODY = "实验平台采用模块化设计，将动力单元、通信接口和采集设备分别安装在可拆卸支架上。维护人员可以独立更换损坏的部件，并在完成装配之后依次检查供电稳定性、接口连通性和数据记录情况，确认每个模块的状态符合要求。";
const TACTILE = "触觉反馈帮助机器人调整抓取物体时的力度。";
const NOW = new Date("2026-09-17T08:00:00.000Z");
const source = (title, id = "1") => ({ id, question: `《${title}》有哪些值得关注的核心内容？`, updatedAt: "2026-09-17" });
const chunk = (title, excerpt) => ({ id: "1", title, category: "research", sectionTitle: "", paragraphRef: "第 1 段", sourceLabel: "OA 公开知识", updatedAt: "2026-09-17", excerpt });
const context = (fetch) => ({ env: { APP_ENCRYPTION_KEY: KEY, PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43) }, runtime: { fetch } });
const naturalize = (suggestions, fetch) => naturalizeSuggestions({ status: "connected", suggestions }, context(fetch), Date.now() + 13_000, NOW);

for (const prefix of ["源文件：讲义.pdf。", "文件名：抓取.docx；", "《实验讲义 脱敏版.PPTX》 ", "（脱敏版） "]) {
  test(`same-line metadata never deletes a supported topic: ${prefix}`, () => {
    assert.deepEqual(naturalQuestions([{ body: `${prefix}${TACTILE}` }], NOW), naturalQuestions([{ body: TACTILE }], NOW));
  });
}

test("unfamiliar substantive content yields only one strictly parsed, source-bound overview", async () => {
  const item = source("平台维护说明.pdf");
  const result = await naturalize([item], async () => Response.json({ chunks: [chunk("平台维护说明.pdf", `源文件：说明.pdf；${BODY}`)] }));
  assert.equal(result.status, "connected");
  assert.equal(result.suggestions.length, 1);
  assert.deepEqual(parseChatSuggestions(result.suggestions), result.suggestions);
  const [suggestion] = result.suggestions;
  assert.ok(OVERVIEW_QUESTIONS.includes(suggestion.question));
  assert.equal(await suggestionRetrievalQuestion(suggestion.suggestionToken, suggestion.question, KEY), item.question);
  assert.doesNotMatch(JSON.stringify(result.suggestions), /pdf|PPT|文件名|源文件|脱敏/u);
});

test("overview cannot be activated by unrelated hits, filenames, placeholders, or code", async () => {
  const item = source("平台维护说明.pdf");
  const invalid = [
    chunk("另一份平台说明", BODY),
    chunk("平台维护说明.pdf", "源文件：矿井巡检.PPTX；暂无正文内容。"),
    chunk("平台维护说明.pdf", `\`\`\`text\n${BODY}\n\`\`\``),
  ];
  for (const candidate of invalid) {
    const result = await naturalize([item], async () => Response.json({ chunks: [candidate] }));
    assert.deepEqual(result, { status: "connected", suggestions: [] });
  }
});

test("specific questions precede source-bound overviews without padding or duplicates", async () => {
  const sources = [source("维护说明"), source("触觉研究", "2"), source("另一份维护说明", "3")];
  const result = await naturalize(sources, async (_url, init) => {
    const reference = suggestionKnowledgeReference(JSON.parse(init.body).question);
    return Response.json({ chunks: [chunk(reference.title, reference.title === "触觉研究" ? TACTILE : BODY)] });
  });
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.suggestions[0].question, naturalQuestions([{ body: TACTILE }], NOW)[0]);
  assert.ok(OVERVIEW_QUESTIONS.includes(result.suggestions[1].question));
  assert.deepEqual(result.suggestions.map((item) => item.id), ["1", "2"]);
});

for (const [status, expected] of [[401, "auth_error"], [429, "rate_limited"], [503, "unavailable"]]) {
  test(`failed per-source retrieval reports ${expected}, not a connected empty set`, async () => {
    const result = await naturalize([source("维护说明")], async () => new Response("failure", { status }));
    assert.deepEqual(result, { status: expected, suggestions: [] });
  });
}

test("retrieval timeout remains visible while a successful partial set can still be used", async () => {
  const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
  assert.deepEqual(await naturalize([source("维护说明")], async () => { throw timeout; }), { status: "timeout", suggestions: [] });
  const result = await naturalize([source("维护说明"), source("触觉研究", "2")], async (_url, init) => {
    const reference = suggestionKnowledgeReference(JSON.parse(init.body).question);
    if (reference.title === "维护说明") throw timeout;
    return Response.json({ chunks: [chunk(reference.title, TACTILE)] });
  });
  assert.equal(result.status, "connected");
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].question, naturalQuestions([{ body: TACTILE }], NOW)[0]);
});

test("the real suggestion endpoint and chat revalidate overview evidence on every click", async (t) => {
  const env = {
    DB: new D1DatabaseAdapter(), APP_ORIGIN: ORIGIN, ADMIN_EMAIL: "owner@example.test",
    APP_ENCRYPTION_KEY: KEY, RATE_LIMIT_HMAC_KEY: "rate-limit-key-".padEnd(48, "r"),
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43), RELEASE_ID: `${"a".repeat(40)}-1`,
    AI: { run: async () => ({ response: "平台采用模块化设计，维护时分别检查供电、通信接口和数据记录。[1]" }) },
  };
  t.after(() => env.DB.close());
  const item = source("平台维护说明.pdf");
  let excerpt = `源文件：说明.pdf；${BODY}`;
  let receivedQuestion;
  const runtime = { fetch: async (url, init) => {
    if (String(url) === OA_PUBLIC_SUGGESTIONS_URL) return Response.json({ suggestions: [item] });
    receivedQuestion = JSON.parse(init.body).question;
    return Response.json({ chunks: [chunk("平台维护说明.pdf", excerpt)] });
  } };
  const listed = await handleRequest(new Request(`${ORIGIN}/api/suggestions`, { headers: { "CF-Connecting-IP": "203.0.113.101" } }), env, {}, runtime);
  assert.equal(listed.status, 200);
  const payload = await listed.json();
  assert.equal(payload.oaPublicStatus, "connected");
  assert.equal(payload.suggestions.length, 1);
  const suggestion = payload.suggestions[0];
  const click = () => handleRequest(new Request(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.102" },
    body: JSON.stringify({ topic: "research", messages: [{ role: "user", content: suggestion.question }], suggestionToken: suggestion.suggestionToken }),
  }), env, {}, runtime);
  const answer = await (await click()).json();
  assert.equal(receivedQuestion, item.question.normalize("NFKC"));
  assert.equal(answer.mode, "ai");
  assert.equal(answer.sources.length, 1);
  assert.match(answer.answer, /模块化设计/u);
  excerpt = "暂无正文内容。";
  const revoked = await (await click()).json();
  assert.deepEqual(revoked.sources, []);
  assert.match(revoked.answer, /没有足够信息/u);
});
