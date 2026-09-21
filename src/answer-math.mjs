// Kept byte-for-byte in frontend/app.js between SHARED ANSWER TOKENS markers.
// A token is recognized before Markdown escapes, tables, or citation cleanup.
export function answerCodeTokenAt(text, index) {
  const remaining = text.slice(index);
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const fence = /^[ \t]*$/u.test(text.slice(lineStart, index))
    ? remaining.match(/^(`{3,}|~{3,})([^\n]*)\n/u) : null;
  if (fence) {
    const close = new RegExp(`^[ \\t]*${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\n|$)`, "gmu");
    close.lastIndex = index + fence[0].length;
    const end = close.exec(text);
    const stop = end ? end.index + end[0].length - (end[0].endsWith("\n") ? 1 : 0) : text.length;
    return { kind: "code", raw: text.slice(index, stop), end: stop };
  }
  const ticks = remaining.match(/^`+/u)?.[0];
  if (!ticks) return null;
  let end = text.indexOf(ticks, index + ticks.length);
  while (end !== -1 && (text[end - 1] === "`" || text[end + ticks.length] === "`")) {
    end = text.indexOf(ticks, end + ticks.length);
  }
  return end === -1 ? null : {
    kind: "code", raw: text.slice(index, end + ticks.length),
    content: text.slice(index + ticks.length, end), end: end + ticks.length,
  };
}

export function answerMathTokenAt(text, index) {
  let left = "";
  let right = "";
  let display = false;
  let environment = false;
  if (text.startsWith("\\[", index)) { left = "\\["; right = "\\]"; display = true; }
  else if (text.startsWith("\\(", index)) { left = "\\("; right = "\\)"; }
  else if (text.startsWith("$$", index)) { left = right = "$$"; display = true; }
  else if (text[index] === "$" && text[index - 1] !== "$" && text[index + 1] !== "$") { left = right = "$"; }
  else if (text.startsWith("\\begin{", index)) {
    const match = text.slice(index).match(/^\\begin\{((?:equation|align|alignat|aligned|alignedat|gather|gathered|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases)\*?)\}/u);
    if (match) { left = match[0]; right = `\\end{${match[1]}}`; display = environment = true; }
  }
  if (!left) return null;
  const start = index + left.length;
  let end = text.indexOf(right, start);
  while (end !== -1) {
    let slashes = 0;
    for (let cursor = end - 1; cursor >= start && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0 && (right !== "$" || text[end + 1] !== "$")) break;
    end = text.indexOf(right, end + right.length);
  }
  if (end === -1) return null;
  const content = text.slice(start, end);
  // Model answers often emit "$ L = T - V $". Permit padded math without
  // consuming currency prose such as "$5 and $10" or "$ 5 and $ 10".
  const trimmed = content.trim();
  if (left === "$") {
    if (!trimmed || /\r|\n/u.test(content) || /\d/u.test(text[end + 1] || "")) return null;
    const padded = content !== trimmed;
    const looksMathematical = /\\[a-zA-Z]|[_^=+*/<>\-≤≥≠−]/u.test(trimmed) || /^[\p{L}\p{N}.]+$/u.test(trimmed);
    if (padded && !looksMathematical) return null;
  }
  const raw = text.slice(index, end + right.length);
  return { kind: "math", raw, tex: environment ? raw : content, display, end: end + right.length };
}

export function normalizeAnswerMathTex(value) {
  return String(value).replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*?)\\end\{\1\}/gu,
    (original, environment, body) => {
      if (/\\(?:begin|end|text|verb|multicolumn|hline)\b/u.test(body)) return original;
      const lines = body.split("\n");
      const rows = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
      if (rows.length < 2 || rows.length > 50) return original;
      const columns = rows.map(({ line }) => (line.match(/(?<!\\)&/gu) || []).length);
      if (columns[0] < 1 || columns.some((count) => count !== columns[0])) return original;
      const preceding = rows.slice(0, -1);
      if (preceding.some(({ line }) => !/(?<!\\)\\{1,2}[ \t\r]*$/u.test(line))) return original;
      for (const { line, index } of preceding) {
        lines[index] = line.replace(/(?<!\\)\\([ \t\r]*)$/u, (_, spaces) => "\\\\" + spaces);
      }
      return `\\begin{${environment}}${lines.join("\n")}\\end{${environment}}`;
    },
  );
}

export function protectAnswerTechnicalText(value, { code = true } = {}) {
  const input = String(value ?? "");
  let prefix = "\uE000M";
  while (input.includes(prefix)) prefix += "M";
  const originals = [];
  let text = "";
  for (let index = 0; index < input.length;) {
    const token = (input[index] === "`" || input[index] === "~" ? answerCodeTokenAt(input, index) : null) ||
      (input[index] === "\\" || input[index] === "$" ? answerMathTokenAt(input, index) : null);
    if (token?.kind === "code" && !code) {
      text += token.raw; index = token.end;
    } else if (token) {
      text += `${prefix}${originals.length}\uE001`;
      originals.push(token);
      index = token.end;
    } else if (input[index] === "\\" && index + 1 < input.length) {
      text += input.slice(index, index + 2); index += 2;
    } else { text += input[index++]; }
  }
  return {
    text, prefix, tokens: originals,
    restore: (output) => String(output).replace(new RegExp(`${prefix}(\\d+)\uE001`, "gu"),
      (match, index) => originals[Number(index)]?.raw ?? match),
  };
}
