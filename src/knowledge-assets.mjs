import { OA_PUBLIC_RETRIEVE_URL, PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN, SECURITY_HEADERS } from "./constants.mjs";
import { KNOWLEDGE_ASSET_TOKEN_PATTERN, KNOWLEDGE_ASSET_MAX_BYTES, KNOWLEDGE_ASSET_MIMES, parseKnowledgeAssets } from "./knowledge-asset-token.mjs";
import { PublicError } from "./errors.mjs";
import { cleanPublicChatText } from "./public-text.mjs";

const ROBOT_IMAGE_KIND_PATTERN = /(?:四足|轮足|轮式|双臂|机械臂|开放式|人形|履带|无人机)/gu;
function imageDocumentScore(question, document) {
  const assets = parseKnowledgeAssets(document.assets || []);
  const haystack = `${document.title || ''}\n${document.body || ''}\n${assets.map(asset => asset.alt).join('\n')}`.normalize('NFKC');
  const kinds = [...new Set(String(question || '').normalize('NFKC').match(ROBOT_IMAGE_KIND_PATTERN) || [])];
  if (kinds.length && !kinds.every(kind => haystack.includes(kind))) return -10_000;
  let score = 0;
  if (/(?:OriginMind|ARTS\s*Robotics|机器人产品|实验平台)/iu.test(haystack)) score += 500;
  if (/(?:实验室|机器人)/u.test(haystack)) score += 120;
  if (/(?:硕士.{0,8}论文|博士.{0,8}论文|论文封面|论文算法|公式|示意图|算法框图)/u.test(haystack)) score -= 500;
  if (assets.length) score += 80;
  const updated = Date.parse(document.updatedAt || '');
  if (Number.isFinite(updated)) score += updated / 1e11;
  return score;
}
export function chatKnowledgeImages(documents, question = '') {
  const images = [];
  const seen = new Set();
  const ranked = question
    ? documents.map(document => ({ document, score: imageDocumentScore(question, document) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 1).map(item => item.document)
    : documents;
  for (const document of ranked) {
    for (const asset of parseKnowledgeAssets(document.assets || [])) {
      if (seen.has(asset.token)) continue;
      seen.add(asset.token);
      images.push({ url: `/api/knowledge/assets/${asset.token}`, mimeType: asset.mimeType, alt: cleanPublicChatText(asset.alt) || "资料插图" });
      if (images.length === 4) return images;
    }
  }
  return images;
}

function validSignature(bytes, mime) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (mime === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mime === "image/webp" && bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

export async function proxyKnowledgeAsset(context, token) {
  if (!KNOWLEDGE_ASSET_TOKEN_PATTERN.test(token) || new URL(context.request.url).search) throw new PublicError("知识图片不存在。", 404);
  const serviceToken = context.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(serviceToken)) throw new PublicError("知识图片暂不可用。", 503);
  const url = new URL(`/api/public/lab-ai/assets/${token}`, OA_PUBLIC_RETRIEVE_URL).href;
  const init = {
    method: "GET", headers: { "x-originmind-public-lab-ai-service-token": serviceToken },
    redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(12_000),
  };
  const service = context.env.OA_SERVICE;
  const response = typeof service?.fetch === "function"
    ? await service.fetch(new Request(url, init)) : await context.runtime.fetch(url, init);
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const length = Number(response.headers.get("content-length") || 0);
  if (response.status === 404) throw new PublicError("知识图片不存在或已撤回。", 404);
  if (response.status !== 200 || !KNOWLEDGE_ASSET_MIMES.has(mime) || !Number.isSafeInteger(length) || length < 0 || length > KNOWLEDGE_ASSET_MAX_BYTES) {
    await response.body?.cancel();
    throw new PublicError("知识图片暂不可用。", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PublicError("知识图片暂不可用。", 502);
  const pieces = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > KNOWLEDGE_ASSET_MAX_BYTES) throw new Error("IMAGE_SIZE");
      pieces.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new PublicError("知识图片暂不可用。", 502);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length; }
  if (!validSignature(bytes, mime) || (length && total !== length)) throw new PublicError("知识图片暂不可用。", 502);
  return new Response(bytes, { headers: {
    ...SECURITY_HEADERS,
    "content-type": mime, "content-length": String(total),
    "Cache-Control": "private, no-store, max-age=0",
    "cross-origin-resource-policy": "same-origin", "Referrer-Policy": "no-referrer",
  } });
}

