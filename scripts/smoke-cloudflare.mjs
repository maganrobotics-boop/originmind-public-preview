import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

import { parseChatSuggestions } from "../src/natural-suggestions.mjs";

// A newly published Worker or route can briefly return 404/421 while edge state converges.
const TRANSIENT_STATUSES = new Set([404, 408, 421, 425, 500, 502, 503, 504]);
const DOCUMENT_SMOKE_FIXTURES = Object.freeze([
  Object.freeze({
    name: "originmind-release-smoke.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDAwMDEwMTAwMDAwMCswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDAwMDEwMTAwMDAwMCswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlIChPcmlnaW5NaW5kIHVwbG9hZCBzbW9rZSkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0xlbmd0aCAyMDQKPj4Kc3RyZWFtCjEgMCAwIDEgMCAwIGNtICBCVCAvRjEgMTIgVGYgMTQuNCBUTCBFVApCVCAvRjEgMTQgVGYgMTYuOCBUTCBFVApCVCAxIDAgMCAxIDcyIDc3MCBUbSAoT3JpZ2luTWluZCBQREYgdXBsb2FkIHNtb2tlIHRlc3QuKSBUaiBUKiBFVApCVCAxIDAgMCAxIDcyIDc0NSBUbSAoQ2xvdWRmbGFyZSBBSSBzaG91bGQgZXh0cmFjdCB0aGlzIHRleHQuKSBUaiBUKiBFVAogCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDc0NiAwMDAwMCBuIAowMDAwMDAwODA1IDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDJkNjE0MzM2MWQxM2Y2NDM0NjI1Y2VlMmU3ZTQxMGUwPjwyZDYxNDMzNjFkMTNmNjQzNDYyNWNlZTJlN2U0MTBlMD5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTA1OQolJUVPRgo=", "base64"),
  }),
  Object.freeze({
    name: "originmind-release-smoke.png",
    mimeType: "image/png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAoAAAACgAQAAAAC0heCRAAAEJklEQVR42u3YT08bRwCH4XfXK7yVXDrNyUhETFCulUzaQw6R2LQ99Cv0VIMq9dTE1zQ0jFGkcqTHSFHwx6jUJgwRBy4plnqtwpigsie0Dm61RvunB9uQkGCcwKXVzGl2ZvbRjDTj9W+cnIstLha0oAUtaEELWtCCFrSgBS14bjAVpBCC2AmBIH1tRBPgsP8QDurBMLDTueAZHuxfMLhbpABlKIdlgMJ5Qd/rXE4/Cx8EED6TG6SHy8vtYKfR4jDtCFrKyyXt2fmd3GezxZ683728cRroAfqTH0mahMaHTvQY8rvO181t1cp/II0xa2kWEpmnUwsJm+18Lr/3fTR0hsLFdDXFWqlJ4ZeHwK1bH+nfWdXAn2yZJDHs6cmHC/usrOqJ53cPXtwYvg8dXkr8APCmpoHlZVH+GVkFZxxRd+8IfDk97fi5lFVYui8YtmRw8UodAeBzU+MAyG9agDtGYwXXBwL+LmSzDqTuqCdlrHFU7Uqoq/7DEtAGIFF1Re521TsfvfCVeq6AinylpbwyFIyywZvH7XsGFk2vnt0DxiMATy0anPyneCgY0F+Bd3xC/VcHKcDRAK7utZihYJxAcrSz1vqvmLqGJIsxzSzrzShLnZY+4yS5wGQXxg1QUOA8ByDWtzEmj/OX1NRCMcJoKMbUjAFVM70foVPADy9B8Wi13wIwoa4xF3iCq8xML3uS1gp4l7g+F+TT9fZXG8NmWCqBVxm0fAGAqF5RVemWCj7y5phbRkpwPSar0nPUijh93+T9cpCfLKtvbz6jHO3DN4+7Otc3Jdk92bMtzwWmb3wkds731fPKJ3ukfi/QsbdzFrSgBS1oQQta8H+X6HupfZCQdlOgAdAZ/JU+JOwQQodB1yiJPrnoRO/048xf5070pdHGlkdO9C7ruZqVe0FLXWsrgFR0g6XDlDZcaysvlzxQfrjOs8DffDF/FtgErchCMI1mU/MHJHFoFoEooNlcS7MQ0gStSJPJ3VG2zSNNYib0lBrfqgJ0o+LtGwr2YHyrmiSG79Q+q3z62z/ig0cjgFegK0BWhKigFK7vB58DmwohZtw7AhwfqXAKY80RZpgH1V5qRzZgGkBkdQ0iQDbA9QcjD3vpedST0g5YD06mjPVgqV/bgNTz5DuAzV4M15Q2TyZ6gMdq6LXXW8AtzWzEUygsHDfO7t/r165rCjn6TPAoiHJ8e1J7W+orAqTmTDDO0I08iwFNlSyvArAYJEQaqgwSPTBGXDsTnOw42zwpRhApogggjnCf5DHXFUTRQrGXVRchz93gtSuTUxL9/M0NT8IMzEiA7lWcjfuCCegn+q6CpSD90u3EQ2Ol10v0waz3axmkrlVEWqjg+1B3SwgNlY9jt4wA1GK34JjJwIZHC1rQgha0oAUtaEELWtCCFrSgBS34nwf/BTF4225LfaIKAAAAAElFTkSuQmCC", "base64"),
  }),
]);

export function isTransientSmokeStatus(status) {
  return TRANSIENT_STATUSES.has(status);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("Smoke origin must be an exact HTTPS origin");
  }
  return url.origin;
}

async function request(origin, pathname, init = {}) {
  const { timeoutMilliseconds = 45_000, ...requestInit } = init;
  try {
    return await fetch(`${origin}${pathname}`, {
      ...requestInit,
      headers: {
        Accept: "application/json, text/html;q=0.9",
        "Cache-Control": "no-cache",
        "User-Agent": "OriginMind-Chat-Release-Smoke/1.0",
        ...(requestInit.headers || {}),
      },
      redirect: "error",
      signal: requestInit.signal || AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    throw Object.assign(new Error("Smoke request failed"), { retryable: true });
  }
}

async function json(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} did not return JSON`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function apiHeaders(response, label) {
  if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
    throw new Error(`${label} is missing X-Content-Type-Options: nosniff`);
  }
  if (!(response.headers.get("cache-control") || "").toLowerCase().includes("no-store")) {
    throw new Error(`${label} is missing Cache-Control: no-store`);
  }
}

export function frontendAssetPaths(html) {
  if (typeof html !== "string") throw new Error("Frontend shell is not text");
  const app = [
    ...html.matchAll(
      /<script\b[^>]*\bsrc=["']\/assets\/(app-([a-f0-9]{16})\.js)["'][^>]*>/giu,
    ),
  ];
  const style = [
    ...html.matchAll(
      /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']\/assets\/(styles-([a-f0-9]{16})\.css)["'][^>]*>/giu,
    ),
  ];
  if (app.length !== 1 || style.length !== 1) {
    throw new Error("Frontend shell does not reference one generated JavaScript and stylesheet asset");
  }
  return [
    { pathname: `/assets/${app[0][1]}`, hash: app[0][2], mediaType: "javascript" },
    { pathname: `/assets/${style[0][1]}`, hash: style[0][2], mediaType: "css" },
  ];
}

async function verifyFrontendAsset(origin, asset) {
  const response = await request(origin, asset.pathname, {
    headers: { Accept: asset.mediaType === "css" ? "text/css" : "application/javascript" },
  });
  if (response.status !== 200) {
    throw Object.assign(new Error(`${asset.pathname} returned ${response.status}`), { status: response.status });
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (
    (asset.mediaType === "css" && !contentType.includes("text/css")) ||
    (asset.mediaType === "javascript" && !/(?:application|text)\/javascript/u.test(contentType))
  ) {
    throw new Error(`${asset.pathname} returned an invalid Content-Type`);
  }
  if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
    throw new Error(`${asset.pathname} is missing X-Content-Type-Options: nosniff`);
  }
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (!cacheControl.includes("max-age=31536000") || !cacheControl.includes("immutable")) {
    throw new Error(`${asset.pathname} is missing immutable caching`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 200) throw new Error(`${asset.pathname} is incomplete`);
  if (createHash("sha256").update(bytes).digest("hex").slice(0, 16) !== asset.hash) {
    throw new Error(`${asset.pathname} does not match its content hash`);
  }
}

function expectedRelease(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u.test(value)) {
    throw new Error("Smoke check requires the exact Chat release ID");
  }
  return value;
}

function hasReferenceSection(answer) {
  return (
    /(?:参考资料|参考文献|参考来源|资料来源)/u.test(answer) ||
    /(?:^|[^\p{L}\p{N}_*`#~-])(?:参考|引用|出处)(?:列表|清单)?(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*[:：]/iu.test(answer) ||
    /(?:^|[^\p{L}\p{N}_-])(?:references?|sources?|citations?|bibliography|works[ \t]+cited)(?:[ \t]+list)?[ \t]*[:：]/iu.test(answer) ||
    /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：]|(?=[\[［【]\s*[0-9０-９]))/imu.test(answer) ||
    /^[ \t]*(?:(?:[-+*•>]|[0-9０-９]+[.)、．。])[ \t]+)?(?:#{1,6}[ \t]+)?(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:(?:参考资料|参考文献|参考来源|资料来源|参考|引用|出处)(?:列表|清单)?|(?:references?|sources?|citations?|bibliography)(?:[ \t]+list)?|works[ \t]+cited|(?:来源|source)(?:列表|清单|[ \t]+list)?)(?:如下(?:所示)?)?[ \t]*(?:\*{1,3}|_{1,3}|`{1,3})?[ \t]*(?:[:：])?[ \t]*$/imu.test(answer)
  );
}

export function validateSuggestionEvidence(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, "suggestions") ||
    !Object.hasOwn(payload, "oaPublicStatus") ||
    Object.keys(payload).length !== 2 ||
    payload.oaPublicStatus !== "connected"
  ) {
    throw new Error("/api/suggestions did not return connected OA recommendations");
  }
  let suggestions;
  try {
    suggestions = parseChatSuggestions(payload.suggestions);
  } catch {
    throw new Error("/api/suggestions returned an invalid recommendation contract");
  }
  if (!suggestions.length) {
    throw new Error("/api/suggestions did not return any answerable recommendations");
  }
  return suggestions;
}

function validateHealthEvidence(health, releaseId) {
  if (
    health?.app !== "arts-robotics-ai-assistant" ||
    health?.ready !== true ||
    health?.releaseId !== releaseId
  ) {
    throw Object.assign(new Error("/_health did not identify the expected ready ARTS Robotics AI assistant release"), {
      retryable: health?.app === "arts-robotics-ai-assistant" && health?.ready === true &&
        /^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u.test(health?.releaseId || "") && health.releaseId !== releaseId,
    });
  }
}

export function validateServiceEvidence({ health, status, suggestions, chat }, releaseIdValue) {
  const releaseId = expectedRelease(releaseIdValue);
  validateHealthEvidence(health, releaseId);
  const readiness = [
    status?.storageReady,
    status?.modelReady,
    status?.qwenReady,
    status?.oaReady,
    status?.knowledgeReady,
    status?.retrievalReady,
    status?.budgetReady,
    status?.systemReady,
    status?.documentParsingReady,
  ];
  if (readiness.some((value) => value !== true) || !["workers-ai", "bailian"].includes(status?.provider)) {
    throw Object.assign(new Error("/api/status is not fully ready for the five-light homepage and document parser"), {
      retryable:
        status?.modelPending === true ||
        status?.oaPending === true ||
        (readiness.every((value) => typeof value === "boolean") && readiness.some((value) => value === false)),
    });
  }
  if (chat?.releaseId !== releaseId) {
    throw Object.assign(new Error("/api/chat did not return the expected release; edge propagation may still be in progress"), {
      retryable: /^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u.test(chat?.releaseId || ""),
    });
  }
  const validPublicSources = Array.isArray(chat?.sources) && chat.sources.length > 0 &&
    chat.sources.every((source) => source?.origin === "oa_public");
  const validPublicAnswer = typeof chat?.answer === "string" && Boolean(chat.answer.trim()) &&
    !/[\[［【][^\]］】\r\n]*[0-9０-９]+[^\]］】\r\n]*[\]］】]/u.test(chat.answer) &&
    !hasReferenceSection(chat.answer);
  if (
    chat?.mode !== "ai" ||
    chat?.oaPublicStatus !== "connected" ||
    !validPublicAnswer
  ) {
    throw Object.assign(new Error("/api/chat did not return a citation-free OA-backed AI answer from the expected release" +
      (chat?.mode === "retrieval" ? " (retrieval fallback)" : " (answer contract)")), {
      retryable: chat?.mode === "retrieval" && chat.oaPublicStatus === "connected" &&
        validPublicSources && validPublicAnswer,
    });
  }
  if (!validPublicSources) {
    throw new Error("/api/chat sources were not exclusively OA-approved public knowledge");
  }
  const recommendations = validateSuggestionEvidence(suggestions);
  return {
    app: health.app,
    ready: health.ready,
    releaseId,
    oaPublicStatus: chat.oaPublicStatus,
    provider: chat.provider || status.provider,
    model: status.model,
    sources: chat.sources.length,
    suggestions: recommendations.length,
  };
}

function validateAdminAuth(adminAuth) {
  if (adminAuth?.status !== 401 || adminAuth?.error !== "密码不正确") {
    throw new Error("/api/auth/login did not execute a compatible administrator password check");
  }
}

export function validateReleaseEvidence({ health, status, suggestions, chat, adminAuth }, releaseIdValue) {
  const evidence = validateServiceEvidence({ health, status, suggestions, chat }, releaseIdValue);
  validateAdminAuth(adminAuth);
  return { ...evidence, adminKdfCompatible: true };
}

async function smokeOnce(origin, releaseId) {
  let frontendAssets;
  for (const pathname of ["/", "/technology", "/research", "/originmind", "/ius", "/manage"]) {
    const response = await request(origin, pathname, { headers: { Accept: "text/html" } });
    if (response.status !== 200) throw Object.assign(new Error(`${pathname} returned ${response.status}`), { status: response.status });
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
      throw new Error(`${pathname} did not return HTML`);
    }
    const body = await response.text();
    if (body.length < 200) throw new Error(`${pathname} returned an incomplete page`);
    if ((response.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") {
      throw new Error(`${pathname} is missing X-Content-Type-Options: nosniff`);
    }
    const paths = frontendAssetPaths(body);
    if (frontendAssets && JSON.stringify(paths) !== JSON.stringify(frontendAssets)) {
      throw new Error("Public and manager shells reference different frontend assets");
    }
    frontendAssets = paths;
  }

  for (const asset of frontendAssets) await verifyFrontendAsset(origin, asset);

  const healthResponse = await request(origin, "/_health");
  if (healthResponse.status !== 200) {
    throw Object.assign(new Error(`/_health returned ${healthResponse.status}`), { status: healthResponse.status });
  }
  apiHeaders(healthResponse, "/_health");
  const health = await json(healthResponse, "/_health");
  // Do not spend model calls or test the wrong Worker during edge propagation.
  validateHealthEvidence(health, releaseId);

  const hostileResponse = await request(origin, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://invalid.example" },
    body: JSON.stringify({ messages: [{ role: "user", content: "研究方向是什么？" }], topic: "research" }),
  });
  if (hostileResponse.status !== 403) {
    throw Object.assign(new Error("/api/chat accepted a hostile Origin"), { status: hostileResponse.status });
  }

  const missingResponse = await request(origin, "/api/release-smoke-missing");
  if (missingResponse.status !== 404) {
    throw Object.assign(new Error("Unknown API route did not return 404"), { status: missingResponse.status });
  }

  const suggestionsResponse = await request(origin, "/api/suggestions");
  if (suggestionsResponse.status !== 200) {
    throw Object.assign(new Error(`/api/suggestions returned ${suggestionsResponse.status}`), { status: suggestionsResponse.status });
  }
  apiHeaders(suggestionsResponse, "/api/suggestions");
  const suggestions = await json(suggestionsResponse, "/api/suggestions");
  const recommendations = validateSuggestionEvidence(suggestions);

  const chatResponse = await request(origin, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      messages: [{ role: "user", content: recommendations[0].question }],
      topic: "research",
      suggestionToken: recommendations[0].suggestionToken,
    }),
  });
  if (chatResponse.status !== 200) {
    throw Object.assign(new Error(`/api/chat returned ${chatResponse.status}`), { status: chatResponse.status });
  }
  apiHeaders(chatResponse, "/api/chat");
  const chat = await json(chatResponse, "/api/chat");

  // A successful chat records fresh model evidence. Read status afterwards so
  // release validation does not reject the new evidence it just established.
  const statusResponse = await request(origin, "/api/status");
  if (statusResponse.status !== 200) {
    throw Object.assign(new Error(`/api/status returned ${statusResponse.status}`), { status: statusResponse.status });
  }
  apiHeaders(statusResponse, "/api/status");
  const status = await json(statusResponse, "/api/status");

  return validateServiceEvidence({ health, status, suggestions, chat }, releaseId);
}

async function verifyAdminPasswordRuntime(origin) {
  // Run this once, outside the release retry loop. A high-entropy wrong
  // password forces the production runtime to execute the stored KDF without
  // creating a session or exposing a secret. This catches platform-
  // incompatible records without exhausting the login rate limit.
  const diagnosticPassword = `release-smoke-${randomBytes(24).toString("base64url")}`;
  const authResponse = await request(origin, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password: diagnosticPassword }),
  });
  if (authResponse.status !== 401 && isTransientSmokeStatus(authResponse.status)) {
    throw Object.assign(new Error("Administrator KDF check returned a transient response"), {
      status: authResponse.status,
      retryable: true,
    });
  }
  apiHeaders(authResponse, "/api/auth/login");
  const authPayload = await json(authResponse, "/api/auth/login");
  const adminAuth = { status: authResponse.status, error: authPayload?.error };
  if (adminAuth.status !== 401 || adminAuth.error !== "密码不正确") {
    throw Object.assign(
      new Error("/api/auth/login did not complete the administrator password check"),
      { status: authResponse.status, retryable: isTransientSmokeStatus(authResponse.status) },
    );
  }
  validateAdminAuth(adminAuth);
}

async function runAdminProbe(origin, verifyAdmin, { attempts = 2, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyAdmin(origin);
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(attempt * 1_500);
    }
  }
  throw lastError || new Error("Administrator smoke check failed");
}

async function revokeSmokeSession(origin, token, { attempts = 3, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(origin, "/api/auth/logout", {
        method: "POST",
        headers: { Origin: origin, Cookie: `__Host-ma-session=${token}` },
      });
      if (response.status !== 200 && isTransientSmokeStatus(response.status)) {
        throw Object.assign(new Error("Administrator logout returned a transient response"), {
          status: response.status,
          retryable: true,
        });
      }
      apiHeaders(response, "/api/auth/logout");
      const payload = await json(response, "/api/auth/logout");
      if (response.status !== 200 || payload?.saved !== true) {
        throw Object.assign(new Error("Administrator smoke session was not revoked"), {
          status: response.status,
          retryable: false,
        });
      }
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(attempt * 1_500);
    }
  }
  throw lastError || new Error("Administrator smoke session was not revoked");
}

export function validateDocumentExtractionEvidence(payload, fixture) {
  if (
    !payload ||
    payload.fileName !== fixture.name ||
    payload.mimeType !== fixture.mimeType ||
    payload.originalStored !== false ||
    typeof payload.text !== "string" ||
    !/Origin\s*Mind/iu.test(payload.text) ||
    payload.characters !== payload.text.length ||
    payload.characters < 10 ||
    (payload.tokens !== null && (!Number.isInteger(payload.tokens) || payload.tokens < 0))
  ) {
    throw new Error(`${fixture.mimeType} did not return verified transient extraction evidence`);
  }
  return {
    fileName: fixture.name,
    mimeType: fixture.mimeType,
    characters: payload.characters,
    originalStored: false,
  };
}

async function verifyDocumentExtractionRuntime(origin, token) {
  const evidence = [];
  for (const fixture of DOCUMENT_SMOKE_FIXTURES) {
    const response = await request(origin, "/api/admin/extract", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: `__Host-ma-session=${token}`,
        "Content-Type": fixture.mimeType,
        "X-File-Name": encodeURIComponent(fixture.name),
      },
      body: fixture.bytes,
      timeoutMilliseconds: 120_000,
    });
    if (response.status !== 200) {
      throw Object.assign(new Error(`${fixture.mimeType} extraction returned ${response.status}`), {
        status: response.status,
        retryable: isTransientSmokeStatus(response.status),
      });
    }
    apiHeaders(response, "/api/admin/extract");
    evidence.push(validateDocumentExtractionEvidence(
      await json(response, "/api/admin/extract"),
      fixture,
    ));
  }
  return { documentExtractionVerified: true, files: evidence };
}

async function verifySavedAdminPasswordRuntime(origin, password, { logoutAttempts = 3, sleepImpl = sleep } = {}) {
  const loginResponse = await request(origin, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const tokenMatch = /^__Host-ma-session=([a-f0-9]{64})(?:;|$)/u.exec(cookie);
  const validCookie = /^__Host-ma-session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=[1-9][0-9]*$/u.test(cookie);
  let documentExtraction;
  try {
    if (loginResponse.status !== 200 && isTransientSmokeStatus(loginResponse.status)) {
      throw Object.assign(new Error("Administrator login returned a transient response"), {
        status: loginResponse.status,
        retryable: false,
      });
    }
    apiHeaders(loginResponse, "/api/auth/login");
    const login = await json(loginResponse, "/api/auth/login");
    if (loginResponse.status !== 200 || login?.signedIn !== true) {
      throw Object.assign(new Error("The saved administrator password was not accepted"), {
        status: loginResponse.status,
        retryable: false,
      });
    }
    if (!validCookie) throw new Error("Administrator login did not return the expected session cookie");
    documentExtraction = await verifyDocumentExtractionRuntime(origin, tokenMatch[1]);
  } finally {
    if (tokenMatch) {
      await revokeSmokeSession(origin, tokenMatch[1], { attempts: logoutAttempts, sleepImpl });
    }
  }
  return documentExtraction;
}

export async function smokeAdminAuthentication(originValue, {
  verifyAdmin = verifyAdminPasswordRuntime,
  attempts = 2,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  await runAdminProbe(origin, verifyAdmin, { attempts, sleepImpl });
  return { adminKdfCompatible: true };
}

export async function smokeSavedAdminAuthentication(originValue, {
  environment = process.env,
  verifyAdmin = verifySavedAdminPasswordRuntime,
  logoutAttempts = 3,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  const password = environment.CHAT_ADMIN_PASSWORD;
  delete environment.CHAT_ADMIN_PASSWORD;
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("A valid saved administrator password is required");
  }
  const extraction = await verifyAdmin(origin, password, { logoutAttempts, sleepImpl });
  return {
    adminPasswordVerified: true,
    smokeSessionRevoked: true,
    ...(extraction && typeof extraction === "object" ? extraction : {}),
  };
}

export async function smokeCloudflare(originValue, {
  attempts = 12,
  releaseId,
  smokeAttempt = smokeOnce,
  verifyAdmin = verifyAdminPasswordRuntime,
  sleepImpl = sleep,
} = {}) {
  const origin = exactOrigin(originValue);
  const expectedReleaseId = expectedRelease(releaseId);
  let lastError;
  let evidence;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      evidence = await smokeAttempt(origin, expectedReleaseId);
      break;
    } catch (error) {
      lastError = error;
      const transient = error?.retryable === true || isTransientSmokeStatus(error?.status);
      if (!transient || attempt === attempts) break;
      await sleepImpl(Math.min(10_000, attempt * 1_500));
    }
  }
  if (!evidence) throw lastError || new Error("Cloudflare smoke check failed");
  await runAdminProbe(origin, verifyAdmin, { sleepImpl });
  return { ...evidence, adminKdfCompatible: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2];
  const operation = process.argv[3] === "--admin-auth-only"
    ? smokeAdminAuthentication(origin)
    : process.argv[3] === "--admin-saved-secret"
      ? smokeSavedAdminAuthentication(origin)
      : smokeCloudflare(origin, { releaseId: process.env.CHAT_RELEASE_ID });
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Cloudflare smoke check failed"}\n`);
      process.exitCode = 1;
    });
}
