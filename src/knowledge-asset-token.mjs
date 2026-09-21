/** Public image capabilities hide OA identifiers. Authorization is rechecked on every read. */
export const KNOWLEDGE_ASSET_TOKEN_PATTERN = /^v1_[A-Za-z0-9_-]{80,320}$/u;
export const KNOWLEDGE_ASSET_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const KNOWLEDGE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
const ASSET_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const PURPOSE = "OriginMind/OA/public-knowledge-image/v1";

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value) {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function key(secret) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error("PUBLIC_IMAGE_UNAVAILABLE");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${PURPOSE}\n${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createKnowledgeAssetToken(assetId, secret, now = Date.now()) {
  if (!ASSET_ID.test(assetId) || !Number.isFinite(now)) throw new Error("PUBLIC_IMAGE_UNAVAILABLE");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = encoder.encode(JSON.stringify({ id: assetId, exp: Math.floor(now / 1000) + TTL_SECONDS }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(PURPOSE) }, await key(secret), body,
  ));
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv); bytes.set(encrypted, iv.length);
  return `v1_${base64url(bytes)}`;
}

export async function readKnowledgeAssetToken(token, secret, now = Date.now()) {
  try {
    if (typeof token !== "string" || !KNOWLEDGE_ASSET_TOKEN_PATTERN.test(token) || !Number.isFinite(now)) return null;
    const bytes = decode(token.slice(3));
    // Reject non-canonical encodings as well as modified authenticated ciphertext.
    if (`v1_${base64url(bytes)}` !== token) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(PURPOSE) },
      await key(secret), bytes.slice(12),
    );
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const seconds = Math.floor(now / 1000);
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "exp,id" ||
        typeof value.id !== "string" || !ASSET_ID.test(value.id) || !Number.isSafeInteger(value.exp) ||
        value.exp <= seconds || value.exp > seconds + TTL_SECONDS) return null;
    return { assetId: value.id };
  } catch {
    return null;
  }
}

export function parseKnowledgeAssets(value, maximum = 2) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("OA_RESPONSE_INVALID");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "alt,mimeType,token" ||
        typeof item.token !== "string" || !KNOWLEDGE_ASSET_TOKEN_PATTERN.test(item.token) ||
        !KNOWLEDGE_ASSET_MIMES.has(item.mimeType) || typeof item.alt !== "string" ||
        !item.alt.trim() || item.alt.length > 120 || /[\u0000-\u001f\u007f]/u.test(item.alt)) {
      throw new Error("OA_RESPONSE_INVALID");
    }
    return { token: item.token, mimeType: item.mimeType, alt: item.alt };
  });
}
