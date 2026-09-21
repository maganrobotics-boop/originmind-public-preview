import { PublicError } from "./errors.mjs";

export const PASSWORD_ALGORITHM = "PBKDF2-SHA-256";
// Cloudflare's production workerd runtime rejects PBKDF2 iteration counts
// above 100,000 before deriving any bits. Keep the stored record within that
// platform ceiling; online login attempts are separately rate-limited.
export const PASSWORD_ITERATIONS = 100_000;

function webCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("WEB_CRYPTO_UNAVAILABLE");
  }
  return globalThis.crypto;
}

export function bytesToBase64(data) {
  let value = "";
  for (let offset = 0; offset < data.length; offset += 8_192) {
    value += String.fromCharCode(...data.subarray(offset, offset + 8_192));
  }
  return btoa(value);
}

export function base64ToBytes(value) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("INVALID_BASE64");
  }
}

export function bytesToHex(data) {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex(size) {
  return bytesToHex(webCrypto().getRandomValues(new Uint8Array(size)));
}

export async function sha256Hex(value) {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function encryptionKey(secret) {
  if (typeof secret !== "string" || secret.length < 40) throw new Error("ENCRYPTION_UNAVAILABLE");
  const material = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return webCrypto().subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value, secret) {
  const iv = webCrypto().getRandomValues(new Uint8Array(12));
  const cipher = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(value, secret) {
  const [encodedIv, encodedCipher, extra] = value.split(".");
  if (!encodedIv || !encodedCipher || extra !== undefined) throw new Error("INVALID_CIPHERTEXT");
  const clear = await webCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encodedIv) },
    await encryptionKey(secret),
    base64ToBytes(encodedCipher),
  );
  return new TextDecoder().decode(clear);
}

async function derivePassword(password, salt, iterations) {
  const material = await webCrypto().subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await webCrypto().subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function createPasswordRecord(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new PublicError("管理员密码长度须为 12–256 个字符");
  }
  const salt = webCrypto().getRandomValues(new Uint8Array(32));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    algorithm: PASSWORD_ALGORITHM,
    iterations: PASSWORD_ITERATIONS,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
  };
}

export async function verifyPassword(password, record) {
  if (
    record?.algorithm !== PASSWORD_ALGORITHM ||
    !Number.isInteger(record?.iterations) ||
    record.iterations !== PASSWORD_ITERATIONS
  ) {
    throw new Error("PASSWORD_RECORD_UNSUPPORTED");
  }
  const expected = base64ToBytes(record.hash);
  const actual = await derivePassword(password, base64ToBytes(record.salt), record.iterations);
  return constantTimeEqual(actual, expected);
}

export async function insertAdminAccount(database, password) {
  const record = await createPasswordRecord(password);
  await database
    .prepare(
      "INSERT INTO admin_account(id,algorithm,iterations,salt,hash) VALUES (1,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(record.algorithm, record.iterations, record.salt, record.hash)
    .run();
  return record;
}
