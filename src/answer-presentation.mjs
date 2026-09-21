import { protectAnswerTechnicalText } from "./answer-math.mjs";

// Recover only unambiguous, pipe-bounded rows with a real Markdown divider.
// Empty/escaped cells and malformed rows remain untouched; never guess cells.
function restoreFlattenedAnswerTables(value) {
  return value.split("\n").map((line) => {
    if (!/\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(line)) return line;
    const rows = line.split(/\|[ \t]*\|/u);
    if (rows.length < 3) return line;
    for (let index = 1; index < rows.length; index += 1) {
      const divider = rows[index].split("|").map((cell) => cell.trim());
      if (divider.length < 2 || divider.length > 8 || !divider.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      const firstPipe = rows[index - 1].indexOf("|");
      if (firstPipe < 0) continue;
      const prefix = rows[index - 1].slice(0, firstPipe).trim();
      const header = rows[index - 1].slice(firstPipe + 1).split("|").map((cell) => cell.trim());
      if (header.length !== divider.length || header.some((cell) => !cell || /\\|\uE000/u.test(cell))) continue;
      const output = [`| ${header.join(" | ")} |`, `| ${divider.join(" | ")} |`];
      let last = index;
      for (let row = index + 1; row < rows.length; row += 1) {
        const cells = rows[row].replace(/\|[ \t]*$/u, "").split("|").map((cell) => cell.trim());
        if (cells.length !== header.length || cells.some((cell) => !cell || /\\|\uE000/u.test(cell))) break;
        output.push(`| ${cells.join(" | ")} |`); last = row;
      }
      if (last === index) continue;
      // A single table only; leave any unparsed suffix visible, not reassigned.
      const before = rows.slice(0, index - 1).join("||");
      const after = rows.slice(last + 1).join("||");
      return [before, prefix, output.join("\n"), after].filter(Boolean).join("\n\n");
    }
    return line;
  }).join("\n");
}

// Keep this function identical in frontend/app.js. Clean only presentation:
// evidence, source IDs, citations, and stored OA documents remain unchanged.
export function cleanAnswerPresentation(value, { title = "", document = false } = {}) {
  const protectedText = protectAnswerTechnicalText(value);
  let text = protectedText.text.replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  const legacyLead = /(?:知识库中与这个问题直接相关的内容包括|(?:知识库中|检索到的)(?:与(?:该|这个)问题)?(?:直接)?相关(?:的)?内容(?:包括|如下))\s*[:：]/u;
  const legacy = legacyLead.test(text);
  text = text.replace(new RegExp(`^[ \\t]*${legacyLead.source}[ \\t]*\\n*`, "u"), "");

  // Strip real document front matter, never a normal Markdown horizontal rule.
  text = text.replace(/^\s*---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u, (whole, body) =>
    /^(?:title|version|updated(?:_at)?|date|source|author)\s*:/imu.test(body) ? "" : whole);
  const metaName = "(?:文档版本|资料版本|版本(?:号)?|更新(?:时间|日期)|适用范围|文件名|文档名称|资料名称)";
  const sourceName = "(?:资料来源|文档来源|文件来源|参考来源|出处|引自|摘自|出自|来源)";
  const linePrefix = "^[ \\t]*(?:[-+*•][ \\t]+)?(?:>[ \\t]*)?(?:#{1,6}[ \\t]+)?(?:\\*\\*)?";
  const metaLine = new RegExp(`${linePrefix}${metaName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const sourceLine = new RegExp(`${linePrefix}${sourceName}(?:\\*\\*)?[ \\t]*[:：]`, "u");
  const flattenedMetadata = new RegExp(`>[ \\t]*(?:${metaName}|${sourceName})[ \\t]*[:：]`, "u").test(text);

  const collapsedBlocks = /[^\n][ \t]+#{2,6}[ \t]+\S/u.test(text) ||
    /\|[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|/u.test(text);
  if (legacy || flattenedMetadata || collapsedBlocks) {
    // Older retrieval replies put '- # title > version ... ## section' on one line.
    // Recreate block boundaries before discarding document headers.
    text = text.replace(/^[ \t]*[-+*•][ \t]+(?=#{1,6}[ \t])/gmu, "")
      .replace(/[ \t]+(?=#{1,6}[ \t]+\S)/gu, "\n\n")
      .replace(new RegExp(`[ \\t]*>[ \\t]*(?=(?:${metaName}|${sourceName})[ \\t]*[:：])`, "gu"), "\n")
      .replace(/(#{1,6}[ \t]+[一二三四五六七八九十百\d]+[、.．][^\s#]{1,32})[ \t]+(?=\S)/gu, "$1\n\n");
  }
  text = restoreFlattenedAnswerTables(text);
  // Slides often join a numbered page title to its body after the English
  // page label. Split at that explicit boundary rather than guessing words.
  text = text.replace(/^(#{1,6}[ \t]+第[ \t]*\d+[ \t]*页[^\n()（）]{0,70}[（(][A-Z][A-Z \d-]{2,60}[)）])[ \t]*(?=\S)/gmu, "$1\n\n");
  const lines = text.split("\n");
  const normalizeTitle = (s) => String(s).normalize("NFKC").replace(/\*\*/gu, "")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
  const knownTitle = normalizeTitle(title).split(" · ")[0];
  const metaCount = lines.filter((line) => metaLine.test(line)).length;
  const headerMode = document || legacy || flattenedMetadata || collapsedBlocks || (metaCount >= 2 && lines.some((line) => /^(?:[ \t]*>[ \t]*)?(?:更新时间|更新日期|文档版本|资料版本)[ \t]*[:：]/u.test(line)));
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (sourceLine.test(line)) continue;
    // Only whole metadata lines are suppressed. Restriction notices remain
    // in source data and must never be treated as public-sharing permission.
    if (headerMode && /^[ \t]*(?:>[ \t]*)?(?:页脚|视觉说明)[ \t]*[:：]/u.test(line)) continue;
    if (/^[ \t]*参考(?:公司|实验室)(?:主页|官网)(?:的)?(?:介绍和描述|介绍|描述)[。.]?[ \t]*$/u.test(line)) continue;
    if (headerMode && metaLine.test(line)) continue;
    if (/^[ \t]*(?:[-+*•][ \t]+)?(?:本(?:文|段|回答|内容)|以上内容|上述内容)?(?:引自|摘自|出自)[ \t]*[《“「][^\n]+[》”」][。.]?[ \t]*$/u.test(line)) continue;
    const heading = line.match(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
    if (heading) {
      const matchesTitle = knownTitle && normalizeTitle(heading[1]) === knownTitle;
      const followedByMetadata = /^\s*#[ \t]+/u.test(line) && metaLine.test(lines.slice(index + 1).find((next) => next.trim()) || "");
      if ((document && matchesTitle) || (headerMode && followedByMetadata)) continue;
      // A collapsed page must not turn hundreds of body characters bold.
      if (heading[1].length > 100) line = heading[1];
    }
    // Remove an attribution lead, but keep its actual conclusion and [n] evidence.
    line = line.replace(/^(?:根据|依据|据)[ \t]*《[^》\n]+》(?:中(?:的)?(?:介绍|说明|记载|内容|描述)|(?:记载|介绍|说明|显示|指出))?[ \t]*[，,:：][ \t]*/u, "")
      .replace(/^(?:根据|依据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:知识库|资料|文档)(?:内容)?(?:显示|可知|表明|记载|介绍|说明)?[ \t]*[，,:：][ \t]*/u, "");
    output.push(line.replace(/[ \t]+$/gu, ""));
  }
  return protectedText.restore(output.join("\n").replace(/\n{3,}/gu, "\n\n").trim());
}

// Bound prose without splitting a formula or a code block. Prefer a completed
// paragraph/sentence near the cap; normal short excerpts are never flattened.
export function boundedKnowledgeExcerpt(value, maximum = 1800) {
  const technical = protectAnswerTechnicalText(value);
  const characters = Array.from(technical.text);
  if (characters.length <= maximum) return String(value);
  let prefix = characters.slice(0, maximum).join("");
  const unfinished = prefix.lastIndexOf(technical.prefix);
  if (unfinished >= 0 && !prefix.slice(unfinished).includes("\uE001")) prefix = prefix.slice(0, unfinished);
  const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf("。") + 1, prefix.lastIndexOf("！") + 1, prefix.lastIndexOf("？") + 1);
  if (boundary > maximum / 2) prefix = prefix.slice(0, boundary);
  return `${technical.restore(prefix.trimEnd())}…`;
}
