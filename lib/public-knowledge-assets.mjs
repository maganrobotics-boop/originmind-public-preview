import {
  createKnowledgeAssetToken, readKnowledgeAssetToken,
  KNOWLEDGE_ASSET_MAX_BYTES, KNOWLEDGE_ASSET_MIMES,
} from "../src/knowledge-asset-token.mjs";
import { cleanPublicChatText } from "../src/public-text.mjs";
import { knowledgeImageReferences } from "./knowledge-image-references.mjs";

// Enumerable symbols survive the ranking object's spread, but never JSON serialization.
export const PUBLIC_ASSET_CONTEXT = Symbol("publicKnowledgeAssetContext");

function imageReferences(content) {
  const result = new Map();
  for (const [path, description] of knowledgeImageReferences(content)) {
    const alt = cleanPublicChatText(description).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    result.set(path, Array.from(alt || "资料插图").slice(0, 60).join(""));
  }
  return result;
}

/** Attach ready images from the active approved public revision. Unreferenced
 * revision images are considered only for an explicit image request. */
export async function collectPublicKnowledgeAssets(ranked, database, secret, { includeRevisionImages = false } = {}) {
  const output = new Map();
  const seen = new Set();
  for (const chunk of ranked.slice(0, includeRevisionImages ? 12 : 6)) {
    if (seen.size >= 4) break;
    const context = chunk[PUBLIC_ASSET_CONTEXT];
    if (!context || typeof context.itemId !== "string" || typeof context.revisionId !== "string" ||
        !Number.isSafeInteger(context.chunkNo)) continue;
    const nearby = await database.prepare(`
      SELECT c.content, c.chunk_no, c.section_title FROM knowledge_chunks c
      JOIN knowledge_items i ON i.id = c.item_id
      JOIN knowledge_revisions r ON r.id = c.revision_id AND r.item_id = i.id
      WHERE c.item_id = ? AND c.revision_id = ? AND c.chunk_no BETWEEN ? AND ?
        AND c.is_active = 1 AND i.status = 'active' AND i.visibility = 'public'
        AND r.status = 'active' AND i.active_revision_id = c.revision_id
      ORDER BY abs(c.chunk_no - ?) ASC, c.chunk_no ASC LIMIT 3
    `).bind(context.itemId, context.revisionId, context.chunkNo - 1, context.chunkNo + 1, context.chunkNo).all();
    const references = new Map();
    for (const row of nearby.results || []) {
      if (row.chunk_no !== context.chunkNo && row.section_title !== chunk.sectionTitle) continue;
      for (const [path, alt] of imageReferences(row.content)) if (!references.has(path)) references.set(path, alt);
    }
    const assets = await database.prepare(`
      SELECT a.id, a.asset_path, a.mime_type, a.byte_size FROM knowledge_revision_assets a
      JOIN knowledge_items i ON i.id = a.item_id
      JOIN knowledge_revisions r ON r.id = a.revision_id AND r.item_id = i.id
      WHERE a.item_id = ? AND a.revision_id = ? AND a.upload_state = 'ready'
        AND i.status = 'active' AND i.visibility = 'public' AND r.status = 'active'
        AND i.active_revision_id = a.revision_id ORDER BY a.asset_path ASC LIMIT 128
    `).bind(context.itemId, context.revisionId).all();
    if (includeRevisionImages && !references.size) {
      for (const asset of assets.results || []) references.set(asset.asset_path, asset.asset_path.split('/').at(-1) || '资料插图');
    }
    if (!references.size) continue;
    const selected = [];
    // Source order, not lexical asset filename order, decides which figures are shown.
    for (const [path, alt] of references) {
      const asset = (assets.results || []).find((item) => item.asset_path === path);
      if (!asset || seen.has(asset.id) || !KNOWLEDGE_ASSET_MIMES.has(asset.mime_type) ||
          !Number.isSafeInteger(asset.byte_size) || asset.byte_size < 1 || asset.byte_size > KNOWLEDGE_ASSET_MAX_BYTES) continue;
      selected.push({ token: await createKnowledgeAssetToken(asset.id, secret), mimeType: asset.mime_type, alt });
      seen.add(asset.id);
      if (selected.length >= 2 || seen.size >= 4) break;
    }
    if (selected.length) output.set(chunk.id, selected);
  }
  return output;
}

/** No-store and current-state checks ensure a revoked/old revision cannot be served. */
export async function readPublicKnowledgeAsset(token, secret, database, bucket) {
  const capability = await readKnowledgeAssetToken(token, secret);
  if (!capability) return null;
  const row = await database.prepare(`
    SELECT a.storage_key, a.mime_type, a.byte_size FROM knowledge_revision_assets a
    JOIN knowledge_items i ON i.id = a.item_id
    JOIN knowledge_revisions r ON r.id = a.revision_id AND r.item_id = i.id
    WHERE a.id = ? AND a.upload_state = 'ready' AND i.status = 'active'
      AND i.visibility = 'public' AND r.status = 'active' AND i.active_revision_id = a.revision_id
      AND NOT EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL)
    LIMIT 1
  `).bind(capability.assetId).first();
  if (!row || !KNOWLEDGE_ASSET_MIMES.has(row.mime_type) || !Number.isSafeInteger(row.byte_size) ||
      row.byte_size < 1 || row.byte_size > KNOWLEDGE_ASSET_MAX_BYTES || typeof row.storage_key !== "string") return null;
  const object = await bucket.get(row.storage_key);
  if (!object || object.size !== row.byte_size || !object.body) return null;
  return new Response(object.body, { headers: {
    "content-type": row.mime_type,
    "content-length": String(row.byte_size),
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  } });
}

