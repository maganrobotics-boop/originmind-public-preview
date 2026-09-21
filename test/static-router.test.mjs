import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_ORIGIN,
  RouteKind,
  SECURITY_HEADERS,
  classifyPath,
  hardenResponse,
  routeStaticRequest,
} from "../src/static-router.mjs";

const TOPIC_PATHS = ["/technology", "/research", "/originmind", "/ius"];

function mockEnvironment() {
  const calls = [];
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(request) {
          const url = new URL(request.url);
          calls.push({
            method: request.method,
            pathname: url.pathname,
            origin: url.origin,
            ifNoneMatch: request.headers.get("if-none-match"),
          });
          const known = new Set([
            "/index.html",
            "/favicon.svg",
            "/LICENSES.md",
            "/manifest.webmanifest",
            "/service-worker.js",
            "/zip-import-addon.js",
            "/assets/app-0123456789abcdef.js",
            "/assets/styles-0123456789abcdef.css",
            "/assets/pwa/icon-192-v1.png",
          ]);
          if (!known.has(url.pathname)) {
            return new Response("missing", { status: 404 });
          }
          const body = request.method === "HEAD" ? null : `asset:${url.pathname}`;
          return new Response(body, {
            headers: {
              "Content-Type": url.pathname.endsWith(".html")
                ? "text/html; charset=utf-8"
                : "application/octet-stream",
              ETag: '"asset-etag"',
            },
          });
        },
      },
    },
  };
}

function assertHardened(response, cacheControl = "no-store") {
  assert.equal(response.headers.get("cache-control"), cacheControl);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test("path classifier is exact and does not turn unknown paths into the SPA", () => {
  assert.equal(classifyPath("/"), RouteKind.SHELL);
  assert.equal(classifyPath("/manage"), RouteKind.SHELL);
  for (const pathname of TOPIC_PATHS) {
    assert.equal(classifyPath(pathname), RouteKind.SHELL, pathname);
    assert.equal(classifyPath(`${pathname}/`), RouteKind.REDIRECT_TOPIC, `${pathname}/`);
  }
  assert.equal(classifyPath("/manage/"), RouteKind.REDIRECT_MANAGE);
  assert.equal(classifyPath("/manage/extra"), RouteKind.NOT_FOUND);
  assert.equal(classifyPath("/%6Danage"), RouteKind.NOT_FOUND);
  assert.equal(classifyPath("/index.html"), RouteKind.REDIRECT_HOME);
  assert.equal(classifyPath("/_health"), RouteKind.DYNAMIC);
  assert.equal(classifyPath("/api/status"), RouteKind.DYNAMIC);
  assert.equal(classifyPath("/api"), RouteKind.NOT_FOUND);
  assert.equal(classifyPath("/assets/app.js"), RouteKind.ASSET);
  assert.equal(classifyPath("/favicon.svg"), RouteKind.ASSET);
  assert.equal(classifyPath("/LICENSES.md"), RouteKind.ASSET);
  assert.equal(classifyPath("/manifest.webmanifest"), RouteKind.ASSET);
  assert.equal(classifyPath("/service-worker.js"), RouteKind.ASSET);
  assert.equal(classifyPath("/zip-import-addon.js"), RouteKind.ASSET);
  assert.equal(classifyPath("/unknown"), RouteKind.NOT_FOUND);
});

test("public topic links and exact /manage serve the same non-cacheable shell", async () => {
  const { env, calls } = mockEnvironment();
  const shellPaths = ["/", ...TOPIC_PATHS, "/research?from=mobile", "/manage", "/manage?tab=model"];
  for (const path of shellPaths) {
    const response = await routeStaticRequest(
      new Request(`https://chat.omindos.ai${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "asset:/index.html");
    assertHardened(response);
  }
  assert.deepEqual(
    calls.map((call) => call.pathname),
    shellPaths.map(() => "/index.html"),
  );
  assert.ok(calls.every((call) => call.origin === CANONICAL_ORIGIN));
});

test("HEAD is preserved when retrieving the shell", async () => {
  const { env, calls } = mockEnvironment();
  const response = await routeStaticRequest(
    new Request("https://chat.omindos.ai/originmind", { method: "HEAD" }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(calls[0].method, "HEAD");
  assertHardened(response);
});

test("canonical redirects preserve the request hostname for safe previews", async () => {
  const { env } = mockEnvironment();
  const manage = await routeStaticRequest(
    new Request("https://preview.example/manage/?tab=model"),
    env,
  );
  assert.equal(manage.status, 308);
  assert.equal(manage.headers.get("location"), "https://preview.example/manage");
  assertHardened(manage);

  const index = await routeStaticRequest(
    new Request("https://preview.example/index.html"),
    env,
  );
  assert.equal(index.status, 308);
  assert.equal(index.headers.get("location"), "https://preview.example/");
  assertHardened(index);

  for (const pathname of TOPIC_PATHS) {
    const response = await routeStaticRequest(
      new Request(`https://preview.example${pathname}/?source=shared`),
      env,
    );
    assert.equal(response.status, 308, pathname);
    assert.equal(response.headers.get("location"), `https://preview.example${pathname}`);
    assertHardened(response);
  }
});

test("dynamic endpoints are delegated and never receive the HTML shell", async () => {
  const { env, calls } = mockEnvironment();
  for (const path of [
    "/_health",
    "/api/status",
    "/api/chat",
    "/api/auth/status",
    "/api/admin/config",
  ]) {
    assert.equal(
      await routeStaticRequest(new Request(`https://chat.omindos.ai${path}`), env),
      null,
    );
  }
  assert.equal(calls.length, 0);
});

test("unknown paths return hardened 404 responses", async () => {
  const { env, calls } = mockEnvironment();
  for (const path of [
    "/unknown",
    "/manage/extra",
    "/technology/extra",
    "/Technology",
    "/%74echnology",
    "/api",
    "/%6Danage",
  ]) {
    const response = await routeStaticRequest(
      new Request(`https://chat.omindos.ai${path}`),
      env,
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Page not found");
    assertHardened(response);
  }
  assert.equal(calls.length, 0);
});

test("unsafe methods cannot retrieve the shell or static assets", async () => {
  const { env, calls } = mockEnvironment();
  for (const path of [
    "/",
    ...TOPIC_PATHS,
    "/technology/",
    "/manage",
    "/manage/",
    "/favicon.svg",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/zip-import-addon.js",
  ]) {
    const response = await routeStaticRequest(
      new Request(`https://chat.omindos.ai${path}`, { method: "POST" }),
      env,
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assertHardened(response);
  }
  assert.equal(calls.length, 0);
});

test("hashed assets are immutable while auxiliary assets use a short TTL", async () => {
  const { env, calls } = mockEnvironment();
  const script = await routeStaticRequest(
    new Request("https://chat.omindos.ai/assets/app-0123456789abcdef.js", {
      headers: { "If-None-Match": '"asset-etag"' },
    }),
    env,
  );
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("etag"), '"asset-etag"');
  assertHardened(script, "public, max-age=31536000, immutable");
  assert.equal(calls[0].ifNoneMatch, '"asset-etag"');

  const icon = await routeStaticRequest(
    new Request("https://chat.omindos.ai/assets/pwa/icon-192-v1.png"),
    env,
  );
  assert.equal(icon.status, 200);
  assertHardened(icon, "public, max-age=31536000, immutable");

  for (const path of ["/favicon.svg", "/LICENSES.md", "/manifest.webmanifest", "/zip-import-addon.js"]) {
    const response = await routeStaticRequest(
      new Request(`https://chat.omindos.ai${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assertHardened(response, "public, max-age=3600");
  }

  const serviceWorker = await routeStaticRequest(
    new Request("https://chat.omindos.ai/service-worker.js"),
    env,
  );
  assert.equal(serviceWorker.status, 200);
  assertHardened(serviceWorker, "no-cache, no-store, must-revalidate");
});

test("missing files under /assets are not cached as immutable", async () => {
  const { env } = mockEnvironment();
  const response = await routeStaticRequest(
    new Request("https://chat.omindos.ai/assets/missing.js"),
    env,
  );
  assert.equal(response.status, 404);
  assertHardened(response);
});

test("hardenResponse preserves a session cookie while preventing caching", () => {
  const response = hardenResponse(
    new Response("ok", {
      headers: {
        "Set-Cookie":
          "__Host-ma-session=test; Path=/; Secure; HttpOnly; SameSite=Strict",
      },
    }),
  );
  assert.equal(
    response.headers.get("set-cookie"),
    "__Host-ma-session=test; Path=/; Secure; HttpOnly; SameSite=Strict",
  );
  assertHardened(response);
});

test("the helper fails closed when the ASSETS binding is absent", async () => {
  await assert.rejects(
    routeStaticRequest(new Request("https://chat.omindos.ai/"), {}),
    /ASSETS binding is required/,
  );
});
