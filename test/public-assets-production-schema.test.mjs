import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PUBLIC_ASSET_CONTEXT,
  collectPublicKnowledgeAssets,
  readPublicKnowledgeAsset,
} from "../lib/public-knowledge-assets.mjs";
import { createKnowledgeAssetToken } from "../src/knowledge-asset-token.mjs";

// Use deployed migration definitions, not an invented image table in a mock.
const directory = new URL("../drizzle/", import.meta.url);
const migrationNames = (await readdir(directory))
  .filter((name) => /^(002[6-9]|003[0-3])_.*\.sql$/u.test(name)).sort();
assert.equal(migrationNames.length, 8, "The production knowledge migration set changed; review this fixture");
const migrations = await Promise.all(migrationNames.map((name) => readFile(new URL(name, directory), "utf8")));
const secret = "A".repeat(43);
const id = "11111111-2222-4333-8444-555555555555";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZFEAAAAASUVORK5CYII=", "base64");
const defaultContent = "# 实验平台\n\n![小车正视与侧视](assets/figure1.png)\n\n平台集成激光雷达与相机。";
const htmlContent = '# 实验平台\n\n<img src="assets/figure1.png" style="width:4.18557in;height:2.3in" alt="差速轮式小车正视与侧视" />\n\n平台集成激光雷达与相机。';
const digest = (value) => createHash("sha256").update(value).digest("hex");
const ranked = [{
  id: "public-chunk-1", sectionTitle: "实验平台", score: 4,
  [PUBLIC_ASSET_CONTEXT]: { itemId: "fixture-item", revisionId: "fixture-revision", chunkNo: 1 },
}];

function fixture({ ready = true, approved = true, content = defaultContent } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE migration_control (freeze_id TEXT PRIMARY KEY, activated_at TEXT, deactivated_at TEXT)");
  for (const migration of migrations) sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_assets'").get(), undefined);
  assert(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_revision_assets'").get());
  sqlite.exec(`
    INSERT INTO knowledge_items
      (id,project,title,submitter_member_id,submitter_name,submitter_email,current_revision_no,current_revision_id,mutation_revision)
    VALUES ('fixture-item','ARTS Robotics','实验平台','fixture-author','测试作者','author@example.com',1,'fixture-revision','fixture-v1');
  `);
  sqlite.prepare(`
    INSERT INTO knowledge_revisions
      (id,item_id,revision_no,title,content,content_hash,created_by_member_id,created_by_name,created_by_email)
    VALUES ('fixture-revision','fixture-item',1,'实验平台',?,?,'fixture-author','测试作者','author@example.com')
  `).run(content, digest(content));
  sqlite.prepare(`
    INSERT INTO knowledge_revision_assets
      (id,item_id,revision_id,asset_path,storage_key,mime_type,byte_size,sha256,upload_token,upload_state)
    VALUES (?,'fixture-item','fixture-revision','assets/figure1.png','fixture/private/image','image/png',?,?,'fixture-upload','staged')
  `).run(id, png.length, digest(png));
  if (ready) sqlite.exec("UPDATE knowledge_revision_assets SET upload_state='ready' WHERE id='11111111-2222-4333-8444-555555555555'");
  if (approved) {
    sqlite.exec(`
      UPDATE knowledge_revisions SET status='active', reviewed_by_member_id='fixture-reviewer',
        reviewed_by_name='测试审核人', reviewed_by_email='reviewer@example.com',
        reviewed_at='2026-09-17T00:00:00Z', activated_at='2026-09-17T00:00:00Z'
      WHERE id='fixture-revision';
      UPDATE knowledge_items SET status='active', visibility='public', active_revision_id='fixture-revision'
      WHERE id='fixture-item';
    `);
  }
  sqlite.prepare(`
    INSERT INTO knowledge_chunks (id,item_id,revision_id,chunk_no,section_title,content,search_text,is_active)
    VALUES ('fixture-chunk','fixture-item','fixture-revision',1,'实验平台',?,?,?)
  `).run(content, content, approved ? 1 : 0);
  const sql = [];
  const database = { prepare(statement) {
    sql.push(statement);
    return { bind(...values) { return {
      all: async () => ({ results: sqlite.prepare(statement).all(...values) }),
      first: async () => sqlite.prepare(statement).get(...values) ?? null,
    }; } };
  } };
  const reads = [];
  const bucket = { get: async (key) => { reads.push(key); return { size: png.length, body: png }; } };
  return { sqlite, database, bucket, reads, sql };
}

test("production migrations allow a ready approved image to be discovered and read", async () => {
  const f = fixture();
  try {
    const discovered = await collectPublicKnowledgeAssets(ranked, f.database, secret);
    const images = discovered.get("public-chunk-1");
    assert.equal(images?.length, 1);
    assert.equal(images[0].alt, "小车正视与侧视");
    const response = await readPublicKnowledgeAsset(images[0].token, secret, f.database, f.bucket);
    assert.equal(response?.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control"), /no-store/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.deepEqual(f.reads, ["fixture/private/image"]);
    assert.equal(f.sql.filter((statement) => /FROM knowledge_revision_assets\s/u.test(statement)).length, 2);
  } finally { f.sqlite.close(); }
});

for (const [name, options] of [
  ["staged bytes", { ready: false }],
  ["pending approval", { approved: false }],
]) {
  test(`production schema does not disclose ${name}`, async () => {
    const f = fixture(options);
    try {
      const token = await createKnowledgeAssetToken(id, secret);
      assert.equal((await collectPublicKnowledgeAssets(ranked, f.database, secret)).size, 0);
      assert.equal(await readPublicKnowledgeAsset(token, secret, f.database, f.bucket), null);
      assert.equal(f.reads.length, 0);
    } finally { f.sqlite.close(); }
  });
}

test("explicit image retrieval can use a ready image elsewhere in the same approved revision", async () => {
  const f = fixture({ content: "OriginMind 实验室机器人产品与实验平台" });
  try {
    assert.equal((await collectPublicKnowledgeAssets(ranked, f.database, secret)).size, 0);
    const images = (await collectPublicKnowledgeAssets(ranked, f.database, secret, { includeRevisionImages: true })).get("public-chunk-1");
    assert.equal(images?.length, 1);
    assert.equal(images[0].alt, "figure1.png");
  } finally { f.sqlite.close(); }
});

test("production lifecycle revocation invalidates a previously issued image token", async () => {
  const f = fixture();
  try {
    const images = (await collectPublicKnowledgeAssets(ranked, f.database, secret)).get("public-chunk-1");
    f.sqlite.exec("UPDATE knowledge_items SET status='revoked',active_revision_id=NULL WHERE id='fixture-item'");
    assert.equal((await collectPublicKnowledgeAssets(ranked, f.database, secret)).size, 0);
    assert.equal(await readPublicKnowledgeAsset(images[0].token, secret, f.database, f.bucket), null);
    assert.equal(f.reads.length, 0);
  } finally { f.sqlite.close(); }
});

test("production schema rejects missing or inconsistent object bytes without changing stored metadata", async () => {
  const f = fixture();
  try {
    const images = (await collectPublicKnowledgeAssets(ranked, f.database, secret)).get("public-chunk-1");
    assert.equal(await readPublicKnowledgeAsset(images[0].token, secret, f.database, { get: async () => null }), null);
    assert.equal(await readPublicKnowledgeAsset(images[0].token, secret, f.database, {
      get: async () => ({ size: png.length + 1, body: png }),
    }), null);
  } finally { f.sqlite.close(); }
});

test("HTML image references reach the deployed image table and real response bytes", async () => {
  const f = fixture({ content: htmlContent });
  try {
    const images = (await collectPublicKnowledgeAssets(ranked, f.database, secret)).get("public-chunk-1");
    assert.equal(images?.length, 1);
    assert.equal(images[0].alt, "差速轮式小车正视与侧视");
    const response = await readPublicKnowledgeAsset(images[0].token, secret, f.database, f.bucket);
    assert.equal(response?.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    f.sqlite.exec("UPDATE knowledge_items SET status='revoked',active_revision_id=NULL WHERE id='fixture-item'");
    assert.equal(await readPublicKnowledgeAsset(images[0].token, secret, f.database, f.bucket), null);
  } finally { f.sqlite.close(); }
});

for (const options of [{ ready: false }, { approved: false }]) {
  test(`HTML syntax cannot bypass readiness or approval: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ ...options, content: htmlContent });
    try {
      assert.equal((await collectPublicKnowledgeAssets(ranked, f.database, secret)).size, 0);
      assert.equal(f.reads.length, 0);
    } finally { f.sqlite.close(); }
  });
}

