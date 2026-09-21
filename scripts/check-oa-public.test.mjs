import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { OA_PUBLIC_RETRIEVE_URL, OA_PUBLIC_SUGGESTIONS_URL } from "../src/constants.mjs";
import { checkOaPublicRetrieve, checkOaPublicSuggestions } from "./check-oa-public.mjs";

const token = "A".repeat(43);
const validPayload = {
  chunks: [{
    id: "1",
    title: "公开知识测试",
    category: "research",
    sectionTitle: "实验室资料",
    paragraphRef: "P1",
    excerpt: "这是已审批并公开的机器人实验室知识。",
    sourceLabel: "已审批公开文件",
    updatedAt: "2026-09-12",
  }],
};
const validSuggestionsPayload = {
  suggestions: [
    {
      id: "1",
      question: "《公开知识测试》中的“实验室资料”有哪些值得关注的内容？",
      updatedAt: "2026-09-14",
    },
    {
      id: "2",
      question: "《机器人安全指南》有哪些值得关注的核心内容？",
      updatedAt: "2026-09-13",
    },
    {
      id: "3",
      question: "《已公开项目资料》中的“核心应用”有哪些值得关注的内容？",
      updatedAt: "2026-09-12",
    },
    {
      id: "4",
      question: "《矿井巡检周报》中的“现场进展”有哪些值得关注的内容？",
      updatedAt: "2026-09-11",
    },
    {
      id: "5",
      question: "《机器人导航方案》有哪些值得关注的核心内容？",
      updatedAt: "2026-09-10",
    },
  ],
};

function referenceFromQuestion(question) {
  const match = /^《(.+)》(?:中的“(.+)”有哪些值得关注的内容|有哪些值得关注的核心内容)？$/u.exec(question);
  return { title: match?.[1], sectionTitle: match?.[2] || "" };
}

function validPayloadForQuestion(question) {
  const reference = referenceFromQuestion(question);
  return {
    chunks: [{
      ...validPayload.chunks[0],
      title: reference.title,
      sectionTitle: reference.sectionTitle,
    }],
  };
}

function response(body, status = 200, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

test("OA preflight sends the normalized token and records only safe success evidence", async () => {
  let request;
  const times = [1_000, 1_025];
  const result = await checkOaPublicRetrieve(token, {
    clock: () => times.shift(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(JSON.stringify(validPayload));
    },
  });

  assert.equal(request.url, OA_PUBLIC_RETRIEVE_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(request.options.headers["x-originmind-public-lab-ai-service-token"], token);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), { question: "请根据公开资料简要说明 ARTS Robotics 的机器人研究方向。" });
  assert.deepEqual(result, {
    format: "originmind-chat-oa-public-preflight-v1",
    checkedAt: new Date(1_025).toISOString(),
    origin: "https://oa.omindos.ai",
    classification: "connected_with_public_knowledge",
    httpStatus: 200,
    chunkCount: 1,
    durationMs: 25,
  });
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("OA preflight classifies HTTP failures without reading or recording response content", async () => {
  const cases = [
    [301, "unexpected_redirect"],
    [401, "credential_rejected_or_wrong_live_target"],
    [403, "credential_rejected_or_wrong_live_target"],
    [404, "route_missing_or_wrong_live_target"],
    [405, "route_missing_or_wrong_live_target"],
    [429, "rate_limited"],
    [503, "service_unavailable"],
    [502, "edge_or_upstream_failure"],
  ];
  for (const [status, classification] of cases) {
    const hostileBody = `must-not-appear-${token}`;
    const result = await checkOaPublicRetrieve(token, {
      clock: () => 2_000,
      fetchImpl: async () => response(hostileBody, status, "text/plain"),
    });
    assert.equal(result.classification, classification);
    assert.equal(result.httpStatus, status);
    assert.equal(result.chunkCount, null);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes(hostileBody), false);
  }
});

test("OA preflight distinguishes empty knowledge, invalid contracts, and network failures", async () => {
  const empty = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify({ chunks: [] })),
  });
  assert.equal(empty.classification, "credential_accepted_empty");
  assert.equal(empty.chunkCount, 0);

  const invalid = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response("{not-json"),
  });
  assert.equal(invalid.classification, "invalid_contract");
  assert.equal(invalid.httpStatus, 200);

  const strictInvalid = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify({ chunks: [], extra: true })),
  });
  assert.equal(strictInvalid.classification, "invalid_contract");

  const wrongMediaType = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => response(JSON.stringify(validPayload), 200, "text/plain"),
  });
  assert.equal(wrongMediaType.classification, "invalid_contract");

  const oversized = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 + 1),
      },
    }),
  });
  assert.equal(oversized.classification, "invalid_contract");

  const streamedOversized = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  assert.equal(streamedOversized.classification, "invalid_contract");

  const timeout = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => {
      throw Object.assign(new Error(`hostile-${token}`), { name: "TimeoutError" });
    },
  });
  assert.equal(timeout.classification, "timeout");
  assert.equal(JSON.stringify(timeout).includes(token), false);

  const network = await checkOaPublicRetrieve(token, {
    clock: () => 3_000,
    fetchImpl: async () => {
      throw new Error(`hostile-${token}`);
    },
  });
  assert.equal(network.classification, "network_error");
  assert.equal(JSON.stringify(network).includes(token), false);
});

test("OA preflight rejects a non-normalized token locally", async () => {
  await assert.rejects(
    checkOaPublicRetrieve("copied-secret"),
    /requires a normalized service token/u,
  );
  await assert.rejects(
    checkOaPublicSuggestions("copied-secret"),
    /requires a normalized service token/u,
  );
});

test("OA suggestions preflight authenticates, validates, and retrieves every suggestion", async () => {
  const requests = [];
  const times = [4_000, 4_075];
  const result = await checkOaPublicSuggestions(token, {
    clock: () => times.shift(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === OA_PUBLIC_SUGGESTIONS_URL) {
        return response(JSON.stringify(validSuggestionsPayload));
      }
      assert.equal(url, OA_PUBLIC_RETRIEVE_URL);
      const { question } = JSON.parse(options.body);
      return response(JSON.stringify(validPayloadForQuestion(question)));
    },
  });

  assert.equal(requests.length, 6);
  const [suggestionsRequest, ...retrieveRequests] = requests;
  assert.equal(suggestionsRequest.url, OA_PUBLIC_SUGGESTIONS_URL);
  assert.equal(suggestionsRequest.options.method, "GET");
  assert.equal(suggestionsRequest.options.redirect, "manual");
  assert.equal(suggestionsRequest.options.cache, "no-store");
  assert.equal(suggestionsRequest.options.credentials, "omit");
  assert.equal(suggestionsRequest.options.headers.Accept, "application/json");
  assert.equal(
    suggestionsRequest.options.headers["x-originmind-public-lab-ai-service-token"],
    token,
  );
  assert.equal(suggestionsRequest.options.headers.Cookie, undefined);
  assert.equal(suggestionsRequest.options.headers.Authorization, undefined);
  assert.equal(Object.hasOwn(suggestionsRequest.options, "body"), false);
  assert.ok(suggestionsRequest.options.signal instanceof AbortSignal);

  assert.deepEqual(
    retrieveRequests.map(({ options }) => JSON.parse(options.body)),
    validSuggestionsPayload.suggestions.map(({ question }) => ({ question })),
  );
  for (const { url, options } of retrieveRequests) {
    assert.equal(url, OA_PUBLIC_RETRIEVE_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.headers["x-originmind-public-lab-ai-service-token"], token);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }

  assert.deepEqual(result, {
    format: "originmind-chat-oa-public-suggestions-preflight-v1",
    checkedAt: new Date(4_075).toISOString(),
    origin: "https://oa.omindos.ai",
    classification: "connected_with_answerable_suggestions",
    suggestionsHttpStatus: 200,
    retrievalHttpStatus: 200,
    suggestionCount: 5,
    answerableSuggestionCount: 5,
    chunkCount: 5,
    durationMs: 75,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  for (const { question } of validSuggestionsPayload.suggestions) {
    assert.equal(serialized.includes(question), false);
  }
});

test("OA suggestions preflight requires one to five strict bounded suggestions", async () => {
  const cases = [
    [{ suggestions: [] }, "suggestions_empty", 0],
    [{ ...validSuggestionsPayload, extra: true }, "suggestions_invalid_contract", null],
    [{
      suggestions: [
        ...validSuggestionsPayload.suggestions,
        { id: "6", question: "《第六项公开知识》有哪些值得关注的核心内容？", updatedAt: "2026-09-09" },
      ],
    }, "suggestions_invalid_contract", null],
    [{
      suggestions: [
        validSuggestionsPayload.suggestions[0],
        { ...validSuggestionsPayload.suggestions[1], question: validSuggestionsPayload.suggestions[0].question },
      ],
    }, "suggestions_invalid_contract", null],
  ];
  for (const [payload, classification, suggestionCount] of cases) {
    let calls = 0;
    const result = await checkOaPublicSuggestions(token, {
      clock: () => 5_000,
      fetchImpl: async () => {
        calls += 1;
        return response(JSON.stringify(payload));
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.classification, classification);
    assert.equal(result.suggestionCount, suggestionCount);
    assert.equal(result.answerableSuggestionCount, 0);
    assert.equal(result.chunkCount, 0);
  }

  const wrongMediaType = await checkOaPublicSuggestions(token, {
    clock: () => 5_000,
    fetchImpl: async () => response(JSON.stringify(validSuggestionsPayload), 200, "text/plain"),
  });
  assert.equal(wrongMediaType.classification, "suggestions_invalid_contract");

  const oversized = await checkOaPublicSuggestions(token, {
    clock: () => 5_000,
    fetchImpl: async () => new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 + 1),
      },
    }),
  });
  assert.equal(oversized.classification, "suggestions_invalid_contract");

  const streamedOversized = await checkOaPublicSuggestions(token, {
    clock: () => 5_000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  assert.equal(streamedOversized.classification, "suggestions_invalid_contract");
});

test("OA suggestions preflight classifies endpoint failures without leaking content", async () => {
  const cases = [
    [301, "suggestions_unexpected_redirect"],
    [401, "suggestions_credential_rejected_or_wrong_live_target"],
    [404, "suggestions_route_missing_or_wrong_live_target"],
    [429, "suggestions_rate_limited"],
    [503, "suggestions_service_unavailable"],
    [502, "suggestions_edge_or_upstream_failure"],
  ];
  for (const [status, classification] of cases) {
    const hostileBody = `must-not-appear-${token}`;
    const result = await checkOaPublicSuggestions(token, {
      clock: () => 6_000,
      fetchImpl: async () => response(hostileBody, status, "text/plain"),
    });
    assert.equal(result.classification, classification);
    assert.equal(result.suggestionsHttpStatus, status);
    assert.equal(result.suggestionCount, null);
    assert.equal(JSON.stringify(result).includes(hostileBody), false);
    assert.equal(JSON.stringify(result).includes(token), false);
  }

  const timeout = await checkOaPublicSuggestions(token, {
    clock: () => 6_000,
    fetchImpl: async () => {
      throw Object.assign(new Error(`hostile-${token}`), { name: "TimeoutError" });
    },
  });
  assert.equal(timeout.classification, "suggestions_timeout");
  assert.equal(JSON.stringify(timeout).includes(token), false);

  const network = await checkOaPublicSuggestions(token, {
    clock: () => 6_000,
    fetchImpl: async () => {
      throw new Error(`hostile-${token}`);
    },
  });
  assert.equal(network.classification, "suggestions_network_error");
  assert.equal(JSON.stringify(network).includes(token), false);
});

test("OA suggestions preflight attempts every retrieval and fails when any suggestion is unanswered", async () => {
  const postedQuestions = [];
  const result = await checkOaPublicSuggestions(token, {
    clock: () => 7_000,
    fetchImpl: async (url, options) => {
      if (url === OA_PUBLIC_SUGGESTIONS_URL) {
        return response(JSON.stringify(validSuggestionsPayload));
      }
      const { question } = JSON.parse(options.body);
      postedQuestions.push(question);
      if (question === validSuggestionsPayload.suggestions[0].question) {
        return response(JSON.stringify({ chunks: [] }));
      }
      if (question === validSuggestionsPayload.suggestions[1].question) {
        return response(JSON.stringify({ chunks: [], extra: true }));
      }
      return response(JSON.stringify(validPayloadForQuestion(question)));
    },
  });

  assert.deepEqual(
    postedQuestions,
    validSuggestionsPayload.suggestions.map(({ question }) => question),
  );
  assert.equal(result.classification, "suggestion_not_answerable");
  assert.equal(result.suggestionsHttpStatus, 200);
  assert.equal(result.retrievalHttpStatus, 200);
  assert.equal(result.suggestionCount, 5);
  assert.equal(result.answerableSuggestionCount, 3);
  assert.equal(result.chunkCount, 3);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  for (const { question } of validSuggestionsPayload.suggestions) {
    assert.equal(serialized.includes(question), false);
  }
});

test("OA suggestions preflight rejects non-source-bound questions and unrelated retrieval hits", async () => {
  const unbound = await checkOaPublicSuggestions(token, {
    clock: () => 7_500,
    fetchImpl: async (url) => (
      url === OA_PUBLIC_SUGGESTIONS_URL
        ? response(JSON.stringify({
          suggestions: [{ id: "1", question: "最近有哪些有趣内容？", updatedAt: "2026-09-14" }],
        }))
        : response(JSON.stringify(validPayload))
    ),
  });
  assert.equal(unbound.classification, "suggestions_invalid_contract");
  assert.equal(unbound.retrievalHttpStatus, null);
  assert.equal(unbound.answerableSuggestionCount, 0);
  assert.equal(unbound.chunkCount, 0);

  const mismatchQuestion = { ...validSuggestionsPayload.suggestions[1], id: "1" };
  const mismatch = await checkOaPublicSuggestions(token, {
    clock: () => 7_500,
    fetchImpl: async (url) => (
      url === OA_PUBLIC_SUGGESTIONS_URL
        ? response(JSON.stringify({ suggestions: [mismatchQuestion] }))
        : response(JSON.stringify(validPayload))
    ),
  });
  assert.equal(mismatch.classification, "suggestion_source_mismatch");
  assert.equal(mismatch.retrievalHttpStatus, 200);
  assert.equal(mismatch.answerableSuggestionCount, 0);
  assert.equal(mismatch.chunkCount, 1);
});

test("OA suggestions preflight reports safe retrieval HTTP and network failures", async () => {
  const oneSuggestion = { suggestions: [validSuggestionsPayload.suggestions[0]] };
  const unavailable = await checkOaPublicSuggestions(token, {
    clock: () => 8_000,
    fetchImpl: async (url) => (
      url === OA_PUBLIC_SUGGESTIONS_URL
        ? response(JSON.stringify(oneSuggestion))
        : response(`hostile-${token}`, 503, "text/plain")
    ),
  });
  assert.equal(unavailable.classification, "suggestion_retrieval_service_unavailable");
  assert.equal(unavailable.retrievalHttpStatus, 503);
  assert.equal(unavailable.answerableSuggestionCount, 0);
  assert.equal(JSON.stringify(unavailable).includes(token), false);

  let calls = 0;
  const network = await checkOaPublicSuggestions(token, {
    clock: () => 8_000,
    fetchImpl: async (url) => {
      calls += 1;
      if (url === OA_PUBLIC_SUGGESTIONS_URL) return response(JSON.stringify(oneSuggestion));
      throw new Error(`hostile-${token}`);
    },
  });
  assert.equal(calls, 2);
  assert.equal(network.classification, "suggestion_retrieval_network_error");
  assert.equal(network.retrievalHttpStatus, null);
  assert.equal(JSON.stringify(network).includes(token), false);
});

test("release gates on OA before the first Cloudflare resource mutation", async () => {
  const entry = await readFile(new URL("./release-cloudflare.mjs", import.meta.url), "utf8");
  assert.ok(entry.indexOf("checkOaPublicRetrieve(environment.publicToken)") > 0);
  assert.ok(
    entry.indexOf("checkOaPublicRetrieve(environment.publicToken)")
      < entry.indexOf("ensureDatabase(bootstrapConfigPath, secretValues)"),
  );
  assert.match(entry, /oa-public-preflight\.json/u);
  assert.match(entry, /connected_with_public_knowledge/u);
  assert.ok(entry.indexOf("checkOaPublicSuggestions(environment.publicToken)") > 0);
  assert.ok(
    entry.indexOf("checkOaPublicSuggestions(environment.publicToken)")
      < entry.indexOf("ensureDatabase(bootstrapConfigPath, secretValues)"),
  );
  assert.match(entry, /oa-public-suggestions-preflight\.json/u);
  assert.match(entry, /connected_with_answerable_suggestions/u);
});
