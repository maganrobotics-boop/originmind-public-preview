// Recommendation wording is fixed application text. Only approved, source-bound
// body excerpts may activate it; upload names and processing labels are not topics.
export const OVERVIEW_QUESTIONS = Object.freeze([
  "这些内容主要介绍了什么？",
  "这些内容有哪些主要要点？",
]);

export function suggestionEvidenceText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/^\s*---\n[\s\S]*?\n---(?:\n|$)/u, " ")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/!\[[^\]\n]*\]\([^\n)]*\)/gu, " ")
    .replace(/\[([^\]\n]*)\]\([^\n)]*\)/gu, "$1")
    .replace(/<[^>\n]*>/gu, " ")
    // Strip the filename itself, not the rest of its paragraph. OA can flatten
    // an entire Markdown paragraph, including its provenance, onto one line.
    .replace(/《[^》\n]*\.(?:pptx?|pdf|docx?|md)》|“[^”\n]*\.(?:pptx?|pdf|docx?|md)”|"[^"\n]*\.(?:pptx?|pdf|docx?|md)"/giu, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu, " ")
    .replace(/[^\s<>\[\](){}《》“”"'，,。；;：:|]+\.(?:pptx?|pdf|docx?|md)\b/giu, " ")
    .replace(/[（(]?(?:脱敏|脱密|匿名化)(?:版本|版)?[）)]?/gu, " ")
    .replace(/(?:文件名|源文件|文档名称|资料名称)\s*[:：]\s*/gu, " ")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ").trim();
}

export function overviewQuestions(excerpts, day) {
  // An overview is grounded in readable body content, never an unconditional
  // default. Empty, placeholder-only, filename-only and repeated text stay empty.
  const meaningful = excerpts.some((excerpt) => {
    const body = excerpt.split(/(?<=[。！？；.!?;])/u)
      .filter((sentence) => !/^(?:\s*[#>*-]*\s*)?(?:暂无(?:正文|内容|资料|数据)|没有(?:正文|内容|资料)|待(?:补充|上传|整理)|内容待完善)/u.test(sentence))
      .join(" ");
    const letters = body.match(/[\p{L}\p{N}]/gu) || [];
    return letters.length >= 60 && new Set(letters).size >= 16 && /[。！？；.!?;]/u.test(body);
  });
  if (!meaningful) return [];
  return [OVERVIEW_QUESTIONS[((day % OVERVIEW_QUESTIONS.length) + OVERVIEW_QUESTIONS.length) % OVERVIEW_QUESTIONS.length]];
}
