/** Bounded continuation: preserve completed text, never silently report truncation as success. */
export const MAX_COMPLETE_ANSWER_CHARS = 12_000;
const CONTINUATION_PROMPT = "请严格从上一段回答的断点继续，完成尚未回答的内容。不要重复已经写出的内容，不要重新开头。继续遵守原有资料依据、事实编号和安全规则；资料不足就说明不足，不得为延长回答编造信息。";
const INCOMPLETE_NOTICE = "\n\n> 本次回答尚未完整生成（输出额度或连接限制）。可发送“继续”，从中断处补充。";

function appendNotice(text) {
  let prefix = text.slice(0, MAX_COMPLETE_ANSWER_CHARS - INCOMPLETE_NOTICE.length - 8);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  const fences = prefix.match(/^\s*```/gmu) || [];
  if (fences.length % 2) prefix += "\n```";
  return prefix.trimEnd() + INCOMPLETE_NOTICE;
}

function textFrom(result) {
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("MODEL_ANSWER_EMPTY");
  }
  return result.text;
}

function mergeContinuation(first, next) {
  // Providers sometimes repeat the last sentence. Only remove exact overlap.
  const bound = Math.min(512, first.length, next.length);
  for (let size = bound; size >= 16; size -= 1) {
    if (first.endsWith(next.slice(0, size))) return first + next.slice(size);
  }
  return first + next;
}

/**
 * call(messages) returns { text, finishReason }. A normal answer uses one call;
 * an explicit length stop permits one continuation. No retry after filtering.
 * Probes with small token budgets must never trigger an extra paid request.
 */
export async function completeModelAnswer(messages, maxTokens, call, beforeContinuation = async () => {}) {
  const first = await call(messages);
  const text = textFrom(first);
  if (text.length > MAX_COMPLETE_ANSWER_CHARS) return appendNotice(text);
  if (first.finishReason !== "length" || maxTokens < 512) return text;
  try {
    await beforeContinuation();
    const next = await call([
      ...messages,
      { role: "assistant", content: text },
      { role: "user", content: CONTINUATION_PROMPT },
    ]);
    const combined = mergeContinuation(text, textFrom(next));
    if (next.finishReason === "length" || next.finishReason === "content_filter" || combined.length > MAX_COMPLETE_ANSWER_CHARS) {
      return appendNotice(combined);
    }
    return combined;
  } catch {
    // A failed continuation must not discard the original grounded response.
    return appendNotice(text);
  }
}
