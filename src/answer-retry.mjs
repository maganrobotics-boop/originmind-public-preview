const DEFAULT_RETRY_INSTRUCTION = "\n\n上一次生成结果未能通过完整性校验。请重新独立作答，只输出完整正文，不要输出网址、联系方式、HTML 或未完成的句子。";

function retryMessages(messages, instruction) {
  return messages.map((message, index) => index === 0 && message.role === "system"
    ? { ...message, content: `${message.content}${instruction}` }
    : message);
}

export async function generateValidatedAnswer({ messages, generate, validate, attempts = 2, retryInstruction = DEFAULT_RETRY_INSTRUCTION }) {
  let failureReason = "generation_failed";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let answer;
    try {
      answer = await generate(attempt === 0 ? messages : retryMessages(messages, retryInstruction));
    } catch {
      failureReason = "generation_failed";
      return { visible: null, failureReason };
    }
    const visible = validate(answer);
    if (visible) return { visible };
    failureReason = "answer_validation_failed";
  }
  return { visible: null, failureReason };
}
