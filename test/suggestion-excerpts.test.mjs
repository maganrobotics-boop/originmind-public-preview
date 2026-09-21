import assert from "node:assert/strict";
import test from "node:test";
import { OVERVIEW_QUESTIONS, overviewQuestions, suggestionEvidenceText } from "../src/suggestion-excerpts.mjs";

const BODY = "实验平台采用模块化设计，将动力单元、通信接口和采集设备分别安装在可拆卸支架上。维护人员可以独立更换损坏的部件，并在完成装配之后依次检查供电稳定性、接口连通性和数据记录情况，确认每个模块的状态符合要求。";

for (const prefix of [
  "源文件：说明.pdf ",
  "文件名：说明.docx。",
  "《安装说明 脱敏版.PPTX》 ",
  "（脱敏版） ",
  "参考说明.md；",
]) {
  test(`keeps body sharing a line with metadata: ${prefix}`, () => {
    const text = suggestionEvidenceText(prefix + BODY);
    assert.ok(text.includes(BODY.normalize("NFKC")));
    assert.doesNotMatch(text, /脱敏|\.pdf|\.docx|\.md|\.PPTX|文件名|源文件/u);
    assert.equal(overviewQuestions([text], 0).length, 1);
  });
}

test("does not infer a topic from filenames, links, image paths, or code samples", () => {
  for (const value of [
    "文件名：矿井巡检.PPTX",
    "《无 GNSS 定位方案.pdf》",
    "![矿井巡检](assets/矿井巡检.png)",
    "[说明](https://example.test/矿井巡检)",
    "```\n触觉反馈帮助机器人完成抓取。\n```",
    '<script>触觉反馈帮助机器人完成抓取。</script>',
    "<!-- 触觉反馈帮助机器人完成抓取。 -->",
  ]) {
    const text = suggestionEvidenceText(value);
    assert.doesNotMatch(text, /矿井|GNSS|触觉|抓取/u);
    assert.deepEqual(overviewQuestions([text], 0), []);
  }
});

test("overview wording is fixed, unique, and daily deterministic", () => {
  const text = suggestionEvidenceText(BODY);
  assert.deepEqual(overviewQuestions([text, text], 0), [OVERVIEW_QUESTIONS[0]]);
  assert.deepEqual(overviewQuestions([text], 2), [OVERVIEW_QUESTIONS[0]]);
  assert.deepEqual(overviewQuestions([text], 1), [OVERVIEW_QUESTIONS[1]]);
  assert.deepEqual(overviewQuestions([text], -1), [OVERVIEW_QUESTIONS[1]]);
  assert.doesNotMatch(overviewQuestions([text], 0).join(""), /模块化|维护人员/u);
});

test("does not pad empty, short, placeholder-only or repetitive material", () => {
  for (const text of ["", "暂无正文内容。", "暂无正文内容。".repeat(20), "待补充，尚未上传。".repeat(20), "说明。".repeat(50), "甲".repeat(200) + "。", null]) {
    assert.deepEqual(overviewQuestions([suggestionEvidenceText(text)], 0), []);
  }
  assert.deepEqual(overviewQuestions([], 0), []);
});

test("placeholder prefix does not discard the following real content", () => {
  assert.equal(overviewQuestions([suggestionEvidenceText("待补充。" + BODY)], 0).length, 1);
});
