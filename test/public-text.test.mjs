import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { cleanPublicChatText } from "../src/public-text.mjs";
import { parseOaSuggestions, suggestionMatchesKnowledge } from "../src/oa-public.mjs";

const script = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
const helper = script.slice(script.indexOf("function cleanPublicChatText"), script.indexOf("const TOPIC_LABELS"));
const formatter = script.slice(script.indexOf("function referenceSectionStart"), script.indexOf("function serviceLabel"));
const browser = runInNewContext(`${helper}\n${formatter}\n({ cleanPublicChatText, knowledgeSuggestionsFromPayload, userFacingAnswer });`);

test("public display removes processing labels while keeping technical content and Markdown", () => {
  const samples = [
    ["《机器人技术（脱敏版）》中的“方法（脱密版）”有哪些值得关注的内容？", "《机器人技术》中的“方法”有哪些值得关注的内容？"],
    ["**系统方法**\n\n- 《控制方法（脱敏处理版）》：ROS2 / C++，145 Hz。", "**系统方法**\n\n- 《控制方法》：ROS2 / C++，145 Hz。"],
    ["Report (Redacted version) / sanitized / anonymized / 匿名化 / 去标识化", "Report  /  /  /  /"],
    ["正常技术正文，ROS2、2027 年、20 licence。", "正常技术正文，ROS2、2027 年、20 licence。"],
  ];
  for (const [input, expected] of samples) {
    assert.equal(cleanPublicChatText(input), expected);
    assert.equal(browser.cleanPublicChatText(input), expected);
  }
  assert.equal(browser.userFacingAnswer("《巡检方案（脱敏版）》使用 ROS2。[1]"), "《巡检方案》使用 ROS2。");
});

test("five cleaned questions stay bound to original knowledge and sixth is excluded", () => {
  const suggestions = Array.from({ length: 5 }, (_, i) => ({
    id: String(i + 1), question: `《机器人课题${i + 1}（脱敏版）》有哪些值得关注的核心内容？`, updatedAt: "2026-09-14",
  }));
  const parsed = parseOaSuggestions({ suggestions });
  assert.equal(parsed.length, 5);
  assert.doesNotMatch(JSON.stringify(parsed), /脱敏/u);
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(suggestionMatchesKnowledge(parsed[i].question, { title: `机器人课题${i + 1}（脱敏版）` }), true);
    assert.equal(suggestionMatchesKnowledge(parsed[i].question, { title: "另一项技术" }), false);
  }
  assert.throws(() => parseOaSuggestions({ suggestions: [...suggestions, { ...suggestions[0], id: "6" }] }));
  const visible = browser.knowledgeSuggestionsFromPayload({ suggestions: [...suggestions, { question: "第六个问题？" }] });
  assert.equal(visible.length, 5);
  assert.doesNotMatch(visible.join(""), /脱敏|第六/u);
});
