import test from "node:test";
import assert from "node:assert/strict";
import { completeModelAnswer, MAX_COMPLETE_ANSWER_CHARS } from "../src/answer-completion.mjs";
const messages = [{ role: "system", content: "grounded" }, { role: "user", content: "解释机器人" }];

test("complete answers are not continued or shortened", async () => {
  let calls = 0;
  const text = "完整技术说明。".repeat(800);
  assert.equal(await completeModelAnswer(messages, 4096, async () => { calls++; return { text, finishReason: "stop" }; }), text);
  assert.equal(calls, 1);
});
test("length stop continues once with original instructions and partial answer", async () => {
  const inputs = []; let budget = 0;
  const result = await completeModelAnswer(messages, 4096, async (input) => {
    inputs.push(input);
    return inputs.length === 1 ? { text: "第一部分[1]。然后", finishReason: "length" } : { text: "完成说明[1]。", finishReason: "stop" };
  }, async () => { budget++; });
  assert.equal(result, "第一部分[1]。然后完成说明[1]。");
  assert.equal(inputs.length, 2); assert.equal(budget, 1);
  assert.deepEqual(inputs[1].slice(0, 2), messages);
  assert.equal(inputs[1][2].role, "assistant");
  assert.match(inputs[1][3].content, /不得.*编造/u);
  assert.equal(messages.length, 2);
});
test("continuation failure preserves partial answer and explicit notice", async () => {
  let calls = 0;
  const result = await completeModelAnswer(messages, 4096, async () => {
    if (++calls === 2) throw new Error("offline");
    return { text: "已生成部分[1]。", finishReason: "length" };
  });
  assert.match(result, /^已生成部分/u); assert.match(result, /尚未完整生成/u);
});
test("repeat length stops are bounded to two calls", async () => {
  let calls = 0;
  const result = await completeModelAnswer(messages, 4096, async () => { calls++; return { text: "内容[1]。", finishReason: "length" }; });
  assert.equal(calls, 2); assert.match(result, /尚未完整生成/u);
});
test("probes and filtered responses are never continued", async () => {
  for (const [tokens, finishReason] of [[8, "length"], [4096, "content_filter"], [4096, "stop"], [4096, undefined]]) {
    let calls = 0;
    await completeModelAnswer(messages, tokens, async () => { calls++; return { text: "回答", finishReason }; });
    assert.equal(calls, 1);
  }
});
test("budget refusal stops continuation without losing original text", async () => {
  let calls = 0;
  const result = await completeModelAnswer(messages, 4096, async () => { calls++; return { text: "原回答[1]。", finishReason: "length" }; }, async () => { throw new Error("budget"); });
  assert.equal(calls, 1); assert.match(result, /^原回答/u); assert.match(result, /尚未完整生成/u);
});
test("answer safety bound keeps notice and valid Unicode", async () => {
  const result = await completeModelAnswer(messages, 4096, async () => ({ text: "甲😀".repeat(7000), finishReason: "stop" }));
  assert.ok(result.length <= MAX_COMPLETE_ANSWER_CHARS);
  assert.equal(result, result.toWellFormed()); assert.match(result, /尚未完整生成/u);
});
test("exact long overlap is deduplicated", async () => {
  let calls = 0;
  const overlap = "这是上一段结尾需要避免重复的技术内容。";
  const result = await completeModelAnswer(messages, 4096, async () => ++calls === 1
    ? { text: `说明[1]。${overlap}`, finishReason: "length" }
    : { text: `${overlap}补充[1]。`, finishReason: "stop" });
  assert.equal(result, `说明[1]。${overlap}补充[1]。`);
});
test("missing first answer fails rather than fabricating", async () => {
  await assert.rejects(completeModelAnswer(messages, 4096, async () => ({ text: "" })), /MODEL_ANSWER_EMPTY/u);
});
test("notice is not hidden inside unfinished code block", async () => {
  const result = await completeModelAnswer(messages, 4096, async () => ({ text: "```cpp\nint x;", finishReason: "length" }));
  assert.match(result, /\n```\n\n> 本次回答/u);
});
