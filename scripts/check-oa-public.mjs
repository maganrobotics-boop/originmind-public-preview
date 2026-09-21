import {
  OA_PUBLIC_RETRIEVE_URL,
  OA_PUBLIC_SUGGESTIONS_URL,
  PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN,
} from "../src/constants.mjs";
import {
  parseOaResult,
  parseOaSuggestions,
  suggestionMatchesKnowledge,
} from "../src/oa-public.mjs";

const MAX_RESPONSE_BYTES = 16 * 1024;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_QUESTION = "请根据公开资料简要说明 ARTS Robotics 的机器人研究方向。";
const OA_PUBLIC_ORIGIN = new URL(OA_PUBLIC_RETRIEVE_URL).origin;

async function boundedJson(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The size limit remains authoritative if cancellation fails.
    }
    throw new Error("oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("oversized");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function httpClassification(status) {
  if (status === 401 || status === 403) return "credential_rejected_or_wrong_live_target";
  if (status === 404 || status === 405) return "route_missing_or_wrong_live_target";
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (status >= 300 && status < 400) return "unexpected_redirect";
  return "edge_or_upstream_failure";
}

function receipt(clock, startedAt, classification, httpStatus = null, chunkCount = null) {
  const finishedAt = clock();
  return {
    format: "originmind-chat-oa-public-preflight-v1",
    checkedAt: new Date(finishedAt).toISOString(),
    origin: OA_PUBLIC_ORIGIN,
    classification,
    httpStatus,
    chunkCount,
    durationMs: Math.max(0, finishedAt - startedAt),
  };
}

function suggestionsReceipt(
  clock,
  startedAt,
  classification,
  {
    suggestionsHttpStatus = null,
    retrievalHttpStatus = null,
    suggestionCount = null,
    answerableSuggestionCount = 0,
    chunkCount = 0,
  } = {},
) {
  const finishedAt = clock();
  return {
    format: "originmind-chat-oa-public-suggestions-preflight-v1",
    checkedAt: new Date(finishedAt).toISOString(),
    origin: OA_PUBLIC_ORIGIN,
    classification,
    suggestionsHttpStatus,
    retrievalHttpStatus,
    suggestionCount,
    answerableSuggestionCount,
    chunkCount,
    durationMs: Math.max(0, finishedAt - startedAt),
  };
}

async function retrieveSuggestedQuestion(question, publicToken, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(OA_PUBLIC_RETRIEVE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": publicToken,
      },
      body: JSON.stringify({ question }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      classification: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "timeout"
        : "network_error",
      httpStatus: null,
      chunkCount: 0,
    };
  }

  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is authoritative; response content is intentionally ignored.
    }
    return {
      classification: httpClassification(response.status),
      httpStatus: response.status,
      chunkCount: 0,
    };
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already classified without reading its content.
    }
    return { classification: "invalid_contract", httpStatus: response.status, chunkCount: 0 };
  }

  try {
    const chunks = parseOaResult(await boundedJson(response));
    const sourceMatched = chunks.some((chunk) => suggestionMatchesKnowledge(question, chunk));
    return {
      classification: chunks.length === 0
        ? "not_answerable"
        : sourceMatched
          ? "connected_with_public_knowledge"
          : "source_mismatch",
      httpStatus: response.status,
      chunkCount: chunks.length,
    };
  } catch {
    return { classification: "invalid_contract", httpStatus: response.status, chunkCount: 0 };
  }
}

function suggestionRetrievalClassification(classification) {
  if (classification === "not_answerable") return "suggestion_not_answerable";
  if (classification === "source_mismatch") return "suggestion_source_mismatch";
  return `suggestion_retrieval_${classification}`;
}

export async function checkOaPublicSuggestions(
  publicToken,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = PREFLIGHT_TIMEOUT_MS,
    clock = () => Date.now(),
  } = {},
) {
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(publicToken)) {
    throw new Error("OA public suggestions preflight requires a normalized service token");
  }
  const startedAt = clock();
  let response;
  try {
    response = await fetchImpl(OA_PUBLIC_SUGGESTIONS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-originmind-public-lab-ai-service-token": publicToken,
      },
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const classification = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "suggestions_timeout"
      : "suggestions_network_error";
    return suggestionsReceipt(clock, startedAt, classification);
  }

  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is authoritative; response content is intentionally ignored.
    }
    return suggestionsReceipt(clock, startedAt, `suggestions_${httpClassification(response.status)}`, {
      suggestionsHttpStatus: response.status,
    });
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already classified without reading its content.
    }
    return suggestionsReceipt(clock, startedAt, "suggestions_invalid_contract", {
      suggestionsHttpStatus: response.status,
    });
  }

  let suggestions;
  try {
    suggestions = parseOaSuggestions(await boundedJson(response));
  } catch {
    return suggestionsReceipt(clock, startedAt, "suggestions_invalid_contract", {
      suggestionsHttpStatus: response.status,
    });
  }
  if (suggestions.length === 0) {
    return suggestionsReceipt(clock, startedAt, "suggestions_empty", {
      suggestionsHttpStatus: response.status,
      suggestionCount: 0,
    });
  }

  const retrievals = await Promise.all(suggestions.map((suggestion) => (
    retrieveSuggestedQuestion(suggestion.question, publicToken, fetchImpl, timeoutMs)
  )));
  const answerable = retrievals.filter(({ classification }) => (
    classification === "connected_with_public_knowledge"
  ));
  const firstFailure = retrievals.find(({ classification }) => (
    classification !== "connected_with_public_knowledge"
  ));
  const chunkCount = retrievals.reduce((total, result) => total + result.chunkCount, 0);
  return suggestionsReceipt(
    clock,
    startedAt,
    firstFailure
      ? suggestionRetrievalClassification(firstFailure.classification)
      : "connected_with_answerable_suggestions",
    {
      suggestionsHttpStatus: response.status,
      retrievalHttpStatus: firstFailure ? firstFailure.httpStatus : 200,
      suggestionCount: suggestions.length,
      answerableSuggestionCount: answerable.length,
      chunkCount,
    },
  );
}

export async function checkOaPublicRetrieve(
  publicToken,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = PREFLIGHT_TIMEOUT_MS,
    clock = () => Date.now(),
  } = {},
) {
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(publicToken)) {
    throw new Error("OA public retrieve preflight requires a normalized service token");
  }
  const startedAt = clock();
  let response;
  try {
    response = await fetchImpl(OA_PUBLIC_RETRIEVE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-originmind-public-lab-ai-service-token": publicToken,
      },
      body: JSON.stringify({ question: PREFLIGHT_QUESTION }),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const classification = error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "timeout"
      : "network_error";
    return receipt(clock, startedAt, classification);
  }

  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is authoritative; response content is intentionally ignored.
    }
    return receipt(clock, startedAt, httpClassification(response.status), response.status);
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already classified without reading its content.
    }
    return receipt(clock, startedAt, "invalid_contract", response.status);
  }

  try {
    const chunks = parseOaResult(await boundedJson(response));
    return receipt(
      clock,
      startedAt,
      chunks.length > 0 ? "connected_with_public_knowledge" : "credential_accepted_empty",
      response.status,
      chunks.length,
    );
  } catch {
    return receipt(clock, startedAt, "invalid_contract", response.status);
  }
}
