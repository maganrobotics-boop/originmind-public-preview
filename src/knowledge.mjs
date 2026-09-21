import { PublicError } from "./errors.mjs";

function normalizedKey(value) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

export function displayKnowledgeTitle(item) {
  return [
    item.title,
    item.sectionTitle && normalizedKey(item.sectionTitle) !== normalizedKey(item.title) ? item.sectionTitle : "",
    item.paragraphRef,
    item.sourceLabel ? `来源：${item.sourceLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function fallbackAnswer(documents = []) {
  // Retrieval establishes available evidence, not whether an excerpt answers
  // the user's question. Never present unsynthesized bodies as the answer,
  // including ordinary prose (not only slides), duplicates, tables or formulas.
  // Keep documents and source bindings untouched for diagnostics and grounding.
  if (documents.length) {
    return "这次未能生成完整答复，请重试。为避免答非所问，暂不直接展示检索到的文档片段。";
  }
  return "目前没有足够信息回答这个问题。你可以补充具体方向、对象或时间范围。";
}

export function safeSourceUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError("资料链接须为 http 或 https 地址");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new PublicError("资料链接须为 http 或 https 地址");
  }
  return url.toString();
}

export function aliyunEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError("请输入阿里云百炼 HTTPS 接入地址");
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new PublicError("请输入阿里云百炼 HTTPS 接入地址");
  }
  if (host !== "dashscope.aliyuncs.com" && !/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(host)) {
    throw new PublicError("当前仅支持百炼北京地域");
  }
  if (url.pathname !== "/compatible-mode/v1" && url.pathname !== "/compatible-mode/v1/") {
    throw new PublicError("地址应以 /compatible-mode/v1 结尾");
  }
  return `${url.origin}/compatible-mode/v1`;
}
