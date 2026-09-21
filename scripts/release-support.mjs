import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { buildFrontend } from "./build-frontend.mjs";

export const WORKER_NAME = "originmind-public-chat-production";
export const DATABASE_NAME = "originmind-public-chat-production";
export const OA_WORKER_NAME = "originmind-internal-oa-staging";
export const ZONE_NAME = "omindos.ai";
export const HOSTNAME = "chat.omindos.ai";
export const PRODUCTION_ORIGIN = `https://${HOSTNAME}`;
export const EXPECTED_CONFIRMATION = `${WORKER_NAME}:${DATABASE_NAME}:${HOSTNAME}`;
export const PASSWORD_ALGORITHM = "PBKDF2-SHA-256";
export const PASSWORD_ITERATIONS = 100_000;

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const CHAT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const REPOSITORY_ROOT = resolve(CHAT_ROOT, "..");
export const WRANGLER = resolve(CHAT_ROOT, "node_modules", ".bin", "wrangler");
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RELEASE_ID_PATTERN = /^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PUBLIC_TOKEN_CONTEXT = "originmind-public-lab-ai-service-token-v1\0";

function requiredText(environment, key, minimum = 1, maximum = 4_096) {
  const value = environment[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${key} is missing or invalid`);
  }
  return value;
}

export function normalizePublicServiceToken(rawValue, cloudflareApiToken) {
  if (typeof rawValue !== "string" || rawValue.length > 4_096) {
    throw new Error("PUBLIC_LAB_AI_SERVICE_TOKEN is missing or invalid");
  }
  const value = rawValue.trim();
  if (!value) throw new Error("PUBLIC_LAB_AI_SERVICE_TOKEN is missing or invalid");
  if (PUBLIC_TOKEN_PATTERN.test(value)) return value;
  if (typeof cloudflareApiToken !== "string" || !cloudflareApiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required to normalize the service token");
  }
  // OA uses the same context, UTF-8 encoding, and protected Cloudflare key.
  return createHmac("sha256", cloudflareApiToken)
    .update(PUBLIC_TOKEN_CONTEXT, "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

export function validateReleaseEnvironment(environment = process.env) {
  const accountId = requiredText(environment, "CLOUDFLARE_ACCOUNT_ID").toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId) || /^0+$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the authorized non-zero account id");
  }
  if (requiredText(environment, "CHAT_RELEASE_CONFIRM") !== EXPECTED_CONFIRMATION) {
    throw new Error(`CHAT_RELEASE_CONFIRM must equal ${EXPECTED_CONFIRMATION}`);
  }
  if (environment.GITHUB_REF && environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Chat production release is restricted to refs/heads/main");
  }
  const releaseId = requiredText(environment, "CHAT_RELEASE_ID");
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("CHAT_RELEASE_ID must be a Git commit and run attempt");

  const adminEmail = requiredText(environment, "CHAT_ADMIN_EMAIL", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(adminEmail)) throw new Error("CHAT_ADMIN_EMAIL is invalid");
  const apiToken = requiredText(environment, "CLOUDFLARE_API_TOKEN", 20, 2_048);
  const oaWorkerName = requiredText(environment, "OA_PRODUCTION_WORKER_NAME", 1, 63).trim().toLowerCase();
  if (oaWorkerName !== OA_WORKER_NAME) {
    throw new Error(`OA_PRODUCTION_WORKER_NAME must equal ${OA_WORKER_NAME}`);
  }
  const publicToken = normalizePublicServiceToken(environment.PUBLIC_LAB_AI_SERVICE_TOKEN, apiToken);
  const encryptionKey = (environment.CHAT_APP_ENCRYPTION_KEY || "").trim();
  const rateLimitKey = (environment.CHAT_RATE_LIMIT_HMAC_KEY || "").trim();
  const adminPassword = environment.CHAT_ADMIN_PASSWORD || "";
  if (encryptionKey && (encryptionKey.length < 40 || encryptionKey.length > 1_024)) {
    throw new Error("CHAT_APP_ENCRYPTION_KEY is invalid when supplied");
  }
  if (rateLimitKey && (rateLimitKey.length < 32 || rateLimitKey.length > 1_024)) {
    throw new Error("CHAT_RATE_LIMIT_HMAC_KEY is invalid when supplied");
  }
  if (adminPassword && (adminPassword.length < 12 || adminPassword.length > 256)) {
    throw new Error("CHAT_ADMIN_PASSWORD is invalid when supplied");
  }
  const suppliedCredentials = [publicToken, encryptionKey, rateLimitKey, adminPassword].filter(Boolean);
  if (new Set(suppliedCredentials).size !== suppliedCredentials.length) {
    throw new Error("Chat credentials must be independent values");
  }
  const expectedOriginIpv4 = (environment.CHAT_EXPECTED_ORIGIN_IPV4 || "").trim();
  if (expectedOriginIpv4 && !isIpv4(expectedOriginIpv4)) throw new Error("CHAT_EXPECTED_ORIGIN_IPV4 is invalid");
  const suppliedSubdomain = (environment.CHAT_WORKERS_DEV_SUBDOMAIN || "").trim().toLowerCase();
  if (suppliedSubdomain && !SUBDOMAIN_PATTERN.test(suppliedSubdomain)) {
    throw new Error("CHAT_WORKERS_DEV_SUBDOMAIN is invalid");
  }
  return {
    accountId,
    adminEmail,
    apiToken,
    oaWorkerName,
    publicToken,
    encryptionKey,
    rateLimitKey,
    adminPassword,
    expectedOriginIpv4,
    releaseId,
    suppliedSubdomain,
  };
}

function isIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

export function redact(value, secrets) {
  let result = String(value || "");
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export async function pathIsRegularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function verifySourceTree() {
  const required = [
    "package.json",
    "src/index.mjs",
    "migrations/0001_initial.sql",
    "frontend/index.html",
    "frontend/app.js",
    "frontend/styles.css",
    "public/_headers",
    "public/assets/pwa/apple-touch-icon-180-v1.png",
    "public/assets/pwa/icon-192-v1.png",
    "public/assets/pwa/icon-512-v1.png",
    "public/assets/pwa/icon-maskable-512-v1.png",
    "public/index.html",
    "public/manifest.webmanifest",
    "public/service-worker.js",
  ];
  for (const item of required) {
    const path = resolve(CHAT_ROOT, item);
    if (!(await pathIsRegularFile(path))) throw new Error(`Required Chat release file is missing: ${item}`);
  }
  await buildFrontend({ check: true });
  if (!(await pathIsRegularFile(WRANGLER))) throw new Error("Locked Wrangler executable is missing");
}

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!prefix && [".wrangler", "node_modules"].includes(entry.name)) continue;
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(child, childPrefix)));
    else if (entry.isFile()) files.push({ path: child, relativePath: childPrefix });
    else throw new Error(`Unsupported release source entry: ${childPrefix}`);
  }
  return files;
}

export async function sourceManifest() {
  const files = await filesBelow(CHAT_ROOT);
  const manifest = [];
  const aggregate = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    manifest.push({ path: file.relativePath, bytes: bytes.length, sha256: hash });
    aggregate.update(file.relativePath).update("\0").update(String(bytes.length)).update("\0").update(hash).update("\n");
  }
  return { format: "originmind-chat-source-manifest-v1", files: manifest, sha256: aggregate.digest("hex") };
}

export async function writeJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
}

export async function runProcess(executable, args, { cwd = CHAT_ROOT, input = null, secrets = [], allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if ((code ?? 1) !== 0 && !allowFailure) {
        rejectPromise(new Error(redact(`Command failed (${code}): ${stderr || stdout}`, secrets)));
      } else {
        resolvePromise(result);
      }
    });
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

export async function runWrangler(args, options = {}) {
  return runProcess(WRANGLER, args, options);
}

export function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

export function parseWorkerSecretNames(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler secret list response is not an array");
  const names = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(item.name)) {
      throw new Error("Wrangler secret list returned an invalid secret descriptor");
    }
    names.push(item.name);
  }
  if (new Set(names).size !== names.length) throw new Error("Wrangler secret list returned duplicate names");
  return new Set(names);
}

export async function existingWorkerSecretNames(configPath, secrets) {
  const result = await runWrangler([
    "secret", "list", "--format", "json", "--config", configPath,
  ], { secrets, allowFailure: true });
  if (result.code === 0) {
    return parseWorkerSecretNames(parseJsonOutput(result.stdout, "wrangler secret list"));
  }
  const failure = `${result.stderr}\n${result.stdout}`;
  if (/(?:not found|does not exist|10090|(?:^|\D)404(?:\D|$))/iu.test(failure)) return new Set();
  throw new Error(redact(`Unable to inspect existing Worker secret names: ${failure}`, secrets));
}

export function selectExactDatabase(value) {
  if (!Array.isArray(value)) throw new Error("Cloudflare D1 list response is not an array");
  const matches = value.filter((database) => database?.name === DATABASE_NAME);
  if (matches.length !== 1) throw new Error(`Expected exactly one D1 named ${DATABASE_NAME}, found ${matches.length}`);
  const database = matches[0];
  const id = String(database.uuid || database.id || "").toLowerCase();
  if (!UUID_PATTERN.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(id)) {
    throw new Error("Cloudflare returned an invalid D1 id");
  }
  return { name: DATABASE_NAME, id };
}

export async function ensureDatabase(bootstrapConfig, secrets) {
  const list = async () => parseJsonOutput((await runWrangler([
    "d1", "list", "--json", "--config", bootstrapConfig,
  ], { secrets })).stdout, "wrangler d1 list");
  let databases = await list();
  let matches = databases.filter((database) => database?.name === DATABASE_NAME);
  if (matches.length > 1) throw new Error(`Multiple D1 databases are named ${DATABASE_NAME}`);
  if (matches.length === 0) {
    await runWrangler(["d1", "create", DATABASE_NAME, "--location", "apac", "--config", bootstrapConfig], { secrets });
    databases = await list();
    matches = databases.filter((database) => database?.name === DATABASE_NAME);
  }
  return selectExactDatabase(matches);
}

function relativeFromConfig(configPath, targetPath) {
  const value = relative(dirname(configPath), targetPath).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

export function buildWranglerConfig({ accountId, adminEmail, databaseId, configPath, oaWorkerName, origin, production, releaseId }) {
  if (
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    !UUID_PATTERN.test(databaseId) ||
    typeof oaWorkerName !== "string" ||
    oaWorkerName !== OA_WORKER_NAME ||
    oaWorkerName === WORKER_NAME
  ) {
    throw new Error("Invalid Wrangler target");
  }
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("Invalid Wrangler origin");
  const config = {
    $schema: relativeFromConfig(configPath, resolve(CHAT_ROOT, "node_modules", "wrangler", "config-schema.json")),
    account_id: accountId,
    name: WORKER_NAME,
    main: relativeFromConfig(configPath, resolve(CHAT_ROOT, "src", "index.mjs")),
    compatibility_date: "2026-09-11",
    // The Service Binding is the primary Worker-to-Worker path. Keep the
    // public URL fallback strict so it cannot silently resolve to a zone origin.
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: !production,
    preview_urls: false,
    assets: {
      directory: relativeFromConfig(configPath, resolve(CHAT_ROOT, "public")),
      binding: "ASSETS",
      html_handling: "none",
      not_found_handling: "none",
      run_worker_first: ["/*", "!/assets/*", "!/favicon.svg", "!/LICENSES.md"],
    },
    ai: { binding: "AI" },
    services: [{ binding: "OA_SERVICE", service: oaWorkerName }],
    d1_databases: [{
      binding: "DB",
      database_name: DATABASE_NAME,
      database_id: databaseId,
      migrations_dir: relativeFromConfig(configPath, resolve(CHAT_ROOT, "migrations")),
    }],
    vars: {
      APP_ORIGIN: origin,
      ADMIN_EMAIL: adminEmail,
      RELEASE_ID: releaseId,
    },
  };
  if (production) config.routes = [{ pattern: `${HOSTNAME}/*`, zone_name: ZONE_NAME }];
  return config;
}

export async function cloudflareApi({ accountId, apiToken }, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare API ${method} ${path} returned non-JSON status ${response.status}`);
  }
  if (!response.ok || payload?.success !== true) {
    const errors = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => `${error.code || "unknown"}:${error.message || "request failed"}`).join(", ")
      : "request failed";
    throw new Error(`Cloudflare API ${method} ${path} failed (${response.status}; ${errors})`);
  }
  return payload.result;
}

export async function workersDevSubdomain(credentials, supplied) {
  const result = await cloudflareApi(credentials, `/accounts/${credentials.accountId}/workers/subdomain`);
  const value = String(result?.subdomain || "").toLowerCase();
  if (!SUBDOMAIN_PATTERN.test(value)) throw new Error("Cloudflare returned an invalid workers.dev subdomain");
  if (supplied && supplied !== value) {
    throw new Error("CHAT_WORKERS_DEV_SUBDOMAIN does not match the authorized Cloudflare account");
  }
  return value;
}

export function exactZone(result, accountId) {
  if (!Array.isArray(result)) throw new Error("Cloudflare zone response is not an array");
  const matches = result.filter((zone) =>
    zone?.name === ZONE_NAME && String(zone?.account?.id || "").toLowerCase() === accountId,
  );
  if (matches.length !== 1 || !/^[a-f0-9]{32}$/u.test(String(matches[0]?.id || ""))) {
    throw new Error(`Expected one active ${ZONE_NAME} zone in the authorized account`);
  }
  return matches[0];
}

export function exactDnsRecord(result, expectedOriginIpv4 = "") {
  if (!Array.isArray(result)) throw new Error("Cloudflare DNS response is not an array");
  const matches = result.filter((record) => record?.name === HOSTNAME);
  if (matches.length !== 1) throw new Error(`Expected exactly one DNS record named ${HOSTNAME}`);
  const record = matches[0];
  if (!["A", "AAAA", "CNAME"].includes(record.type) || typeof record.content !== "string" || !record.content) {
    throw new Error("The existing Chat DNS record is not a supported proxied origin record");
  }
  if (expectedOriginIpv4 && (record.type !== "A" || record.content !== expectedOriginIpv4)) {
    throw new Error("The Chat DNS origin does not match CHAT_EXPECTED_ORIGIN_IPV4");
  }
  if (record.proxiable !== true || typeof record.proxied !== "boolean" || !Number.isInteger(record.ttl)) {
    throw new Error("The existing Chat DNS record cannot be safely proxied");
  }
  if (!/^[a-f0-9]{32}$/u.test(String(record.id || ""))) throw new Error("The Chat DNS record id is invalid");
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
  };
}

export async function readDnsSnapshot(credentials, expectedOriginIpv4 = "") {
  const zones = await cloudflareApi(
    credentials,
    `/zones?name=${encodeURIComponent(ZONE_NAME)}&account.id=${encodeURIComponent(credentials.accountId)}&status=active&per_page=50`,
  );
  const zone = exactZone(zones, credentials.accountId);
  const records = await cloudflareApi(
    credentials,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(HOSTNAME)}&per_page=100`,
  );
  return { zone: { id: zone.id, name: zone.name }, record: exactDnsRecord(records, expectedOriginIpv4) };
}

function sameOriginRecord(left, right) {
  return left.id === right.id && left.type === right.type && left.name === right.name && left.content === right.content;
}

export async function setDnsProxy(credentials, snapshot, proxied) {
  const current = await readDnsSnapshot(credentials);
  if (current.zone.id !== snapshot.zone.id || !sameOriginRecord(current.record, snapshot.record)) {
    throw new Error("Chat DNS target changed after preflight; refusing to edit it");
  }
  if (current.record.proxied === proxied && (!proxied || current.record.ttl === snapshot.record.ttl || current.record.ttl === 1)) {
    return current;
  }
  const body = proxied
    ? { proxied: true }
    : { proxied: false, ttl: snapshot.record.ttl };
  await cloudflareApi(credentials, `/zones/${snapshot.zone.id}/dns_records/${snapshot.record.id}`, { method: "PATCH", body });
  const after = await readDnsSnapshot(credentials);
  if (after.zone.id !== snapshot.zone.id || !sameOriginRecord(after.record, snapshot.record) || after.record.proxied !== proxied) {
    throw new Error("Cloudflare did not preserve the exact Chat DNS origin while changing proxy state");
  }
  if (!proxied && after.record.ttl !== snapshot.record.ttl) {
    throw new Error("Cloudflare did not restore the original Chat DNS TTL");
  }
  return after;
}

export async function withSecretJson(values, callback) {
  const directory = await mkdtemp(join(tmpdir(), "originmind-chat-secrets-"));
  const path = join(directory, "worker-secrets.json");
  try {
    await writeFile(path, `${JSON.stringify(values)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function seedAdmin(configPath, password, secrets) {
  const directory = await mkdtemp(join(tmpdir(), "originmind-chat-admin-"));
  const path = join(directory, "seed-admin.sql");
  try {
    const salt = randomBytes(32);
    const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
    const sql = `INSERT INTO admin_account(id,algorithm,iterations,salt,hash) VALUES (1,'${PASSWORD_ALGORITHM}',${PASSWORD_ITERATIONS},'${salt.toString("base64")}','${hash.toString("base64")}') ON CONFLICT(id) DO NOTHING;\n`;
    await writeFile(path, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await runWrangler(["d1", "execute", "DB", "--remote", "--config", configPath, "--file", path], { secrets });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
