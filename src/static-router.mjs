export const CANONICAL_ORIGIN = "https://chat.omindos.ai";

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' https://oa.omindos.ai; font-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
});

export const RouteKind = Object.freeze({
  SHELL: "shell",
  REDIRECT_HOME: "redirect-home",
  REDIRECT_MANAGE: "redirect-manage",
  REDIRECT_TOPIC: "redirect-topic",
  DYNAMIC: "dynamic",
  ASSET: "asset",
  NOT_FOUND: "not-found",
});

const TOPIC_PATHS = ["/technology", "/research", "/originmind", "/ius"];
const SHELL_PATHS = new Set(["/", "/manage", ...TOPIC_PATHS]);
const TOPIC_TRAILING_REDIRECTS = new Map(
  TOPIC_PATHS.map((pathname) => [`${pathname}/`, pathname]),
);
const DIRECT_ASSET_PATHS = new Set([
  "/favicon.svg",
  "/LICENSES.md",
  "/manifest.webmanifest",
  "/service-worker.js",
  "/zip-import-addon.js",
]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function classifyPath(pathname) {
  if (SHELL_PATHS.has(pathname)) return RouteKind.SHELL;
  if (pathname === "/index.html") return RouteKind.REDIRECT_HOME;
  if (pathname === "/manage/") return RouteKind.REDIRECT_MANAGE;
  if (TOPIC_TRAILING_REDIRECTS.has(pathname)) return RouteKind.REDIRECT_TOPIC;
  if (pathname === "/_health" || pathname.startsWith("/api/")) {
    return RouteKind.DYNAMIC;
  }
  if (pathname.startsWith("/assets/") || DIRECT_ASSET_PATHS.has(pathname)) {
    return RouteKind.ASSET;
  }
  return RouteKind.NOT_FOUND;
}

export function hardenResponse(response, cacheControl = "no-store") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function methodNotAllowed() {
  return hardenResponse(
    new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    }),
  );
}

function redirect(request, pathname) {
  if (!SAFE_METHODS.has(request.method)) return methodNotAllowed();
  const location = new URL(pathname, request.url);
  return hardenResponse(Response.redirect(location, 308));
}

function assetRequest(request, pathname) {
  const headers = new Headers();
  for (const name of ["if-modified-since", "if-none-match", "range"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(new URL(pathname, CANONICAL_ORIGIN), {
    method: request.method,
    headers,
  });
}

function assetCacheControl(pathname) {
  if (pathname === "/service-worker.js") {
    return "no-cache, no-store, must-revalidate";
  }
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

async function fetchAsset(request, env, pathname, cacheControl) {
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== "function") {
    throw new TypeError("ASSETS binding is required");
  }
  const response = await env.ASSETS.fetch(assetRequest(request, pathname));
  return hardenResponse(response, response.ok ? cacheControl : "no-store");
}

/**
 * Handles the static portion of the Worker.
 *
 * Returns null only for /api/* and /_health so the caller can invoke the
 * migrated application handler and then wrap its response with
 * hardenResponse(). Every other path receives a complete response here.
 */
export async function routeStaticRequest(request, env) {
  const url = new URL(request.url);
  const kind = classifyPath(url.pathname);

  if (kind === RouteKind.DYNAMIC) return null;

  if (kind === RouteKind.REDIRECT_HOME) return redirect(request, "/");
  if (kind === RouteKind.REDIRECT_MANAGE) return redirect(request, "/manage");
  if (kind === RouteKind.REDIRECT_TOPIC) {
    return redirect(request, TOPIC_TRAILING_REDIRECTS.get(url.pathname));
  }

  if (kind === RouteKind.SHELL) {
    if (!SAFE_METHODS.has(request.method)) return methodNotAllowed();
    return fetchAsset(request, env, "/index.html", "no-store");
  }

  if (kind === RouteKind.ASSET) {
    if (!SAFE_METHODS.has(request.method)) return methodNotAllowed();
    return fetchAsset(request, env, url.pathname, assetCacheControl(url.pathname));
  }

  return hardenResponse(
    new Response("Page not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}
