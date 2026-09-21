import { decryptSecret, encryptSecret } from "./crypto.mjs";

const MAX_HISTORY_CHARS = 8_000;
const MAX_TURNS = 8;
const PURPOSE = "arts-public-conversation-v1";

function boundedTurns(turns) {
  const result = [];
  let remaining = MAX_HISTORY_CHARS;
  for (const turn of turns.slice(-MAX_TURNS).reverse()) {
    if (!remaining) break;
    const content = turn.content.slice(-Math.min(remaining, 3_000));
    result.unshift({ role: turn.role, content });
    remaining -= content.length;
  }
  while (result[0]?.role === "assistant") result.shift();
  return result;
}

export async function conversationHistory(payload, secret) {
  if (!payload.conversationToken) return [];
  try {
    const value = JSON.parse(await decryptSecret(payload.conversationToken, secret));
    if (value.purpose !== PURPOSE || value.topic !== payload.topic || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now() || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS
      || value.turns.some((turn) => !["user", "assistant"].includes(turn?.role)
        || typeof turn.content !== "string" || !turn.content.length || turn.content.length > 3_000)) return [];
    return boundedTurns(value.turns);
  } catch {
    return [];
  }
}

export async function conversationToken(topic, history, question, answer, secret) {
  return encryptSecret(JSON.stringify({
    purpose: PURPOSE,
    topic,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    turns: boundedTurns([...history, { role: "user", content: question }, { role: "assistant", content: answer }]),
  }), secret);
}

export function retrievalQuestion(question, history) {
  // A short follow-up such as “第二点呢” needs the preceding subject for retrieval.
  // Current, specific questions remain the primary search query.
  if (question.length > 60 || !/继续|详细|展开|具体|这个|那个|这些|它|他们|上述|第.{0,3}[点项个]|为什么|如何|怎么|怎样/u.test(question)) return question;
  const previous = history.filter((turn) => turn.role === "user").at(-1)?.content;
  return previous ? `${question}\n前文问题：${previous.slice(0, 400)}` : question;
}
