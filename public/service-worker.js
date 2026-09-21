"use strict";

const CACHE_PREFIX = "originmind-versioned-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const VERSIONED_ASSET_PATH = /^\/assets\/(?:app-[a-f0-9]{16}\.js|katex-[a-f0-9]{16}\.mjs|styles-[a-f0-9]{16}\.css|pwa\/[a-z0-9-]+-v[0-9]+\.png)$/u;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.search ||
    !VERSIONED_ASSET_PATH.test(url.pathname)
  ) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
