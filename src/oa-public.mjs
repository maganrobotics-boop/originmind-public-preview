import { parseKnowledgeAssets } from "./knowledge-asset-token.mjs";
import { cleanPublicChatText } from "./public-text.mjs";
import {
  OA_PUBLIC_RETRIEVE_URL,
  OA_PUBLIC_SUGGESTIONS_URL,
  OA_PUBLIC_STATUS_URL,
  PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN,
} from "./constants.mjs";

const MAX_QUESTION_LENGTH = 500;
const MAX_RESPONSE_BYTES = 16 * 1024;
// Large public-knowledge searches can legitimately exceed the former 3-second
// cutoff. Keep this below the release preflight's 15-second deadline while
// leaving enough room for production D1 variance.
const TIMEOUT_MS = 8_000;
const RETRIEVAL_CACHE_TTL_MS = 5 * 60_000;
const retrievalCaches = new WeakMap();
function retrievalCache(context) {
  let cache = retrievalCaches.get(context.env);
  if (!cache) { cache = new Map(); retrievalCaches.set(context.env, cache); }
  return cache;
}
// The status probe only needs to exercise authentication, rate limiting, D1,
// and the response contract. A rare single term avoids turning every health
// check into an expensive multi-term ranking query.
const OA_PROBE_QUESTION = "oaretrievalprobe";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const OA_SUGGESTION_LIMIT = 5;

export function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function normalizedQuestion(value) {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return "";
  const clean = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  let end = Math.min(clean.length, MAX_QUESTION_LENGTH);
  if (
    end < clean.length &&
    /[\uD800-\uDBFF]/u.test(clean[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(clean[end])
  ) {
    end -= 1;
  }
  return clean.slice(0, end);
}

function normalizedKnowledgeLabel(value) {
  return cleanPublicChatText(value).normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
}

export function suggestionKnowledgeReference(value) {
  const question = normalizedQuestion(value);
  if (!question || question.length > 300) return null;
  const sectionQuestion = /^《(.{2,100})》中的“(.{2,100})”有哪些值得关注的内容\?$/u.exec(question);
  if (sectionQuestion) return { title: sectionQuestion[1], sectionTitle: sectionQuestion[2] };
  const titleQuestion = /^《(.{2,100})》有哪些值得关注的核心内容\?$/u.exec(question);
  return titleQuestion ? { title: titleQuestion[1], sectionTitle: null } : null;
}

export function suggestionMatchesKnowledge(question, knowledge) {
  const reference = suggestionKnowledgeReference(question);
  if (
    !reference ||
    typeof knowledge?.title !== "string" ||
    normalizedKnowledgeLabel(knowledge.title) !== normalizedKnowledgeLabel(reference.title)
  ) {
    return false;
  }
  return reference.sectionTitle === null || (
    typeof knowledge.sectionTitle === "string" &&
    normalizedKnowledgeLabel(knowledge.sectionTitle) === normalizedKnowledgeLabel(reference.sectionTitle)
  );
}

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("OA_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OA_RESPONSE_EMPTY");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OA_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const value of chunks) {
    all.set(value, offset);
    offset += value.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
}

function stringField(value, { min = 0, max, trim = false, pattern } = {}) {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) throw new Error("OA_RESPONSE_INVALID");
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || (pattern && !pattern.test(result))) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  return result;
}

function exactObject(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OA_RESPONSE_INVALID");
  const keys = Object.keys(value);
  if (keys.length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  return value;
}

function validDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function responseFailureStatus(response) {
  if (response.status === 401 || response.status === 403) return "auth_error";
  if (response.status === 429) return "rate_limited";
  return "unavailable";
}

function requestFailureStatus(error) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  return name === "TimeoutError" || /timeout|timed out/iu.test(message) ? "timeout" : "unavailable";
}

export function parseOaResult(value) {
  const input = exactObject(value, ["chunks"]);
  if (!Array.isArray(input.chunks) || input.chunks.length > 6) throw new Error("OA_RESPONSE_INVALID");
  const items = input.chunks.map((candidate, index) => {
    const item = exactObject(candidate, [
      "id",
      "title",
      "category",
      "sectionTitle",
      "paragraphRef",
      "excerpt",
      "sourceLabel",
      "updatedAt",
      ...(Object.hasOwn(candidate || {}, "assets") ? ["assets"] : []),
    ]);
    const updatedAt = stringField(item.updatedAt, { max: 10, pattern: DATE_PATTERN });
    const parsed = {
      id: stringField(item.id, { max: 1, pattern: /^[1-6]$/u }),
      title: stringField(item.title, { trim: true, min: 2, max: 100 }),
      category: stringField(item.category, { trim: true, min: 1, max: 40 }),
      sectionTitle: stringField(item.sectionTitle, { max: 100 }),
      paragraphRef: stringField(item.paragraphRef, { max: 80 }),
      excerpt: stringField(item.excerpt, { trim: true, min: 1, max: 600 }),
      sourceLabel: stringField(item.sourceLabel, { max: 160 }),
      updatedAt,
      ...(Object.hasOwn(item, "assets") ? { assets: parseKnowledgeAssets(item.assets) } : {}),
    };
    if (!validDate(updatedAt) || parsed.id !== String(index + 1)) throw new Error("OA_RESPONSE_INVALID");
    return parsed;
  });
  if (items.reduce((total, item) => total + item.excerpt.length, 0) > 3_000) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  if (items.reduce((total, item) => total + Object.values(item).reduce((sum, field) => sum + (typeof field === "string" ? field.length : 0), 0), 0) > 4_096) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  if (items.reduce((total, item) => total + (item.assets?.length || 0), 0) > 4) throw new Error("OA_RESPONSE_INVALID");
  return items;
}

export function parseOaSuggestions(value) {
  const input = exactObject(value, ["suggestions"]);
  if (!Array.isArray(input.suggestions) || input.suggestions.length > OA_SUGGESTION_LIMIT) {
    throw new Error("OA_RESPONSE_INVALID");
  }
  const seen = new Set();
  const seenReferences = new Set();
  return input.suggestions.map((candidate, index) => {
    const item = exactObject(candidate, ["id", "question", "updatedAt"]);
    const updatedAt = stringField(item.updatedAt, { max: 10, pattern: DATE_PATTERN });
    const parsed = {
      id: stringField(item.id, { max: 1, pattern: /^[1-5]$/u }),
      question: cleanPublicChatText(stringField(item.question, { trim: true, min: 2, max: 300 })),
      updatedAt,
    };
    const key = parsed.question.normalize("NFKC").toLocaleLowerCase("zh-CN");
    const reference = suggestionKnowledgeReference(parsed.question);
    const referenceKey = reference
      ? `${normalizedKnowledgeLabel(reference.title)}\n${reference.sectionTitle === null ? "" : normalizedKnowledgeLabel(reference.sectionTitle)}`
      : "";
    if (
      parsed.id !== String(index + 1) ||
      !validDate(updatedAt) ||
      seen.has(key) ||
      !referenceKey ||
      seenReferences.has(referenceKey)
    ) {
      throw new Error("OA_RESPONSE_INVALID");
    }
    seen.add(key);
    seenReferences.add(referenceKey);
    return parsed;
  });
}

export async function retrieveOaSuggestions(context) {
  const token = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(token)) {
    return { status: "not_configured", suggestions: [] };
  }
  try {
    const init = {
      method: "GET",
      headers: { "x-originmind-public-lab-ai-service-token": token },
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const service = context.env.OA_SERVICE;
    const response = typeof service?.fetch === "function"
      ? await service.fetch(new Request(OA_PUBLIC_SUGGESTIONS_URL, init))
      : await context.runtime.fetch(OA_PUBLIC_SUGGESTIONS_URL, init);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!response.ok) return { status: responseFailureStatus(response), suggestions: [] };
    if (mediaType !== "application/json") return { status: "invalid_response", suggestions: [] };
    let suggestions;
    try {
      suggestions = parseOaSuggestions(await boundedJson(response));
    } catch {
      return { status: "invalid_response", suggestions: [] };
    }
    return { status: "connected", suggestions };
  } catch (error) {
    return { status: requestFailureStatus(error), suggestions: [] };
  }
}

export async function retrieveOa(question, context, timeoutMs = TIMEOUT_MS, cacheEnabled = true) {
  const token = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  const normalized = normalizedQuestion(question);
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(token)) {
    return { status: "not_configured", documents: [] };
  }
  if (normalized.length < 2) return { status: "invalid_question", documents: [] };
  const cache = retrievalCache(context);
  const cached = cache.get(normalized);
  if (cacheEnabled && cached && Date.now() - cached.storedAt < RETRIEVAL_CACHE_TTL_MS) return cached.value;
  try {
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": token,
      },
      body: JSON.stringify({ question: normalized }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, timeoutMs)),
    };
    const service = context.env.OA_SERVICE;
    const response = typeof service?.fetch === "function"
      ? await service.fetch(new Request(OA_PUBLIC_RETRIEVE_URL, init))
      : await context.runtime.fetch(OA_PUBLIC_RETRIEVE_URL, init);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!response.ok) return { status: responseFailureStatus(response), documents: [] };
    if (mediaType !== "application/json") return { status: "invalid_response", documents: [] };
    let chunks;
    try {
      chunks = parseOaResult(await boundedJson(response));
    } catch {
      return { status: "invalid_response", documents: [] };
    }
    const value = {
      status: "connected",
      documents: chunks.slice(0, 3).map((item) => ({
        id: `oa:${item.id}`,
        title: item.title,
        body: item.excerpt,
        url: "",
        category: item.category,
        updatedAt: item.updatedAt,
        published: 1,
        sectionTitle: item.sectionTitle,
        paragraphRef: item.paragraphRef,
        sourceLabel: item.sourceLabel,
        origin: "oa_public",
        ...(item.assets?.length ? { assets: item.assets } : {}),
      })),
    };
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    if (cacheEnabled) cache.set(normalized, { storedAt: Date.now(), value });
    return value;
  } catch (error) {
    return { status: requestFailureStatus(error), documents: [] };
  }
}

export async function retrieveOaPublicKnowledge(question, context) {
  return (await retrieveOa(question, context)).documents;
}

export async function inspectOaPublicKnowledge(context) {
  const token = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(token)) {
    return { status: "not_configured", documentCount: 0 };
  }
  try {
    const init = {
      method: "GET",
      headers: { "x-originmind-public-lab-ai-service-token": token },
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const service = context.env.OA_SERVICE;
    const response = typeof service?.fetch === "function"
      ? await service.fetch(new Request(OA_PUBLIC_STATUS_URL, init))
      : await context.runtime.fetch(OA_PUBLIC_STATUS_URL, init);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!response.ok) return { status: responseFailureStatus(response), documentCount: 0 };
    if (mediaType !== "application/json") return { status: "invalid_response", documentCount: 0 };
    let value;
    try {
      value = exactObject(await boundedJson(response), ["oaReady", "publicKnowledgeReady", "retrievalReady"]);
    } catch {
      return { status: "invalid_response", documentCount: 0 };
    }
    if (
      value.oaReady !== true ||
      typeof value.publicKnowledgeReady !== "boolean" ||
      typeof value.retrievalReady !== "boolean"
    ) {
      return { status: "unavailable", documentCount: 0 };
    }
    return {
      status: "connected",
      documentCount: value.publicKnowledgeReady ? 1 : 0,
      retrievalReady: value.retrievalReady,
    };
  } catch (error) {
    return { status: requestFailureStatus(error), documentCount: 0 };
  }
}

export async function probeOaPublicKnowledge(context) {
  return (await retrieveOa(OA_PROBE_QUESTION, context)).status;
}
