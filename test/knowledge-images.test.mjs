import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createKnowledgeAssetToken, readKnowledgeAssetToken, parseKnowledgeAssets } from "../src/knowledge-asset-token.mjs";
import { PUBLIC_ASSET_CONTEXT, collectPublicKnowledgeAssets, readPublicKnowledgeAsset } from "../lib/public-knowledge-assets.mjs";
import { chatKnowledgeImages, proxyKnowledgeAsset } from "../src/knowledge-assets.mjs";
import { parseOaResult, retrieveOa } from "../src/oa-public.mjs";

const secret = "A".repeat(43);
const assetId = "11111111-2222-4333-8444-555555555555";
const png = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
const chunk = () => ({
  id: "public-chunk-1", itemId: "public-item-1", revisionId: "public-revision-1",
  sectionTitle: "实验平台", title: "差速小车平台", category: "research", paragraphRef: "第 1 段",
  excerpt: "平台集成激光雷达和相机。", sourceLabel: "公开资料", updatedAt: "2026-09-17",
  [PUBLIC_ASSET_CONTEXT]: { itemId: "private-item", revisionId: "private-revision", chunkNo: 2 },
});
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE knowledge_items (id TEXT, status TEXT, visibility TEXT, active_revision_id TEXT);
    CREATE TABLE knowledge_revisions (id TEXT, item_id TEXT, status TEXT);
    CREATE TABLE knowledge_chunks (item_id TEXT, revision_id TEXT, chunk_no INTEGER, content TEXT, section_title TEXT, is_active INTEGER);
    CREATE TABLE knowledge_revision_assets (id TEXT, item_id TEXT, revision_id TEXT, asset_path TEXT, mime_type TEXT, byte_size INTEGER, storage_key TEXT, upload_state TEXT);
    CREATE TABLE migration_control (deactivated_at TEXT);
    INSERT INTO knowledge_items VALUES ('private-item','active','public','private-revision');
    INSERT INTO knowledge_revisions VALUES ('private-revision','private-item','active');
    INSERT INTO knowledge_chunks VALUES ('private-item','private-revision',2,'![小车正视与侧视](assets/figure1.png)','实验平台',1);
  `);
  sqlite.prepare("INSERT INTO knowledge_revision_assets VALUES (?, 'private-item','private-revision','assets/figure1.png','image/png',?,'private/r2/key','ready')").run(assetId, png.length);
  const database = { prepare(sql) {
    return { bind(...bindings) { return {
      all: async () => ({ results: sqlite.prepare(sql).all(...bindings) }),
      first: async () => sqlite.prepare(sql).get(...bindings) ?? null,
    }; } };
  } };
  const reads = [];
  const bucket = { get: async (key) => { reads.push(key); return { size: png.length, body: png }; } };
  return { sqlite, database, bucket, reads };
}

test("public image capability is randomized, encrypted, expiring and bound to the service secret", async () => {
  const now = 1789610400000;
  const token = await createKnowledgeAssetToken(assetId, secret, now);
  assert.notEqual(token, await createKnowledgeAssetToken(assetId, secret, now));
  assert.doesNotMatch(token, /private|11111111|2222|figure1/u);
  assert.deepEqual(await readKnowledgeAssetToken(token, secret, now), { assetId });
  assert.equal(await readKnowledgeAssetToken(token, "B".repeat(43), now), null);
  assert.equal(await readKnowledgeAssetToken(token, secret, now + 7 * 86400000), null);
  assert.equal(await readKnowledgeAssetToken(token.slice(0, 30) + (token[30] === "A" ? "B" : "A") + token.slice(31), secret, now), null);
  for (const malformed of ["", "../key", "data:image/png;base64,a", token + "?x=1"]) {
    assert.equal(await readKnowledgeAssetToken(malformed, secret, now), null);
  }
});

test("ranked context survives spread while public JSON contains no real IDs or R2 paths", async () => {
  const f = fixture();
  try {
    const ranked = [{ ...chunk(), score: 3 }];
    const assets = await collectPublicKnowledgeAssets(ranked, f.database, secret);
    assert.equal(assets.get(ranked[0].id).length, 1);
    const json = JSON.stringify({ ...ranked[0], assets: assets.get(ranked[0].id) });
    assert.doesNotMatch(json, /private-item|private-revision|private\/r2|asset_path|storage_key/u);
    const descriptor = assets.get(ranked[0].id)[0];
    assert.deepEqual(Object.keys(descriptor).sort(), ["alt", "mimeType", "token"]);
    assert.equal(descriptor.alt, "小车正视与侧视");
    assert.deepEqual(await readKnowledgeAssetToken(descriptor.token, secret), { assetId });
  } finally { f.sqlite.close(); }
});

for (const [name, mutation] of [
  ["revoked item", "UPDATE knowledge_items SET status='revoked'"],
  ["internal item", "UPDATE knowledge_items SET visibility='internal'"],
  ["pending revision", "UPDATE knowledge_revisions SET status='pending'"],
  ["superseded revision", "UPDATE knowledge_items SET active_revision_id='new-revision'"],
  ["unfinished upload", "UPDATE knowledge_revision_assets SET upload_state='staged'"],
]) {
  test(`image discovery and an already issued token both reject ${name}`, async () => {
    const f = fixture();
    try {
      const token = await createKnowledgeAssetToken(assetId, secret);
      f.sqlite.exec(mutation);
      assert.equal((await collectPublicKnowledgeAssets([chunk()], f.database, secret)).size, 0);
      assert.equal(await readPublicKnowledgeAsset(token, secret, f.database, f.bucket), null);
      assert.equal(f.reads.length, 0);
    } finally { f.sqlite.close(); }
  });
}

test("public asset reads recheck migration freeze and current byte metadata, never cache", async () => {
  const f = fixture();
  try {
    const token = await createKnowledgeAssetToken(assetId, secret);
    const first = await readPublicKnowledgeAsset(token, secret, f.database, f.bucket);
    assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), png);
    f.sqlite.exec("INSERT INTO migration_control VALUES (NULL)");
    assert.equal(await readPublicKnowledgeAsset(token, secret, f.database, f.bucket), null);
    f.sqlite.exec("DELETE FROM migration_control; UPDATE knowledge_revision_assets SET byte_size=12");
    assert.equal(await readPublicKnowledgeAsset(token, secret, f.database, f.bucket), null);
  } finally { f.sqlite.close(); }
});

test("discovery excludes unreferenced and traversal image paths; adjacent sections are not mixed", async () => {
  const f = fixture();
  try {
    f.sqlite.exec("UPDATE knowledge_chunks SET content='![bad](assets/../figure1.png) ![external](https://evil.test/a.png)'; INSERT INTO knowledge_chunks VALUES ('private-item','private-revision',3,'![其他图](assets/figure1.png)','不同实验',1)");
    assert.equal((await collectPublicKnowledgeAssets([chunk()], f.database, secret)).size, 0);
    f.sqlite.exec("UPDATE knowledge_chunks SET section_title='实验平台' WHERE chunk_no=3");
    const found = await collectPublicKnowledgeAssets([chunk(), { ...chunk(), id: 'public-chunk-2' }], f.database, secret);
    assert.equal(found.size, 1);
    assert.equal(found.get('public-chunk-1')[0].alt, '其他图');
  } finally { f.sqlite.close(); }
});

test("retrieval contract accepts optional images but rejects arbitrary keys, paths and excess images", async () => {
  const token = await createKnowledgeAssetToken(assetId, secret);
  const item = chunk();
  delete item[PUBLIC_ASSET_CONTEXT]; delete item.itemId; delete item.revisionId; item.id = "1";
  assert.equal(parseOaResult({ chunks: [item] }).length, 1);
  const descriptor = { token, mimeType: "image/png", alt: "机器人平台" };
  const enriched = { ...item, assets: [descriptor] };
  assert.equal(parseOaResult({ chunks: [enriched] })[0].assets[0].token, token);
  assert.throws(() => parseOaResult({ chunks: [{ ...enriched, assets: [{ ...descriptor, storageKey: "private" }] }] }));
  assert.throws(() => parseKnowledgeAssets([{ ...descriptor, token: "../assets/a.png" }]));
  assert.throws(() => parseKnowledgeAssets([descriptor, descriptor, descriptor]));
  const context = { env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret }, runtime: { fetch: async () => Response.json({ chunks: [enriched] }) } };
  const retrieved = await retrieveOa("机器人平台", context);
  assert.equal(retrieved.documents[0].assets[0].token, token);
  assert.equal(chatKnowledgeImages(retrieved.documents)[0].url, `/api/knowledge/assets/${token}`);
});

test("same-origin image proxy uses only fixed OA binding plus service credential and verified bytes", async () => {
  const token = await createKnowledgeAssetToken(assetId, secret);
  let upstream;
  const context = { request: new Request(`https://chat.omindos.ai/api/knowledge/assets/${token}`, {
    headers: { cookie: "private-user-session", authorization: "private-user-auth" },
  }), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret, OA_SERVICE: { fetch: async (request) => {
    upstream = request;
    return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length), "set-cookie": "NEVER_FORWARD" } });
  } } }, runtime: { fetch: async () => { throw new Error("network fallback forbidden"); } } };
  const response = await proxyKnowledgeAsset(context, token);
  assert.equal(new URL(upstream.url).origin, "https://oa.omindos.ai");
  assert.equal(upstream.headers.get("cookie"), null);
  assert.equal(upstream.headers.get("authorization"), null);
  assert.equal(upstream.headers.get("x-originmind-public-lab-ai-service-token"), secret);
  assert.equal(upstream.redirect, "manual");
  assert.equal(upstream.credentials, "omit");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

for (const [name, response] of [
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })],
  ["HTML", () => new Response("<html>not an image</html>", { headers: { "content-type": "text/html" } })],
  ["mislabeled SVG", () => new Response("<svg onload='alert(1)'/>", { headers: { "content-type": "image/png" } })],
  ["oversized declared body", () => new Response(png, { headers: { "content-type": "image/png", "content-length": "99999999" } })],
  ["wrong byte length", () => new Response(png, { headers: { "content-type": "image/png", "content-length": "12" } })],
]) {
  test(`public image proxy refuses ${name}`, async () => {
    const token = await createKnowledgeAssetToken(assetId, secret);
    const context = { request: new Request(`https://chat.omindos.ai/api/knowledge/assets/${token}`), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret }, runtime: { fetch: async () => response() } };
    await assert.rejects(() => proxyKnowledgeAsset(context, token));
  });
}

test("public image proxy bounds a chunked response without Content-Length", async () => {
  const token = await createKnowledgeAssetToken(assetId, secret);
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const context = { request: new Request(`https://chat.omindos.ai/api/knowledge/assets/${token}`), env: { PUBLIC_LAB_AI_SERVICE_TOKEN: secret }, runtime: { fetch: async () => new Response(stream, { headers: { "content-type": "image/png" } }) } };
  await assert.rejects(() => proxyKnowledgeAsset(context, token));
  assert.equal(cancelled, true);
});

test("browser renders only structured same-origin assets and preserves them across a history restore", async () => {
  const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    addEventListener(k, fn) { this.listeners[k] = fn; }
  }
  const api = runInNewContext(`
    ${slice("function cleanPublicChatText", "function knowledgeSuggestionsFromPayload")}
    ${slice("function element(", "function icon(")}
    ${slice("function referenceSectionStart", "function serviceLabel")}
    ({ validatedKnowledgeImages, renderKnowledgeImages, writeChatHistory, readChatHistory });
  `, { document: { createElement: (tag) => new Element(tag), createTextNode: (text) => text }, Node: Element });
  const token = await createKnowledgeAssetToken(assetId, secret);
  const image = { url: `/api/knowledge/assets/${token}`, mimeType: "image/png", alt: "小车 <script>NOT_EXECUTED</script>" };
  for (const bad of ["https://evil.test/a.png", "//evil.test/a", "data:image/png,a", `/api/knowledge/assets/${token}?leak=1`, "/api/knowledge/assets/../private"]) {
    assert.equal(api.validatedKnowledgeImages([{ ...image, url: bad }]).length, 0);
  }
  const gallery = api.renderKnowledgeImages([image]);
  assert.equal(gallery.children[0].children[0].attributes.src, image.url);
  assert.equal(gallery.children[0].children[0].attributes.referrerpolicy, "no-referrer");
  const img = gallery.children[0].children[0];
  img.listeners.error();
  assert.equal(img.hidden, true);
  assert.match(gallery.children[0].children[1].textContent, /已失效、撤回/u);
  const records = new Map();
  const storage = { getItem: (k) => records.get(k), setItem: (k,v) => records.set(k,v), removeItem: (k) => records.delete(k) };
  const now = Date.now();
  const session = { messages: [{ role: "user", content: "展示平台" }, { role: "assistant", content: "平台原图如下。", images: [image] }], draft: "", tokenSavedAt: now };
  assert.equal(api.writeChatHistory(storage, "general", session, now), true);
  assert.equal(api.readChatHistory(storage, "general", now + 1).messages[1].images[0].url, image.url);
});
