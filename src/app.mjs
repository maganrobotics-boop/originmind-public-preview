import { buildGeneralChatMessages, buildGroundedChatMessages, boundedUserMessages } from './grounded-prompt.mjs';
import { handleOaChatBridge } from './oa-chat-bridge.mjs';
import { handleOaAdminBridge } from './oa-admin-bridge.mjs';
import { questionAllowsGeneralKnowledge, questionPrefersGeneralKnowledge, questionRequestsKnowledgeImages } from './question-scope.mjs';
import { chatKnowledgeImages, proxyKnowledgeAsset } from "./knowledge-assets.mjs";
import { protectAnswerTechnicalText } from "./answer-math.mjs";
import { cleanAnswerPresentation } from "./answer-presentation.mjs";
import { completeModelAnswer } from "./answer-completion.mjs";
import { APP_NAME, DEFAULT_MODEL, SECURITY_HEADERS, WORKERS_AI_MODEL } from "./constants.mjs";
import { analyticsReport, recordAnalyticsEvents } from "./analytics.mjs";
import {
  decryptSecret,
  encryptSecret,
  createPasswordRecord,
  randomHex,
  sha256Hex,
  verifyPassword,
} from "./crypto.mjs";
import { cleanPublicChatText } from "./public-text.mjs";
import { PublicError, ValidationError } from "./errors.mjs";
import { conversationHistory, conversationToken, retrievalQuestion } from "./conversation.mjs";
import { naturalizeSuggestions, naturalQuestions, suggestionRetrievalQuestion } from "./natural-suggestions.mjs";
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  extractDocument,
  validateDocumentUpload,
} from "./document-extraction.mjs";
import {
  aliyunEndpoint,
  displayKnowledgeTitle,
  fallbackAnswer,
  safeSourceUrl,
} from "./knowledge.mjs";
import { generateValidatedAnswer } from "./answer-retry.mjs";
import { answerMode } from "./answer-mode.mjs";
import {
  inspectOaPublicKnowledge,
  probeOaPublicKnowledge,
  retrieveOa,
  retrieveOaSuggestions,
  suggestionKnowledgeReference,
  suggestionMatchesKnowledge,
} from "./oa-public.mjs";
import {
  parseChatPayload,
  parseAnalyticsDays,
  parseAnalyticsPayload,
  parseDocumentPayload,
  parseDocumentSubmissionPayload,
  parseInquiryPayload,
  parseInquiryStatusPayload,
  parseLoginPayload,
  parseModelConfigPayload,
} from "./validation.mjs";

const SESSION_COOKIE = "__Host-ma-session";
const SESSION_SECONDS = 43_200;
const STATUS_PROBE_LEASE_MS = 15_000;
const MODEL_STATUS_READY_TTL_MS = 5 * 60_000;
const MODEL_STATUS_RETRY_MS = 30_000;
const OA_STATUS_READY_TTL_MS = 30_000;
const OA_STATUS_RETRY_MS = 5_000;
const SUGGESTIONS_HOURLY_LIMIT = 6_000;
const ANALYTICS_HOURLY_LIMIT = 1_000;
const MODEL_DAILY_LIMIT = 300;
const MODEL_STATUS_PROBE_DAILY_LIMIT = 300;
const MODEL_STATUS_PROBE_BUDGET_MESSAGE = "MODEL_STATUS_PROBE_BUDGET_EXHAUSTED";
const statusProbeFlights = new WeakMap();

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

function chatTimingHeaders(timing) {
  const duration = (value) => Math.max(0, Math.round(value));
  return {
    "Server-Timing": [
      `oa;dur=${duration(timing.oa)}`,
      `model;dur=${duration(timing.model)}`,
      `total;dur=${duration(Date.now() - timing.startedAt)}`,
    ].join(", "),
  };
}

function canonicalOrigin(env) {
  if (typeof env.APP_ORIGIN !== "string") throw new Error("APP_ORIGIN_UNAVAILABLE");
  const url = new URL(env.APP_ORIGIN);
  if (url.protocol !== "https:" || url.origin !== env.APP_ORIGIN) throw new Error("APP_ORIGIN_INVALID");
  return url.origin;
}

function validateEnvironment(env) {
  if (!env?.DB?.prepare) throw new Error("STORAGE_UNAVAILABLE");
  canonicalOrigin(env);
  if (typeof env.ADMIN_EMAIL !== "string" || !env.ADMIN_EMAIL.includes("@")) {
    throw new Error("ADMIN_EMAIL_UNAVAILABLE");
  }
  if (typeof env.APP_ENCRYPTION_KEY !== "string" || env.APP_ENCRYPTION_KEY.length < 40) {
    throw new Error("ENCRYPTION_UNAVAILABLE");
  }
  if (typeof env.RATE_LIMIT_HMAC_KEY !== "string" || env.RATE_LIMIT_HMAC_KEY.length < 32) {
    throw new Error("RATE_LIMIT_KEY_UNAVAILABLE");
  }
}

function clientAddress(request) {
  const value = request.headers.get("CF-Connecting-IP") || "";
  return value.length <= 64 && /^[0-9a-f:.]+$/iu.test(value) ? value : "anonymous";
}

function isReleaseSmokeRequest(request) {
  return (request.headers.get("user-agent") || "").startsWith("OriginMind-Chat-Release-Smoke/");
}

function sessionToken(request) {
  const prefix = `${SESSION_COOKIE}=`;
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) || ""
  );
}

function database(context) {
  return context.env.DB;
}

async function recordAnalyticsBestEffort(context, events) {
  const task = recordAnalyticsEvents(database(context), events).catch(() => {
    console.error("Analytics write failed", { eventCount: events.length });
  });
  if (typeof context.executionContext?.waitUntil === "function") {
    try {
      context.executionContext.waitUntil(task);
      return;
    } catch {
      // Non-Workers test runtimes may expose an incomplete execution context.
    }
  }
  await task;
}

async function ownerEmail(context) {
  const token = sessionToken(context.request);
  if (!/^[a-f0-9]{64}$/u.test(token)) return null;
  const row = await database(context)
    .prepare("SELECT expires FROM sessions WHERE hash=? AND expires>?")
    .bind(await sha256Hex(token), Date.now())
    .first();
  return row ? context.env.ADMIN_EMAIL : null;
}

async function requireOwner(context) {
  const email = await ownerEmail(context);
  if (!email || email.toLowerCase() !== context.env.ADMIN_EMAIL.toLowerCase()) {
    throw new PublicError("仅管理员可执行此操作", 403);
  }
  return { email };
}

function sameOrigin(context) {
  if (context.request.headers.get("origin") !== canonicalOrigin(context.env)) {
    throw new PublicError("请从本站页面提交请求", 403);
  }
}

async function readBytes(request, maximum) {
  if (Number(request.headers.get("content-length") || 0) > maximum) throw new PublicError("内容过长", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError("缺少内容");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new PublicError("内容过长", 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

async function readJson(request, maximum = 120_000) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new PublicError("请求格式错误", 415);
  }
  const all = await readBytes(request, maximum);
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new PublicError("JSON 格式错误");
  }
}

async function hmacHex(secret, value) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hash = await crypto.subtle.sign("HMAC", material, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function consumeCounter(context, key, maximum, expires, message = "操作较频繁，请稍后再试。") {
  const row = await database(context)
    .prepare(
      "INSERT INTO limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    )
    .bind(key, expires)
    .first();
  if (!row || Number(row.count) > maximum) throw new PublicError(message, 429);
}

async function limit(context, bucket, maximum, seconds = 3_600) {
  const now = Math.floor(Date.now() / 1_000);
  const addressHash = await hmacHex(
    context.env.RATE_LIMIT_HMAC_KEY,
    `${bucket}:${clientAddress(context.request)}`,
  );
  const id = `${bucket}:${addressHash}:${Math.floor(now / seconds)}`;
  await consumeCounter(context, id, maximum, now + seconds * 2);
  await database(context).prepare("DELETE FROM limits WHERE expires < ?").bind(now).run();
}

async function globalBudget(context) {
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1_000);
  await consumeCounter(
    context,
    `model-day:${day}`,
    MODEL_DAILY_LIMIT,
    now + 172_800,
    "今日 AI 咨询额度已用完，请稍后再试。",
  );
}

async function modelBudgetReady(context) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await database(context)
    .prepare("SELECT count FROM limits WHERE key = ?")
    .bind(`model-day:${day}`)
    .first();
  return Number(row?.count ?? 0) < MODEL_DAILY_LIMIT;
}

async function consumeModelStatusProbeBudget(context) {
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1_000);
  await consumeCounter(
    context,
    `model-status-day:${day}`,
    MODEL_STATUS_PROBE_DAILY_LIMIT,
    now + 172_800,
    MODEL_STATUS_PROBE_BUDGET_MESSAGE,
  );
}

async function documentExtractionBudget(context) {
  const day = new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1_000);
  await consumeCounter(
    context,
    `document-extract-day:${day}`,
    100,
    now + 172_800,
    "今日文件解析额度已用完，请明天再试。",
  );
}

async function getModelConfig(context) {
  const row = await database(context).prepare("SELECT value FROM settings WHERE id = ?").bind("model").first();
  return row ? JSON.parse(row.value) : null;
}

async function boundedExternalJson(response, maximum = 256 * 1024) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  }
}

function bailianAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.choices)) {
    throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  }
  const message = value.choices[0]?.message;
  const content = message?.content;
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.role !== "assistant" ||
    typeof content !== "string" ||
    !content.trim() ||
    content.length > 12_000
  ) {
    throw new PublicError("模型暂未返回回答，请稍后重试。", 502);
  }
  return content;
}

async function modelCall(context, config, messages, maxTokens = 2_400, timeoutMs = 60_000) {
  const url = `${aliyunEndpoint(config.baseUrl)}/chat/completions`;
  const deadline = Math.min(Date.now() + timeoutMs, context.modelDeadline || Infinity);
  return completeModelAnswer(messages, maxTokens, async (nextMessages) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("MODEL_ANSWER_TIMEOUT");
    const response = await context.runtime.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await decryptSecret(config.encryptedKey, context.env.APP_ENCRYPTION_KEY)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: nextMessages,
        temperature: 0.25,
        max_tokens: maxTokens,
        enable_thinking: false,
        stream: false,
      }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) {
      throw new PublicError(
        response.status === 401
          ? "模型服务认证失败，请联系管理员。"
          : response.status === 429
            ? "模型服务繁忙，请稍后重试。"
            : "模型服务暂时不可用，请稍后重试。",
        502,
      );
    }
    const value = await boundedExternalJson(response);
    return { text: bailianAnswer(value), finishReason: value.choices[0]?.finish_reason };
  }, () => globalBudget(context));
}

function modelProvider(context, config) {
  if (config?.encryptedKey && config?.verifiedAt) {
    return { provider: "bailian", model: config.model };
  }
  if (typeof context.env.AI?.run === "function") {
    return { provider: "workers-ai", model: WORKERS_AI_MODEL };
  }
  return { provider: null, model: null };
}

async function workersAiCall(context, messages, maxTokens = 2_400) {
  if (typeof context.env.AI?.run !== "function") {
    throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
  }
  const deadline = Math.min(Date.now() + 60_000, context.modelDeadline || Infinity);
  return completeModelAnswer(messages, maxTokens, async (nextMessages) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("MODEL_ANSWER_TIMEOUT");
    let result;
    try {
      result = await withTimeout(context.env.AI.run(WORKERS_AI_MODEL, {
        messages: nextMessages,
        temperature: 0.25,
        max_tokens: maxTokens,
        stream: false,
      }), remaining);
    } catch {
      throw new PublicError("模型服务暂时不可用，请稍后重试。", 502);
    }
    const answer =
      (typeof result === "string" ? result : null) ||
      result?.choices?.[0]?.message?.content ||
      result?.response;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new PublicError("模型暂未返回回答，请稍后重试。", 502);
    }
    return { text: answer, finishReason: result?.choices?.[0]?.finish_reason ?? result?.finish_reason };
  }, () => globalBudget(context));
}

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("MODEL_PROBE_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parsedStatusCache(value, identity, validateResult) {
  try {
    const record = JSON.parse(value);
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.version !== 1 ||
      record.identity !== identity ||
      !Number.isSafeInteger(record.checkedAt) ||
      record.checkedAt < 0 ||
      !Number.isSafeInteger(record.leaseUntil) ||
      record.leaseUntil < 0
    ) {
      return null;
    }
    const result = validateResult(record.result);
    return result ? { checkedAt: record.checkedAt, leaseUntil: record.leaseUntil, result } : null;
  } catch {
    return null;
  }
}

async function cachedStatusProbe(
  context,
  { id, identity, fallback, validateResult, ttlForResult },
  probe,
) {
  const read = async () => {
    const row = await database(context).prepare("SELECT value FROM settings WHERE id = ?").bind(id).first();
    return row ? parsedStatusCache(row.value, identity, validateResult) : null;
  };
  const now = Date.now();
  const cached = await read();
  if (cached && now - cached.checkedAt < ttlForResult(cached.result)) return cached.result;

  let databaseFlights = statusProbeFlights.get(context.env.DB);
  if (!databaseFlights) {
    databaseFlights = new Map();
    statusProbeFlights.set(context.env.DB, databaseFlights);
  }
  const flightKey = `${id}:${identity}`;
  if (databaseFlights.has(flightKey)) return databaseFlights.get(flightKey);
  const flight = (async () => {
    const leaseId = randomHex(16);
    const leaseValue = JSON.stringify({
      version: 1,
      identity,
      leaseId,
      checkedAt: cached?.checkedAt ?? 0,
      leaseUntil: now + STATUS_PROBE_LEASE_MS,
      result: cached?.result ?? fallback,
    });
    const acquired = await database(context).prepare(`
      INSERT INTO settings (id,value) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value
      WHERE json_valid(settings.value) = 0
        OR json_extract(
          CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,
          '$.identity'
        ) IS NOT ?
        OR COALESCE(CAST(json_extract(
          CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,
          '$.leaseUntil'
        ) AS INTEGER), 0) <= ?
    `).bind(id, leaseValue, identity, now).run();
    if (!acquired.meta?.changes) {
      const current = await read();
      return current && current.leaseUntil > Date.now()
        ? { ...current.result, probePending: true }
        : current?.result ?? fallback;
    }

    let result = fallback;
    try {
      result = validateResult(await probe()) ?? fallback;
    } catch {
      // Status probes fail closed and never prevent the rest of the status response.
    }
    const finalized = await database(context)
      .prepare("UPDATE settings SET value=? WHERE id=? AND value=?")
      .bind(JSON.stringify({
        version: 1,
        identity,
        leaseId: null,
        checkedAt: Date.now(),
        leaseUntil: 0,
        result,
      }), id, leaseValue)
      .run();
    return finalized.meta?.changes ? result : (await read())?.result ?? fallback;
  })();
  databaseFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    if (databaseFlights.get(flightKey) === flight) databaseFlights.delete(flightKey);
  }
}

function validatedModelStatus(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.ready !== "boolean" ||
    ![null, "bailian", "workers-ai"].includes(value.provider) ||
    !(value.model === null || typeof value.model === "string") ||
    (value.ready && (!value.provider || !value.model || !/qwen/iu.test(value.model))) ||
    (!value.ready && (value.provider !== null || value.model !== null))
  ) {
    return null;
  }
  return { ready: value.ready, provider: value.provider, model: value.model };
}

function validatedOaStatus(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.oaReady !== "boolean" ||
    typeof value.knowledgeReady !== "boolean" ||
    typeof value.retrievalReady !== "boolean"
  ) {
    return null;
  }
  return {
    oaReady: value.oaReady,
    knowledgeReady: value.oaReady && value.knowledgeReady,
    retrievalReady: value.oaReady && value.retrievalReady,
  };
}

async function probeWorkersQwen(context, { budgetConsumed = false } = {}) {
  const prompt = [{ role: "user", content: "请只回复：连接成功" }];
  if (typeof context.env.AI?.run !== "function" || !/qwen/iu.test(WORKERS_AI_MODEL)) {
    return { ready: false, provider: null, model: null };
  }
  try {
    if (!budgetConsumed) await consumeModelStatusProbeBudget(context);
    await withTimeout(workersAiCall(context, prompt, 8), 5_000);
    return { ready: true, provider: "workers-ai", model: WORKERS_AI_MODEL };
  } catch {
    return { ready: false, provider: null, model: null };
  }
}

async function probeQwen(context, active, config) {
  const prompt = [{ role: "user", content: "请只回复：连接成功" }];
  let budgetConsumed = false;
  if (active.provider === "bailian" && /qwen/iu.test(active.model || "")) {
    try {
      await consumeModelStatusProbeBudget(context);
      budgetConsumed = true;
      await modelCall(context, config, prompt, 8, 5_000);
      return { ready: true, provider: "bailian", model: active.model };
    } catch (error) {
      if (error instanceof PublicError && error.message === MODEL_STATUS_PROBE_BUDGET_MESSAGE) throw error;
      // The normal chat path can fall back to Workers AI, so probe it below too.
    }
  }
  return probeWorkersQwen(context, { budgetConsumed });
}

async function modelStatusIdentity(context, config, active) {
  return sha256Hex(JSON.stringify([
    releaseId(context),
    active.provider,
    active.model,
    active.provider === "bailian" ? config?.baseUrl ?? null : null,
    active.provider === "bailian" ? config?.encryptedKey ?? null : null,
    active.provider === "bailian" ? config?.verifiedAt ?? null : null,
    typeof context.env.AI?.run === "function",
  ]));
}

async function recordModelStatus(context, config, active, result) {
  const normalized = validatedModelStatus(result);
  if (!normalized) return;
  const identity = await modelStatusIdentity(context, config, active);
  await database(context)
    .prepare("INSERT INTO settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(`system-status-model-v1:${identity}`, JSON.stringify({
      version: 1,
      identity,
      leaseId: null,
      checkedAt: Date.now(),
      leaseUntil: 0,
      result: normalized,
    }))
    .run();
}

async function oaStatusIdentity(context) {
  return sha256Hex(JSON.stringify([
    releaseId(context),
    "oa-public-status-v2",
    context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || null,
    typeof context.env.OA_SERVICE?.fetch === "function",
  ]));
}

async function currentModelStatus(context, config, active) {
  const identity = await modelStatusIdentity(context, config, active);
  return cachedStatusProbe(
    context,
    {
      id: `system-status-model-v1:${identity}`,
      identity,
      fallback: { ready: false, provider: null, model: null },
      validateResult: validatedModelStatus,
      ttlForResult: (result) => result.ready ? MODEL_STATUS_READY_TTL_MS : MODEL_STATUS_RETRY_MS,
    },
    () => probeQwen(context, active, config),
  );
}

async function currentOaStatus(context) {
  const identity = await oaStatusIdentity(context);
  return cachedStatusProbe(
    context,
    {
      id: `system-status-oa-v2:${identity}`,
      identity,
      fallback: { oaReady: false, knowledgeReady: false, retrievalReady: false },
      validateResult: validatedOaStatus,
      ttlForResult: (result) => result.oaReady && result.knowledgeReady && result.retrievalReady
        ? OA_STATUS_READY_TTL_MS
        : OA_STATUS_RETRY_MS,
    },
    async () => {
      const [result, retrievalStatus] = await Promise.all([
        inspectOaPublicKnowledge(context),
        probeOaPublicKnowledge(context),
      ]);
      const oaReady = result.status === "connected" || retrievalStatus === "connected";
      const knowledgeReady = oaReady && result.documentCount > 0;
      return {
        oaReady,
        knowledgeReady,
        retrievalReady: knowledgeReady && result.retrievalReady === true && retrievalStatus === "connected",
      };
    },
  );
}

async function currentOaSuggestions(context) {
  // Recommendations are approval-sensitive. Every request asks OA directly;
  // no D1 TTL, lease, or in-process single-flight may replay an older set.
  const deadline = Date.now() + 13_000;
  return naturalizeSuggestions(await retrieveOaSuggestions(context), context, deadline);
}

function citationNumber(value) {
  return Number(value.normalize("NFKC"));
}

function safeAiAnswer(answer, sourceCount, original = answer) {
  const citations = [...answer.matchAll(
    /[\[［【]\s*([0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*)\s*[\]］】]/gu,
  )].flatMap((match) => match[1].match(/[0-9０-９]+/gu).map(citationNumber));
  if (!citations.length || citations.some((number) => number < 1 || number > sourceCount)) return false;
  if (/\b(?:https?:\/\/|www\.)\S+/iu.test(original)) return false;
  if (/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu.test(original)) return false;
  if (/(?:^|\D)1[3-9]\d{9}(?:\D|$)/u.test(original)) return false;
  if (/(?:^|\s)\+\d[\d\s()-]{7,}\d(?:\s|$)/u.test(original)) return false;
  return true;
}

function referenceSectionStart(answer) {
  const lineMarkers = [
    answer.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：]|(?=[\[［【]\s*[0-9０-９]))/imu,
    ),
    answer.match(
      /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：])?[ \t]*$/imu,
    ),
    answer.match(
      /(?:^|\r?\n)[ \t]*(?:[-+*•>][ \t]+)?[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/u,
    ),
  ].filter(Boolean);
  const inlineMarker = answer.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu,
  );
  const inlineCitationMarker = answer.match(
    /(^|[^\p{L}\p{N}_*`#~-])(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited)[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?=[\[［【]\s*[0-9０-９])/iu,
  );
  const indexes = lineMarkers.map((marker) => marker.index);
  if (inlineMarker) indexes.push(inlineMarker.index + inlineMarker[1].length);
  if (inlineCitationMarker) indexes.push(inlineCitationMarker.index + inlineCitationMarker[1].length);
  return indexes.length ? Math.min(...indexes) : -1;
}

function visibleAiAnswer(answer, sourceCount) {
  const technical = protectAnswerTechnicalText(cleanAnswerPresentation(answer));
  answer = technical.text;
  const sectionStart = referenceSectionStart(answer);
  const answerBody = (sectionStart === -1 ? answer : answer.slice(0, sectionStart)).trimEnd();
  if (/\[\s*\[\s*[0-9０-９][\s\S]*?\]\s*\]/u.test(answerBody)) return null;
  if (!safeAiAnswer(answerBody, sourceCount, technical.restore(answerBody))) return null;
  const visible = answerBody
    .replace(/[ \t]*[\[［【]\s*[0-9０-９]+(?:\s*[,，、;；\-–—]\s*[0-9０-９]+)*\s*[\]］】]/gu, "")
    .replace(
      /^(?:(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料(?:显示|可知|表明)|参考资料(?:显示|表明|提到)|(?:根据|据)(?:现有|上述|相关|公开|所提供的|提供的)?(?:参考)?资料)[，,:：]\s*/u,
      "",
    )
    .replace(/[ \t]+([，。！？；：、])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const hasResidualMarker =
    /[\[［【][^\]］】\r\n]*[0-9０-９]+[^\]］】\r\n]*[\]］】]/u.test(visible) ||
    /(?:参考资料|参考文献|参考来源|资料来源)/u.test(visible) ||
    /(?:^|[^\p{L}\p{N}_*`#~-])(?:参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu.test(visible) ||
    /(?:^|[^\p{L}\p{N}_-])(?:references?|sources?|citations?|bibliography|works[ \t]+cited)(?:[ \t]+list)?[ \t]*[:：]/iu.test(visible) ||
    referenceSectionStart(visible) !== -1;
  return visible && !hasResidualMarker ? technical.restore(visible) : null;
}

function modelConfigView(context, config) {
  return {
    baseUrl: config?.baseUrl || "",
    model: config?.model || DEFAULT_MODEL,
    keyConfigured: Boolean(config?.encryptedKey),
    encryptionReady: context.env.APP_ENCRYPTION_KEY.length >= 40,
    activeProvider: modelProvider(context, config).provider,
    workersAiReady: typeof context.env.AI?.run === "function",
    verifiedAt: config?.verifiedAt || null,
  };
}

async function saveModelConfig(context, payload) {
  const parsed = parseModelConfigPayload(payload);
  const baseUrl = aliyunEndpoint(parsed.baseUrl);
  const previous = await getModelConfig(context);
  if (!parsed.apiKey?.trim() && !previous?.encryptedKey) throw new PublicError("请先填写百炼 API Key");
  const value = {
    baseUrl,
    model: parsed.model,
    encryptedKey: parsed.apiKey?.trim()
      ? await encryptSecret(parsed.apiKey.trim(), context.env.APP_ENCRYPTION_KEY)
      : previous.encryptedKey,
  };
  // Verify the candidate before replacing the last working configuration.
  await modelCall(context, value, [{ role: "user", content: "请只回复：连接成功" }], 20);
  value.verifiedAt = new Date().toISOString();
  await database(context)
    .prepare("INSERT INTO settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind("model", JSON.stringify(value))
    .run();
  try {
    await recordModelStatus(context, value, modelProvider(context, value), {
      ready: true, provider: "bailian", model: value.model,
    });
  } catch {
    // Saving a verified configuration must not depend on status-cache writes.
  }
  return { saved: true, connected: true, activeProvider: "bailian", verifiedAt: value.verifiedAt };
}

async function testModelConfig(context) {
  const config = await getModelConfig(context);
  if (!config) throw new PublicError("请先保存模型配置");
  const active = modelProvider(context, config);
  try {
    await modelCall(context, config, [{ role: "user", content: "请只回复：连接成功" }], 20);
  } catch (error) {
    try { await recordModelStatus(context, config, active, await probeWorkersQwen(context)); }
    catch { /* Preserve the model-test error if status recording is unavailable. */ }
    throw error;
  }
  const verifiedConfig = { ...config, verifiedAt: new Date().toISOString() };
  const result = await database(context)
    .prepare("UPDATE settings SET value=? WHERE id=? AND value=?")
    .bind(JSON.stringify(verifiedConfig), "model", JSON.stringify(config))
    .run();
  if (!result.meta.changes) throw new PublicError("配置已发生变化，请刷新后重新检测。", 409);
  try {
    await recordModelStatus(context, verifiedConfig, modelProvider(context, verifiedConfig), {
      ready: true, provider: "bailian", model: verifiedConfig.model,
    });
  } catch {
    // A verified configuration remains valid even if status recording fails.
  }
  return { connected: true, verifiedAt: verifiedConfig.verifiedAt };
}

async function hasAdminSession(context, token) {
  if (!/^[a-f0-9]{64}$/u.test(token || "")) return false;
  return Boolean(await database(context).prepare("SELECT 1 AS present FROM sessions WHERE hash=? AND expires>?")
    .bind(await sha256Hex(token), Date.now()).first());
}

async function createAdminSession(context) {
  const token = randomHex(32);
  const now = Date.now();
  await database(context).prepare("DELETE FROM sessions WHERE expires<=?").bind(now).run();
  await database(context).prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), now + SESSION_SECONDS * 1_000).run();
  return token;
}

async function requireAdminSession(context, token) {
  if (!await hasAdminSession(context, token)) throw new PublicError("管理会话已失效，请重新输入管理员密码。", 401);
}

async function handleOaAdminOperation(context, payload) {
  if (payload.operation === "status") {
    const account = await database(context).prepare("SELECT 1 AS present FROM admin_account WHERE id=1").first();
    const signedIn = payload.sessionToken ? await hasAdminSession(context, payload.sessionToken) : false;
    return {
      initialized: Boolean(account), signedIn,
      ...(signedIn ? modelConfigView(context, await getModelConfig(context)) : {}),
    };
  }
  if (payload.operation === "set_password") {
    const record = await createPasswordRecord(payload.password);
    const token = randomHex(32); const now = Date.now();
    await database(context).batch([
      database(context).prepare(`INSERT INTO admin_account(id,algorithm,iterations,salt,hash) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET algorithm=excluded.algorithm,iterations=excluded.iterations,salt=excluded.salt,hash=excluded.hash`)
        .bind(record.algorithm, record.iterations, record.salt, record.hash),
      database(context).prepare("DELETE FROM sessions"),
      database(context).prepare("INSERT INTO sessions(hash,expires) VALUES (?,?)")
        .bind(await sha256Hex(token), now + SESSION_SECONDS * 1_000),
    ]);
    console.info("OA_ADMIN_PASSWORD_UPDATED", { actorHash: (await sha256Hex(payload.actor)).slice(0, 16) });
    return { initialized: true, signedIn: true, sessionToken: token, ...modelConfigView(context, await getModelConfig(context)) };
  }
  if (payload.operation === "login") {
    const now = Date.now();
    await consumeCounter(context, `oa-admin-login:${Math.floor(now / 900_000)}`, 30, Math.floor(now / 1000) + 1800);
    const account = await database(context).prepare("SELECT algorithm,iterations,salt,hash FROM admin_account WHERE id=1").first();
    if (!account) throw new PublicError("管理员密码尚未设置。", 409);
    if (!await verifyPassword(payload.password, account)) throw new PublicError("密码不正确。", 401);
    const token = await createAdminSession(context);
    return { initialized: true, signedIn: true, sessionToken: token, ...modelConfigView(context, await getModelConfig(context)) };
  }
  if (payload.operation === "logout") {
    await database(context).prepare("DELETE FROM sessions WHERE hash=?").bind(await sha256Hex(payload.sessionToken)).run();
    return { initialized: true, signedIn: false };
  }
  await requireAdminSession(context, payload.sessionToken);
  if (payload.operation === "config_get") return modelConfigView(context, await getModelConfig(context));
  if (payload.operation === "config_save") {
    await consumeCounter(context, "oa-admin-config", 20, Math.floor(Date.now() / 1000) + 3600);
    return { ...await saveModelConfig(context, { baseUrl: payload.baseUrl, model: payload.model, ...(payload.apiKey === undefined ? {} : { apiKey: payload.apiKey }) }), ...modelConfigView(context, await getModelConfig(context)) };
  }
  if (payload.operation === "test") {
    await consumeCounter(context, "oa-admin-test", 20, Math.floor(Date.now() / 1000) + 3600);
    return { ...await testModelConfig(context), ...modelConfigView(context, await getModelConfig(context)) };
  }
  throw new PublicError("请求内容不正确", 400);
}

function visibleGeneralAnswer(answer) {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 12_000 || !answer.isWellFormed()) return null;
  const visible = cleanAnswerPresentation(answer).trim();
  if (!visible || /\b(?:https?:\/\/|www\.)\S+/iu.test(visible)) return null;
  if (/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu.test(visible)) return null;
  if (/(?:^|\D)1[3-9]\d{9}(?:\D|$)/u.test(visible)) return null;
  return visible;
}

async function localDrafts(context) {
  const result = await database(context)
    .prepare(
      "SELECT id,title,body,url,category,updated_at AS updatedAt,published,oa_submission_state AS oaSubmissionState,oa_item_id AS oaItemId,oa_submitted_at AS oaSubmittedAt,draft_revision AS draftRevision FROM documents ORDER BY updated_at DESC",
    )
    .all();
  return (result.results || []).map((document) => ({ ...document, origin: "chat_draft" }));
}

async function localDraftSubmissionState(context, id) {
  return database(context)
    .prepare(
      "SELECT id,oa_submission_state AS oaSubmissionState,oa_item_id AS oaItemId,oa_submitted_at AS oaSubmittedAt,draft_revision AS draftRevision FROM documents WHERE id=?",
    )
    .bind(id)
    .first();
}

function releaseId(context) {
  return typeof context.env.RELEASE_ID === "string" && context.env.RELEASE_ID.length <= 128
    ? context.env.RELEASE_ID
    : "development";
}

async function auth(context) {
  const { request } = context;
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/status" && request.method === "GET") {
    return json({ signedIn: Boolean(await ownerEmail(context)) });
  }
  if (request.method !== "POST") return json({ error: "没有找到此接口" }, 404);
  sameOrigin(context);
  if (path === "/api/auth/logout") {
    const token = sessionToken(request);
    if (/^[a-f0-9]{64}$/u.test(token)) {
      await database(context).prepare("DELETE FROM sessions WHERE hash=?").bind(await sha256Hex(token)).run();
    }
    return json(
      { saved: true },
      200,
      { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` },
    );
  }
  if (path !== "/api/auth/login") return json({ error: "没有找到此接口" }, 404);

  await limit(context, "login", 10, 900);
  const now = Date.now();
  await consumeCounter(
    context,
    `login-global:${Math.floor(now / 900_000)}`,
    60,
    Math.floor(now / 1_000) + 1_800,
  );
  const { password } = parseLoginPayload(await readJson(request, 2_000));
  const account = await database(context)
    .prepare("SELECT algorithm,iterations,salt,hash FROM admin_account WHERE id=1")
    .first();
  if (!account) throw new PublicError("管理员账号尚未设置", 503);
  if (!(await verifyPassword(password, account))) throw new PublicError("密码不正确", 401);

  const token = randomHex(32);
  await database(context).prepare("DELETE FROM sessions WHERE expires<=?").bind(now).run();
  await database(context)
    .prepare("INSERT INTO sessions (hash,expires) VALUES (?,?)")
    .bind(await sha256Hex(token), now + SESSION_SECONDS * 1_000)
    .run();
  return json(
    { signedIn: true },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
    },
  );
}

async function api(context) {
  const { request } = context;
  const path = new URL(request.url).pathname.replace(/^\/api\//u, "");
  const method = request.method;
  const chatTiming = path === "chat" && method === "POST"
    ? { startedAt: Date.now(), oa: 0, model: 0 }
    : null;
  try {
    if (path === "internal/oa-admin") return handleOaAdminBridge(context, {
      claimRequest: async (nonce) => {
        await consumeCounter(context, `oa-admin-bridge:${nonce}`, 1, Math.floor(Date.now() / 1000) + 120);
        await database(context).prepare("DELETE FROM limits WHERE expires < ?").bind(Math.floor(Date.now() / 1000)).run();
      },
      handle: (payload) => handleOaAdminOperation(context, payload),
    });
    if (path === "internal/oa-answer") return handleOaChatBridge(context, {
      getModelConfig, modelProvider, currentModelStatus, modelBudgetReady,
      globalBudget, modelCall, workersAiCall, visibleAiAnswer, visibleGeneralAnswer,
      claimRequest: async (nonce) => {
        await consumeCounter(context, `oa-chat-bridge:${nonce}`, 1, Math.floor(Date.now() / 1000) + 120);
        await database(context).prepare("DELETE FROM limits WHERE expires < ?").bind(Math.floor(Date.now() / 1000)).run();
      },
    });
    if (method === "POST" || method === "PATCH") sameOrigin(context);
    if (path === "shares" && method === "POST") {
      await limit(context, "share", 20, 3600);
      const input = await readJson(request, 32_000);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["question", "answer"].includes(key))
        || typeof input.question !== "string" || input.question.length > 2_000
        || typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 12_000) throw new PublicError("分享内容不正确", 400);
      const id = randomHex(8), now = Date.now(), expires = now + 30 * 24 * 60 * 60 * 1000;
      await database(context).prepare("DELETE FROM answer_shares WHERE expires_at<?").bind(now).run();
      await database(context).prepare("INSERT INTO answer_shares(id,question,answer,created_at,expires_at) VALUES(?,?,?,?,?)")
        .bind(id, input.question, input.answer, now, expires).run();
      return json({ id, expiresAt: new Date(expires).toISOString() }, 201);
    }
    if (path.startsWith("shares/") && method === "GET") {
      await limit(context, "share-read", 120, 3600);
      const id = path.slice("shares/".length);
      if (!/^[a-f0-9]{16}$/u.test(id)) throw new PublicError("分享链接不正确", 400);
      const row = await database(context).prepare("SELECT question,answer,expires_at AS expiresAt FROM answer_shares WHERE id=? AND expires_at>=?").bind(id, Date.now()).first();
      if (!row) throw new PublicError("分享链接不存在或已过期", 404);
      return json({ v: 1, question: row.question, answer: row.answer, expiresAt: new Date(row.expiresAt).toISOString() });
    }
    if (path.startsWith("knowledge/assets/") && method === "GET") {
      await limit(context, "knowledge-image", 600);
      return await proxyKnowledgeAsset(context, path.slice("knowledge/assets/".length));
    }
    if (path === "status" && method === "GET") {
      try {
        if (new URL(request.url).search) throw new PublicError("请求格式错误", 400);
        await limit(context, "status", 600);
        const config = await getModelConfig(context);
        const active = modelProvider(context, config);
        const [model, oa, budgetReady] = await Promise.all([
          currentModelStatus(context, config, active),
          currentOaStatus(context),
          modelBudgetReady(context),
        ]);
        const modelPending = model.probePending === true;
        const oaPending = oa.probePending === true;
        const modelReady = !modelPending && model.ready;
        const qwenReady = modelReady && typeof model.model === "string" && /qwen/iu.test(model.model);
        const oaReady = !oaPending && oa.oaReady;
        const knowledgeReady = !oaPending && oa.knowledgeReady;
        const retrievalReady = !oaPending && oa.retrievalReady;
        return json({
          storageReady: true,
          modelReady,
          qwenReady,
          modelPending,
          oaReady,
          knowledgeReady,
          retrievalReady,
          oaPending,
          budgetReady,
          systemReady: modelReady && qwenReady && oaReady && knowledgeReady && retrievalReady && budgetReady,
          documentParsingReady: typeof context.env.AI?.toMarkdown === "function",
          provider: modelPending ? null : model.provider,
          model: modelPending ? null : model.model,
        });
      } catch (error) {
        if (error instanceof PublicError) throw error;
        return json({
          storageReady: false,
          modelReady: false,
          qwenReady: false,
          modelPending: false,
          oaReady: false,
          knowledgeReady: false,
          retrievalReady: false,
          oaPending: false,
          budgetReady: false,
          systemReady: false,
          documentParsingReady: false,
          provider: null,
          model: null,
        }, 503);
      }
    }
    if (path === "suggestions" && method === "GET") {
      if (new URL(request.url).search) throw new PublicError("请求格式错误", 400);
      await limit(context, "suggestions", SUGGESTIONS_HOURLY_LIMIT);
      let result;
      try {
        result = await currentOaSuggestions(context);
      } catch {
        result = { status: "unavailable", suggestions: [] };
      }
      const recommendationsReady = result.status === "connected";
      return json({
        suggestions: recommendationsReady ? result.suggestions : [],
        oaPublicStatus: recommendationsReady ? "connected" : "unavailable",
      });
    }
    if (path === "analytics" && method === "POST") {
      await limit(context, "analytics", ANALYTICS_HOURLY_LIMIT);
      const payload = parseAnalyticsPayload(await readJson(request, 4_000));
      await recordAnalyticsBestEffort(context, payload.events);
      return json({ accepted: true }, 202);
    }
    if (path.startsWith("admin/")) await requireOwner(context);
    if (path === "chat" && method === "POST") {
      const payload = parseChatPayload(await readJson(request, 80_000));
      const last = payload.messages.at(-1);
      if (last.role !== "user" || last.content.length > 2_000) throw new PublicError("请输入有效的问题");
      await limit(context, "chat", 25);
      const history = await conversationHistory(payload, context.env.APP_ENCRYPTION_KEY);
      const sourceQuestion = payload.suggestionToken
        ? await suggestionRetrievalQuestion(payload.suggestionToken, last.content, context.env.APP_ENCRYPTION_KEY)
        : null;
      if (payload.suggestionToken && !sourceQuestion) throw new PublicError("推荐问题已更新，请重新选择。", 400);
      const analyticsSection = payload.analyticsSection || "general";
      const analyticsSource = payload.suggestionToken ? "suggestion" : "typed";
      if (!isReleaseSmokeRequest(request)) {
        await recordAnalyticsBestEffort(context, [{
          type: "chat_submit",
          section: analyticsSection,
          source: analyticsSource,
        }]);
      }
      const retrievalHistory = history.length ? history : boundedUserMessages(payload.messages.slice(0, -1));
      const oaStartedAt = Date.now();
      let oa;
      try {
        oa = await retrieveOa(sourceQuestion || retrievalQuestion(last.content, retrievalHistory), context, undefined, !sourceQuestion);
      } finally {
        chatTiming.oa = Date.now() - oaStartedAt;
      }
      const chatResult = async (result) => {
        result = {
          ...result,
          ...(result.mode !== "general" && oa.documents.length ? { images: chatKnowledgeImages(documents, last.content) } : {}),
          answer: cleanAnswerPresentation(cleanPublicChatText(result.answer)) || fallbackAnswer([]),
          sources: result.sources.map((source) => ({
            ...source,
            title: cleanPublicChatText(source.title),
            excerpt: cleanPublicChatText(source.excerpt),
          })),
        };
        const token = await conversationToken(
          payload.topic,
          history,
          last.content,
          result.answer,
          context.env.APP_ENCRYPTION_KEY,
        );
        if (!isReleaseSmokeRequest(request)) {
          await recordAnalyticsBestEffort(context, [{
            type: "chat_success",
            section: analyticsSection,
            source: analyticsSource,
          }]);
        }
        return json({
          ...result,
          conversationToken: token,
        }, 200, chatTimingHeaders(chatTiming));
      };
      const suggestionReference = suggestionKnowledgeReference(sourceQuestion || last.content);
      const sourceDocuments = oa.documents.filter((document) => (
        !suggestionReference || suggestionMatchesKnowledge(sourceQuestion || last.content, document)
      ));
      const applicableDocuments = sourceQuestion && !naturalQuestions(sourceDocuments).includes(last.content)
        ? [] : sourceDocuments;
      const documents = applicableDocuments.map((document) => ({
        ...document,
        title: displayKnowledgeTitle(document),
      }));
      const knowledgeImages = chatKnowledgeImages(documents, last.content);
      const sources = documents.map((document) => ({
        id: document.id,
        title: document.title,
        url: document.url,
        excerpt: document.body.slice(0, 3_500),
        updatedAt: document.updatedAt,
        origin: document.origin,
      }));
      if (questionRequestsKnowledgeImages(last.content) && knowledgeImages.length) {
        return chatResult({
          answer: `已找到 ${knowledgeImages.length} 张与问题相关的已审核资料图片，显示如下。`,
          sources,
          images: knowledgeImages,
          mode: "ai",
          oaPublicStatus: oa.status,
          releaseId: releaseId(context),
        });
      }
      if (questionRequestsKnowledgeImages(last.content)) {
        return chatResult({
          answer: documents.length
            ? "已找到相关文字资料，但当前公开审核版本没有可展示的图片。请由管理员补充并审核图片后再试。"
            : "目前公开知识库没有找到与该问题相关的已审核图片。",
          sources,
          images: [],
          mode: "retrieval",
          fallbackReason: "no_images",
          oaPublicStatus: oa.status,
          releaseId: releaseId(context),
        });
      }
      const config = await getModelConfig(context);
      const active = modelProvider(context, config);
      const questionScope = [...retrievalHistory.map(message => message.content), last.content].join(' ');
      const generalKnowledge = !sourceQuestion && (documents.length
        ? questionPrefersGeneralKnowledge(last.content)
        : questionAllowsGeneralKnowledge(questionScope));
      if ((!documents.length && !generalKnowledge) || !active.provider) {
        return chatResult({
          answer: fallbackAnswer(documents),
          sources,
          mode: "retrieval",
          fallbackReason: documents.length ? "model_unavailable" : "no_documents",
          oaPublicStatus: oa.status,
          releaseId: releaseId(context),
        });
      }
      await globalBudget(context);
      const messages = generalKnowledge
        ? buildGeneralChatMessages({ question: last.content, messages: payload.messages })
        : buildGroundedChatMessages({ documents, history, question: last.content, messages: payload.messages });
      const selectedMode = answerMode(last.content);
      context.modelDeadline = Date.now() + (selectedMode === 'deep' ? 75_000 : 45_000);
      let provider = active.provider;
      const modelStartedAt = Date.now();
      const generated = await generateValidatedAnswer({
        messages,
        retryInstruction: generalKnowledge ? undefined : "\n\n上一次生成结果未能通过完整性或资料引用校验。请重新独立作答：只输出完整正文；每个资料事实后紧跟有效的 [编号]；至少使用一个有效编号；不要输出参考资料列表、网址、联系方式、HTML 或未完成的句子。",
        generate: async (attemptMessages) => {
          try {
          if (selectedMode === 'deep' && typeof context.env.AI?.run === "function") {
            provider = "workers-ai";
            return await workersAiCall(context, attemptMessages, 2_400);
          }
          if (active.provider === "bailian") {
            try {
              return await modelCall(context, config, attemptMessages);
            } catch (error) {
              if (typeof context.env.AI?.run !== "function") throw error;
              provider = "workers-ai";
              return await workersAiCall(context, attemptMessages);
            }
            }
            return await workersAiCall(context, attemptMessages);
          } finally {
            chatTiming.model = Date.now() - modelStartedAt;
          }
        },
        validate: (answer) => generalKnowledge ? visibleGeneralAnswer(answer) : visibleAiAnswer(answer, sources.length),
      });
      if (generated.visible) {
        try {
          await recordModelStatus(context, config, active, {
            ready: true,
            provider,
            model: provider === "bailian" ? config.model : WORKERS_AI_MODEL,
          });
        } catch {
          // Status evidence is best effort and must not discard a valid answer.
        }
      } else if (generated.failureReason === "generation_failed") {
        try {
          await recordModelStatus(context, config, active, { ready: false, provider: null, model: null });
        } catch {
          // The approved-knowledge fallback must not depend on status-cache writes.
        }
        return chatResult({
          answer: fallbackAnswer(documents),
          sources,
          mode: "retrieval",
          fallbackReason: generated.failureReason,
          oaPublicStatus: oa.status,
          releaseId: releaseId(context),
        });
      }
      if (!generated.visible) {
        return chatResult({
          answer: fallbackAnswer(documents),
          sources,
          mode: "retrieval",
          fallbackReason: generated.failureReason,
          oaPublicStatus: oa.status,
          releaseId: releaseId(context),
        });
      }
      return chatResult({
        answer: generalKnowledge ? `**来源类型：模型通用知识（未引用公开知识库资料）**\n\n${generated.visible}` : generated.visible,
        sources: generalKnowledge ? [] : sources,
        mode: generalKnowledge ? "general" : "ai",
        provider,
        answerMode: selectedMode,
        oaPublicStatus: oa.status,
        releaseId: releaseId(context),
      });
    }
    if (path === "inquiries" && method === "POST") {
      const payload = parseInquiryPayload(await readJson(request, 150_000));
      if (!payload.includeConversation && payload.transcript.length) {
        throw new PublicError("未同意附带对话");
      }
      const existing = await database(context)
        .prepare("SELECT reference FROM inquiries WHERE request_id = ?")
        .bind(payload.requestId)
        .first();
      if (existing) return json({ reference: existing.reference });
      await limit(context, "inquiry", 5);
      const id = crypto.randomUUID();
      const reference = `OM-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
      await database(context)
        .prepare(
          "INSERT INTO inquiries (id,reference,request_id,name,organisation,contact,topic,summary,transcript,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(request_id) DO NOTHING",
        )
        .bind(
          id,
          reference,
          payload.requestId,
          payload.name,
          payload.organisation,
          payload.contact,
          payload.topic,
          payload.summary,
          JSON.stringify(payload.transcript),
          new Date().toISOString(),
        )
        .run();
      const stored = await database(context)
        .prepare("SELECT reference FROM inquiries WHERE request_id = ?")
        .bind(payload.requestId)
        .first();
      return json({ reference: stored.reference }, 201);
    }
    if (path === "admin/analytics" && method === "GET") {
      const days = parseAnalyticsDays(new URL(request.url).searchParams);
      return json(await analyticsReport(database(context), days));
    }
    if (path === "admin/config" && method === "GET") {
      return json(modelConfigView(context, await getModelConfig(context)));
    }
    if (path === "admin/config" && method === "POST") {
      await limit(context, "test", 10);
      return json(await saveModelConfig(context, await readJson(request, 2_500)));
    }
    if (path === "admin/test" && method === "POST") {
      await limit(context, "test", 10);
      return json(await testModelConfig(context));
    }
    if (path === "admin/oa-test" && method === "POST") {
      return json({ oaPublicKnowledge: await probeOaPublicKnowledge(context) });
    }
    if (path === "admin/extract" && method === "POST") {
      // The endpoint remains single-file and memory-bounded. The higher authenticated
      // request allowance lets the admin UI process one safe batch as small parallel uploads.
      await limit(context, "document-extract", 100);
      const encodedName = context.request.headers.get("x-file-name") || "";
      if (!encodedName || encodedName.length > 2_000) throw new PublicError("缺少有效文件名");
      let name;
      try {
        name = decodeURIComponent(encodedName);
      } catch {
        throw new PublicError("文件名不正确，请重新选择文件。");
      }
      const bytes = await readBytes(context.request, MAX_DOCUMENT_UPLOAD_BYTES);
      const upload = validateDocumentUpload(name, context.request.headers.get("content-type"), bytes);
      await documentExtractionBudget(context);
      const extracted = await extractDocument(context.env.AI, upload, bytes);
      return json({
        text: extracted.text,
        fileName: upload.name,
        mimeType: upload.mimeType,
        characters: extracted.text.length,
        tokens: extracted.tokens,
        originalStored: false,
      });
    }
    if (path === "admin/documents" && method === "GET") {
      return json({ documents: await localDrafts(context) });
    }
    if (path === "admin/documents" && method === "POST") {
      const payload = parseDocumentPayload(await readJson(request, 125_000));
      if (payload.published !== 0) {
        throw new PublicError("公开资料须通过 OA 审核后发布");
      }
      const id = payload.id || crypto.randomUUID();
      const url = safeSourceUrl(payload.url);
      if (!payload.id) {
        const created = await database(context)
          .prepare(
            "INSERT INTO documents (id,title,body,url,category,updated_at,published,oa_submission_state,draft_revision) SELECT ?,?,?,?,?,?,?,'unsubmitted',1 WHERE (SELECT COUNT(*) FROM documents) < 200",
          )
          .bind(id, payload.title, payload.body, url, payload.category, payload.updatedAt, 0)
          .run();
        if (!created.meta?.changes) {
          throw new PublicError("资料数量已达到当前上限，请整理现有资料后再添加");
        }
        return json({ saved: true, id, draftRevision: 1, oaSubmissionState: "unsubmitted" });
      }
      if (!payload.draftRevision) throw new PublicError("资料版本已变化，请刷新后重试。", 409);
      const updated = await database(context)
        .prepare(
          "UPDATE documents SET title=?,body=?,url=?,category=?,updated_at=?,published=0,draft_revision=draft_revision+1 WHERE id=? AND draft_revision=? AND oa_submission_state='unsubmitted'",
        )
        .bind(payload.title, payload.body, url, payload.category, payload.updatedAt, id, payload.draftRevision)
        .run();
      if (!updated.meta?.changes) {
        const current = await localDraftSubmissionState(context, id);
        if (!current) throw new PublicError("资料不存在", 404);
        if (current.oaSubmissionState === "submitted") throw new PublicError("资料已提交 OA，待审核期间不能在 Chat 修改。", 409);
        if (current.oaSubmissionState === "unknown") throw new PublicError("请先登录 OA 核对该资料的提交状态。", 409);
        throw new PublicError("资料版本已变化，请刷新后重试。", 409);
      }
      return json({ saved: true, id, draftRevision: payload.draftRevision + 1, oaSubmissionState: "unsubmitted" });
    }
    if (path === "admin/documents" && method === "PATCH") {
      const payload = parseDocumentSubmissionPayload(await readJson(request, 2_000));
      let current = await localDraftSubmissionState(context, payload.id);
      if (!current) throw new PublicError("资料不存在", 404);
      if (Number(current.draftRevision) !== payload.draftRevision) {
        throw new PublicError("资料版本已变化，请刷新后重试。", 409);
      }
      if (payload.submissionState === "unknown") {
        if (current.oaSubmissionState === "unsubmitted") {
          await database(context)
            .prepare("UPDATE documents SET oa_submission_state='unknown',oa_item_id=NULL,oa_submitted_at=NULL WHERE id=? AND draft_revision=? AND oa_submission_state='unsubmitted'")
            .bind(payload.id, payload.draftRevision)
            .run();
          current = await localDraftSubmissionState(context, payload.id);
          if (!current) throw new PublicError("资料不存在", 404);
          if (Number(current.draftRevision) !== payload.draftRevision) {
            throw new PublicError("资料版本已变化，请刷新后重试。", 409);
          }
          if (!["unknown", "submitted"].includes(current.oaSubmissionState)) {
            throw new PublicError("资料状态已变化，请刷新后重试。", 409);
          }
        }
      } else if (payload.submissionState === "unsubmitted") {
        if (current.oaSubmissionState === "submitted") {
          throw new PublicError("已提交资料不能改回未提交状态。", 409);
        }
        if (current.oaSubmissionState === "unknown") {
          await database(context)
            .prepare("UPDATE documents SET oa_submission_state='unsubmitted',oa_item_id=NULL,oa_submitted_at=NULL WHERE id=? AND draft_revision=? AND oa_submission_state='unknown'")
            .bind(payload.id, payload.draftRevision)
            .run();
          current = await localDraftSubmissionState(context, payload.id);
          if (!current) throw new PublicError("资料不存在", 404);
          if (Number(current.draftRevision) !== payload.draftRevision) {
            throw new PublicError("资料版本已变化，请刷新后重试。", 409);
          }
          if (current.oaSubmissionState === "submitted") {
            throw new PublicError("已提交资料不能改回未提交状态。", 409);
          }
          if (current.oaSubmissionState !== "unsubmitted") {
            throw new PublicError("资料状态已变化，请刷新后重试。", 409);
          }
        }
      } else if (current.oaSubmissionState === "submitted") {
        if (String(current.oaItemId || "").toLowerCase() !== payload.oaItemId) {
          throw new PublicError("OA 条目编号与已保存记录不一致。", 409);
        }
      } else {
        const submittedAt = new Date().toISOString();
        const saved = await database(context)
          .prepare("UPDATE documents SET oa_submission_state='submitted',oa_item_id=?,oa_submitted_at=? WHERE id=? AND draft_revision=? AND oa_submission_state IN ('unknown','unsubmitted')")
          .bind(payload.oaItemId, submittedAt, payload.id, payload.draftRevision)
          .run();
        current = await localDraftSubmissionState(context, payload.id);
        if (!current) throw new PublicError("资料不存在", 404);
        if (!saved.meta?.changes) {
          if (Number(current.draftRevision) !== payload.draftRevision) {
            throw new PublicError("资料版本已变化，请刷新后重试。", 409);
          }
          if (current.oaSubmissionState === "submitted") {
            if (String(current.oaItemId || "").toLowerCase() !== payload.oaItemId) {
              throw new PublicError("OA 条目编号与已保存记录不一致。", 409);
            }
          } else {
            throw new PublicError("资料状态已变化，请刷新后重试。", 409);
          }
        }
      }
      return json({ saved: true, document: current });
    }
    if (path === "admin/inquiries" && method === "GET") {
      const result = await database(context)
        .prepare(
          "SELECT id,reference,name,organisation,contact,topic,summary,transcript,status,created_at AS createdAt FROM inquiries ORDER BY created_at DESC LIMIT 200",
        )
        .all();
      return json({ inquiries: result.results || [] });
    }
    if (path === "admin/inquiries" && method === "PATCH") {
      const payload = parseInquiryStatusPayload(await readJson(request, 1_000));
      const result = await database(context)
        .prepare("UPDATE inquiries SET status=? WHERE id=?")
        .bind(payload.status, payload.id)
        .run();
      if (!result.meta.changes) throw new PublicError("咨询不存在", 404);
      return json({ saved: true });
    }
    return json({ error: "没有找到此接口" }, 404);
  } catch (error) {
    const responseHeaders = chatTiming ? chatTimingHeaders(chatTiming) : {};
    if (error instanceof ValidationError) return json({ error: error.message }, 400, responseHeaders);
    if (error instanceof PublicError) return json({ error: error.message }, error.status, responseHeaders);
    console.error("Request failed", {
      path,
      method,
      type: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "服务暂时不可用，内容尚未确认保存，请稍后重试。" }, 503, responseHeaders);
  }
}

function runtimeDefaults() {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

export async function handleRequest(request, env, executionContext, runtime = runtimeDefaults()) {
  try {
    validateEnvironment(env);
    const url = new URL(request.url);
    if (url.origin !== canonicalOrigin(env)) return json({ error: "请求域名不正确" }, 421);
    const context = { request, env, executionContext, runtime };
    if (url.pathname === "/_health" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT 1 AS ok").first();
      return json({ app: APP_NAME, ready: Number(row?.ok) === 1, releaseId: releaseId(context) });
    }
    if (url.pathname.startsWith("/api/auth/")) return await auth(context);
    if (url.pathname.startsWith("/api/")) return await api(context);
    return json({ error: "Page not found" }, 404);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    if (error instanceof PublicError) return json({ error: error.message }, error.status);
    console.error("Worker request failed", {
      path: new URL(request.url).pathname,
      type: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "服务暂时不可用，请稍后重试。" }, 503);
  }
}

