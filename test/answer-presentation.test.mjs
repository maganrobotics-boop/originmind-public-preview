import assert from "node:assert/strict";
import test from "node:test";
import { cleanAnswerPresentation, boundedKnowledgeExcerpt } from "../src/answer-presentation.mjs";

const screenshot = "知识库中与这个问题直接相关的内容包括：\n\n- # ARTS Robotics 实验室两大科研方向介绍 > 版本:V1.0 > 更新时间:2026 年 9 月 > 适用范围:实验室官网、知识库、招生宣讲、项目申报与合作交流 ## 一、实验室定位 ARTS Robotics 聚焦机器人自主移动与智能操作。\n- 第二项内容。";

test("cleans the reported collapsed reply without dropping its substantive content", () => {
  const result = cleanAnswerPresentation(screenshot);
  assert.doesNotMatch(result, /知识库中|版本|更新时间|适用范围|两大科研方向介绍|[-*] #/u);
  assert.match(result, /^## 一、实验室定位\n\nARTS Robotics/u);
  assert.match(result, /自主移动与智能操作。/u);
  assert.match(result, /第二项内容。/u);
});

test("cleans document front matter and duplicate title but preserves section headings", () => {
  const text = "# 科研方向介绍\n\n> 版本：V1.0\n> 更新时间：2026年9月\n> 适用范围：宣传\n\n## 自主移动\n\n**多源融合定位**。\n\n- 建图\n- 导航";
  assert.equal(cleanAnswerPresentation(text, { title: "科研方向介绍", document: true }), "## 自主移动\n\n**多源融合定位**。\n\n- 建图\n- 导航");
});

test("source metadata in the middle never discards later answer paragraphs", () => {
  assert.equal(cleanAnswerPresentation("第一段。\n\n来源：某资料.pdf\n\n第二段。\n出处：某报告\n\n第三段。"), "第一段。\n\n第二段。\n\n第三段。");
});

test("removes only attribution leads while keeping internal grounding numbers", () => {
  assert.equal(cleanAnswerPresentation("根据《研究介绍》，建议先验证定位可靠性。[1]\n\n依据公开资料表明：控制系统采用 ROS 2。[2]"), "建议先验证定位可靠性。[1]\n\n控制系统采用 ROS 2。[2]");
});

test("standalone quoted provenance is hidden", () => {
  assert.equal(cleanAnswerPresentation("结论。\n本文引自《科研方向介绍》。\n摘自：《附件.pdf》\n补充。"), "结论。\n补充。");
});

test("ordinary titles, bold text, tables, dates and technical scope are unchanged", () => {
  const text = "# 建议优先开展实机验证\n\n**关键结论**：先做可靠定位。\n\n版本：ROS 2 Humble\n\n适用范围：地下矿井\n\n2026 年 9 月完成现场测试。\n\n| 项目 | 参数 |\n| --- | --- |\n| 频率 | 20 Hz |";
  assert.equal(cleanAnswerPresentation(text), text);
});

test("technical prose using source words is not treated as provenance", () => {
  const text = "误差来源主要是轮胎打滑。数据来自激光雷达。能量来源：电池。C# 和井号 # 都应保留。";
  assert.equal(cleanAnswerPresentation(text), text);
});

test("protects code, math, URLs and technical hash characters byte for byte", () => {
  const code = "```cpp\n#include <vector>\n// 来源：传感器\n// 版本：V1.0\n```";
  const formula = String.raw`\[\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}_{[1]} + \text{来源：测量}\]`;
  const text = `${code}\n\n${formula}\n\n\`#include\` 与 $x_{[1]}$，https://example.test/#section`;
  assert.equal(cleanAnswerPresentation(text), text);
});

test("YAML metadata is omitted but an ordinary horizontal rule remains", () => {
  assert.equal(cleanAnswerPresentation("---\ntitle: intro\nversion: 1.0\n---\n\n正文。"), "正文。");
  const rule = "---\n\n正文。\n\n---\n\n结论。";
  assert.equal(cleanAnswerPresentation(rule), rule);
});

test("empty and non-string inputs are handled consistently", () => {
  assert.equal(cleanAnswerPresentation(null), "");
  assert.equal(cleanAnswerPresentation(12), "12");
});

test("cleaning is idempotent for new and restored conversations", () => {
  const clean = cleanAnswerPresentation(screenshot);
  assert.equal(cleanAnswerPresentation(clean), clean);
});

test("excerpt caps preserve whole technical tokens", () => {
  const text = `${"甲".repeat(65)}${String.raw`\[x_{[1]}=\frac{a}{b}\]`}${"乙".repeat(90)}`;
  assert.match(boundedKnowledgeExcerpt(text, 80), /\\\[x_\{\[1\]\}=\\frac\{a\}\{b\}\\\]/u);
  assert.doesNotMatch(boundedKnowledgeExcerpt(text, 68), /\uE000|\uE001/u);
  assert.ok(boundedKnowledgeExcerpt(text, 68).endsWith("…"));
});
