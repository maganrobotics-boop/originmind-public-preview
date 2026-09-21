import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import katex from "../node_modules/katex/dist/katex.mjs";
import { answerMathTokenAt, normalizeAnswerMathTex, protectAnswerTechnicalText } from "../src/answer-math.mjs";

const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class TestNode {
  constructor(tag = "#text", text = "") { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes.map((n) => n instanceof TestNode ? n : new TestNode("#text", String(n)))); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
}
const document = { createElement: (tag) => new TestNode(tag), createTextNode: (text) => new TestNode("#text", text) };
function harness(engine) {
  return runInNewContext(`
    ${section("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}
    ${section("function element(", "function icon(")}
    ${section("function referenceSectionStart", "function serviceLabel")}
    answerMathEngine = engine;
    ({renderAnswerBody, userFacingAnswer, answerTableCells, renderAnswerMath});
  `, { document, Node: TestNode, engine });
}
const nodes = (root, tag) => [...(root.tag === tag ? [root] : []), ...root.children.flatMap((c) => nodes(c, tag))];
const mathNodes = (root) => nodes(root, "span").filter((n) => n.attributes["data-math-status"]);
const api = harness(null);

test("browser and Worker share exactly the same technical-token scanner", async () => {
  const shared = await readFile(new URL("../src/answer-math.mjs", import.meta.url), "utf8");
  const expected = shared.replaceAll("export function ", "function ").trim();
  assert.equal(section("// BEGIN SHARED ANSWER TOKENS", "// END SHARED ANSWER TOKENS")
    .replace("// BEGIN SHARED ANSWER TOKENS", "").trim(), expected);
});

test("all four formula delimiters and naked matrices preserve exact TeX", () => {
  for (const raw of [String.raw`\(x_i^2\)`, "$x_i^2$", String.raw`\[\frac{a}{b}\]`, "$$x+y$$",
    String.raw`\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}`]) {
    const token = answerMathTokenAt(raw, 0);
    assert.equal(token.raw, raw); assert.equal(token.end, raw.length);
    const protectedText = protectAnswerTechnicalText(`before ${raw} after`);
    assert.equal(protectedText.tokens.length, 1);
    assert.equal(protectedText.restore(protectedText.text), `before ${raw} after`);
    assert.equal(mathNodes(api.renderAnswerBody(raw)).length, 1);
  }
});

test("citation cleanup preserves formula arrays, matrices and literal code", () => {
  const technical = String.raw`\(x[999] + a_{[1]}\)`;
  assert.equal(api.userFacingAnswer(`结论：**${technical}**。[1]\n\n参考文献：\n[1] 资料`), `结论：**${technical}**。`);
  assert.equal(api.userFacingAnswer("代码 `a[999]`。[1]"), "代码 `a[999]`。");
  assert.equal(api.userFacingAnswer("```js\nconst a = [[1], [2]];\n```\n结论。[1]"), "```js\nconst a = [[1], [2]];\n```\n结论。");
  const collision = `\uE000M0\uE001 ${technical}`;
  const protectedText = protectAnswerTechnicalText(collision);
  assert.equal(protectedText.restore(protectedText.text), collision);
});

test("currency, escaped delimiters, unmatched formulas and code remain literal", () => {
  for (const value of ["价格 $5 and $10", String.raw`\$x\$`, String.raw`未完成 \(x_i`, "未完成 $$x_i", "`$x$`", "```js\n$x$\n```", String.raw`\\(literal)`]) {
    const result = api.renderAnswerBody(value);
    assert.equal(mathNodes(result).length, 0, value);
    if (value.includes("未完成")) assert.equal(result.textContent, value);
  }
});

test("bold supports nested emphasis, code, formula and Chinese punctuation", () => {
  const result = api.renderAnswerBody(String.raw`**结论：*稳定*，\(x_i\)，` + "`code`" + "**\n\n***重要*** 和 __关键参数__，~~旧结论~~。");
  assert.equal(nodes(result, "strong").length, 3);
  assert.equal(nodes(result, "em").length, 2);
  assert.equal(nodes(result, "del").length, 1);
  assert.equal(mathNodes(result).length, 1);
  assert.equal(api.renderAnswerBody("robot_joint_state").textContent, "robot_joint_state");
});

test("multiline math, math code fences, headings and table alignment are rendered", () => {
  const result = api.renderAnswerBody("## 运动模型\n\n" + String.raw`\[
A = \begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]` + "\n\n```latex\n\\frac{v}{r}\n```\n\n| **参数** | **公式** |\n| :--- | ---: |\n| 范数 | $|x|$ |\n\n---\n\n1、 第一步");
  assert.equal(nodes(result, "h4").length, 1);
  assert.equal(mathNodes(result).length, 3);
  assert.equal(nodes(result, "pre").length, 0);
  assert.equal(nodes(result, "th")[1].attributes["data-align"], "right");
  assert.equal(nodes(result, "td").length, 2);
  assert.equal(nodes(result, "hr").length, 1);
  assert.equal(nodes(result, "ol").length, 1);
  assert.deepEqual(Array.from(api.answerTableCells("| `a|b` | $|x|$ |")), ["`a|b`", "$|x|$"]);
});

test("real KaTeX renders fractions, indices, matrices and cases as native MathML", () => {
  for (const tex of [String.raw`\frac{a_1}{b^2}`, String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}`,
    String.raw`\begin{cases}x&x>0\\0&x\le0\end{cases}`, String.raw`x[999]`, String.raw`\sum_{i=1}^{n}x_i`]) {
    const markup = katex.renderToString(tex, { output: "mathml", displayMode: true, trust: false, throwOnError: true });
    assert.match(markup, /<math/u); assert.doesNotMatch(markup, /class="katex-html"/u);
  }
});

test("math rendering is untrusted and bounded, failures never delete the formula", () => {
  const calls = [];
  const renderer = harness({ render(tex, node, options) { calls.push({tex, options}); node.textContent = "MATH"; } });
  assert.equal(renderer.renderAnswerBody("$x^2$").textContent, "MATH");
  assert.equal(calls[0].options.trust, false);
  assert.equal(calls[0].options.output, "mathml");
  assert.equal(calls[0].options.maxExpand, 1000);
  assert.equal(calls[0].options.maxSize, 10);
  const failed = harness({ render() { throw Error("bad tex"); } }).renderAnswerBody("$\\bad{x}$");
  assert.equal(failed.textContent, "$\\bad{x}$");
  assert.equal(mathNodes(failed)[0].attributes["data-math-status"], "fallback");
  const bounded = renderer.renderAnswerBody(`$${"x".repeat(8001)}$`);
  assert.equal(mathNodes(bounded)[0].attributes["data-math-status"], "fallback");
  assert.equal(calls.length, 1);
  const malicious = katex.renderToString(String.raw`\href{javascript:alert(1)}{x}`, { output: "mathml", trust: false, throwOnError: false, strict: "ignore" });
  assert.doesNotMatch(malicious, /<(?:a|script)\b|href="javascript:/iu);
});

test("ordinary model markup stays inert and long answers do not lose their ending", () => {
  const result = api.renderAnswerBody('<img src=x onerror=alert(1)> **重点** [link](javascript:alert(1))');
  assert.equal(nodes(result, "img").length, 0); assert.equal(nodes(result, "a").length, 0);
  const long = "内容".repeat(6500) + "\n\n**完整结尾**";
  assert.match(api.renderAnswerBody(long).textContent, /完整结尾$/u);
});

test("the answer footer keeps copy but no further-inquiry entry", () => {
  const footer = section("function assistantMessageNode", "function dispatchQuestion");
  assert.match(footer, /actions\.append\(copy, copyLink, shareLink\)/u);
  assert.doesNotMatch(footer, /further-inquiry|需要?进一步交流|openInquiry/u);
});


test("screenshot regression: padded scalar and multiline dynamics formulas are all recognized", async () => {
  const answer = await readFile(new URL("./fixtures/robot-dynamics-answer.md", import.meta.url), "utf8");
  const tokens = protectAnswerTechnicalText(answer);
  assert.equal(tokens.tokens.filter((token) => token.kind === "math").length, 8);
  assert.equal(tokens.restore(tokens.text), answer);
  const result = api.renderAnswerBody(api.userFacingAnswer(answer));
  assert.equal(mathNodes(result).length, 8);
  for (const token of tokens.tokens.filter((token) => token.kind === "math")) {
    assert.match(katex.renderToString(token.tex, { output: "mathml", throwOnError: true }), /<math/u);
  }
});

test("padded math does not swallow currency, escaped dollars, code or incomplete text", () => {
  for (const value of ["价格 $ 5 and $ 10", "价格 $5 and $10", String.raw`\$ T \$`, "`$ L = T - V $`", "未完成 $ L = T - V"]) {
    assert.equal(mathNodes(api.renderAnswerBody(value)).length, 0, value);
  }
  assert.equal(mathNodes(api.renderAnswerBody("价格 $5 and $10，公式 $ L = T - V $。")).length, 1);
  for (const value of ["$ T $", "$ q_i $", String.raw`$ \tau_i $`, "$ L = T - V $", "$x $", "$ x$"]) {
    assert.equal(mathNodes(api.renderAnswerBody(value)).length, 1, value);
    assert.equal(answerMathTokenAt(value, 0).raw, value);
  }
});

test("matrix recovery restores only explicit broken row separators and preserves raw text", () => {
  const damaged = String.raw`\begin{bmatrix}
I_{xx} & I_{xy} & I_{xz} \
I_{yx} & I_{yy} & I_{yz} \
I_{zx} & I_{zy} & I_{zz}
\end{bmatrix}`;
  const repaired = normalizeAnswerMathTex(damaged);
  assert.notEqual(repaired, damaged);
  const markup = katex.renderToString(repaired, {output:"mathml",throwOnError:true});
  assert.equal((markup.match(/<mtr>/gu) || []).length, 3);
  assert.equal((markup.match(/<mtd(?:>| )/gu) || []).length, 9);
  assert.equal(normalizeAnswerMathTex(repaired), repaired);
  const protectedText = protectAnswerTechnicalText(`$$${damaged}$$`);
  assert.equal(protectedText.restore(protectedText.text), `$$${damaged}$$`);
  const calls = [];
  harness({render(tex, node) {calls.push(tex); node.textContent="MATH";}}).renderAnswerBody(`$$${damaged}$$`);
  assert.equal(calls[0],repaired);
});

test("matrix recovery never invents rows from wrapping, uneven columns, nested blocks or code", () => {
  const values = [String.raw`\frac{d}{dt}\left(\frac{\partial L}{\partial \dot{q}_i}\right)`,
    String.raw`\begin{bmatrix}a & b
c & d\end{bmatrix}`,
    String.raw`\begin{bmatrix}a & b \
c & d & e\end{bmatrix}`,
    String.raw`\begin{bmatrix}\text{a} & b \
c & d\end{bmatrix}`,
    String.raw`\begin{bmatrix}a & b \\
c & d\end{bmatrix}`];
  for (const value of values) assert.equal(normalizeAnswerMathTex(value), value);
  const literal = "```js\n" + values[2] + "\n```";
  assert.equal(mathNodes(api.renderAnswerBody(literal)).length, 0);
  assert.equal(nodes(api.renderAnswerBody(literal),"code")[0].textContent,values[2]);
});
