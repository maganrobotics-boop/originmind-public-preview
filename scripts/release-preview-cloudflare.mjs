import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  CHAT_ROOT,
  OA_WORKER_NAME,
  ZONE_NAME,
  cloudflareApi,
  existingWorkerSecretNames,
  normalizePublicServiceToken,
  redact,
  runWrangler,
  seedAdmin,
  sourceManifest,
  verifySourceTree,
  withSecretJson,
  workersDevSubdomain,
  writeJson,
} from "./release-support.mjs";
import { checkOaPublicRetrieve, checkOaPublicSuggestions } from "./check-oa-public.mjs";
import { smokeCloudflare, smokeSavedAdminAuthentication } from "./smoke-cloudflare.mjs";

const WORKER_NAME = "originmind-public-chat-preview";
const DATABASE_NAME = "originmind-public-chat-preview";
const HOSTNAME = "preview.omindos.ai";
const PREVIEW_ORIGIN = `https://${HOSTNAME}`;
const EXPECTED_CONFIRMATION = `${WORKER_NAME}:${DATABASE_NAME}:${HOSTNAME}`;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RELEASE_ID_PATTERN = /^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function requiredText(environment, key, minimum = 1, maximum = 4_096) {
  const value = environment[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${key} is missing or invalid`);
  }
  return value;
}

function validateEnvironment(environment = process.env) {
  const accountId = requiredText(environment, "CLOUDFLARE_ACCOUNT_ID").toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId) || /^0+$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the authorized non-zero account id");
  }
  if (requiredText(environment, "CHAT_RELEASE_CONFIRM") !== EXPECTED_CONFIRMATION) {
    throw new Error(`CHAT_RELEASE_CONFIRM must equal ${EXPECTED_CONFIRMATION}`);
  }
  if (environment.GITHUB_REF && environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Chat preview release is restricted to refs/heads/main");
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
  if (!adminPassword) throw new Error("CHAT_ADMIN_PASSWORD is required for the preview PDF/image extraction smoke check");
  if (encryptionKey && (encryptionKey.length < 40 || encryptionKey.length > 1_024)) {
    throw new Error("CHAT_APP_ENCRYPTION_KEY is invalid when supplied");
  }
  if (rateLimitKey && (rateLimitKey.length < 32 || rateLimitKey.length > 1_024)) {
    throw new Error("CHAT_RATE_LIMIT_HMAC_KEY is invalid when supplied");
  }
  if (adminPassword.length < 12 || adminPassword.length > 256) {
    throw new Error("CHAT_ADMIN_PASSWORD is invalid when supplied");
  }
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
    releaseId,
    suppliedSubdomain,
  };
}

function relativeFromConfig(configPath, targetPath) {
  const value = relative(dirname(configPath), targetPath).split(sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

function buildPreviewConfig({ accountId, adminEmail, databaseId, configPath, oaWorkerName, origin, releaseId }) {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || !UUID_PATTERN.test(databaseId) || oaWorkerName !== OA_WORKER_NAME) {
    throw new Error("Invalid preview Wrangler target");
  }
  return {
    $schema: relativeFromConfig(configPath, resolve(CHAT_ROOT, "node_modules", "wrangler", "config-schema.json")),
    account_id: accountId,
    name: WORKER_NAME,
    main: relativeFromConfig(configPath, resolve(CHAT_ROOT, "src", "index.mjs")),
    compatibility_date: "2026-09-11",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: true,
    preview_urls: false,
    routes: [{ pattern: `${HOSTNAME}/*`, zone_name: ZONE_NAME }],
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
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function selectExactDatabase(value) {
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

async function ensurePreviewDatabase(bootstrapConfig, secrets) {
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

async function ensurePreviewDns(environment, target) {
  const zones = await cloudflareApi(
    environment,
    `/zones?name=${encodeURIComponent(ZONE_NAME)}&account.id=${encodeURIComponent(environment.accountId)}&status=active&per_page=50`,
  );
  const matches = zones.filter((zone) => zone?.name === ZONE_NAME && String(zone?.account?.id || "").toLowerCase() === environment.accountId);
  if (matches.length !== 1 || !ACCOUNT_ID_PATTERN.test(String(matches[0]?.id || ""))) {
    throw new Error(`Expected one active ${ZONE_NAME} zone in the authorized account`);
  }
  const zoneId = matches[0].id;
  const records = await cloudflareApi(
    environment,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(HOSTNAME)}&per_page=100`,
  );
  const current = records.filter((record) => record?.name === HOSTNAME);
  const body = { type: "CNAME", name: HOSTNAME, content: target, proxied: true, ttl: 1 };
  if (current.length === 0) {
    await cloudflareApi(environment, `/zones/${zoneId}/dns_records`, { method: "POST", body });
  } else if (current.length === 1) {
    await cloudflareApi(environment, `/zones/${zoneId}/dns_records/${current[0].id}`, { method: "PUT", body });
  } else {
    throw new Error(`Expected at most one DNS record named ${HOSTNAME}`);
  }
  const after = await cloudflareApi(
    environment,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(HOSTNAME)}&per_page=100`,
  );
  const record = after.find((item) => item?.name === HOSTNAME);
  if (record?.type !== "CNAME" || record?.content !== target || record?.proxied !== true) {
    throw new Error("Cloudflare did not publish the expected preview DNS record");
  }
  return { zone: { id: zoneId, name: ZONE_NAME }, record: { id: record.id, type: record.type, name: record.name, content: record.content, proxied: record.proxied, ttl: record.ttl } };
}

async function saveText(evidenceRoot, name, value, secrets) {
  await writeFile(join(evidenceRoot, name), redact(value, secrets), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const rawPublicToken = process.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
const environment = validateEnvironment();
delete process.env.PUBLIC_LAB_AI_SERVICE_TOKEN;
delete process.env.CHAT_ADMIN_PASSWORD;
delete process.env.CHAT_APP_ENCRYPTION_KEY;
delete process.env.CHAT_RATE_LIMIT_HMAC_KEY;
const secretValues = [
  rawPublicToken,
  rawPublicToken.trim(),
  environment.apiToken,
  environment.publicToken,
  environment.encryptionKey,
  environment.rateLimitKey,
  environment.adminPassword,
].filter(Boolean);
const releaseRoot = join(CHAT_ROOT, ".wrangler", "preview-releases", environment.releaseId);
const evidenceRoot = join(releaseRoot, "evidence");
const bootstrapConfigPath = join(releaseRoot, "wrangler.bootstrap.json");
const previewConfigPath = join(releaseRoot, "wrangler.preview.json");

function progress(message) {
  process.stdout.write(`${message}\n`);
}

try {
  await verifySourceTree();
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await writeJson(join(evidenceRoot, "source-manifest.json"), await sourceManifest());

  progress("Verifying the OA public retrieval credential and live response contract.");
  const oaPreflight = await checkOaPublicRetrieve(environment.publicToken);
  await writeJson(join(evidenceRoot, "oa-public-preflight.json"), oaPreflight);
  if (oaPreflight.classification !== "connected_with_public_knowledge") {
    const status = oaPreflight.httpStatus === null ? "" : ` (HTTP ${oaPreflight.httpStatus})`;
    throw new Error(`OA public live preflight failed: ${oaPreflight.classification}${status}`);
  }

  progress("Verifying every OA public suggestion has retrievable public knowledge.");
  const oaSuggestionsPreflight = await checkOaPublicSuggestions(environment.publicToken);
  await writeJson(join(evidenceRoot, "oa-public-suggestions-preflight.json"), oaSuggestionsPreflight);
  if (oaSuggestionsPreflight.classification !== "connected_with_answerable_suggestions") {
    const status = oaSuggestionsPreflight.retrievalHttpStatus ?? oaSuggestionsPreflight.suggestionsHttpStatus;
    const statusDetail = status === null ? "" : ` (HTTP ${status})`;
    throw new Error(`OA public suggestions preflight failed: ${oaSuggestionsPreflight.classification}${statusDetail}`);
  }

  await writeJson(bootstrapConfigPath, {
    account_id: environment.accountId,
    name: WORKER_NAME,
    main: "../../../src/index.mjs",
    compatibility_date: "2026-09-11",
    workers_dev: true,
    preview_urls: false,
  });

  progress("Resolving the dedicated preview Chat D1 database.");
  const database = await ensurePreviewDatabase(bootstrapConfigPath, secretValues);
  await writeJson(join(evidenceRoot, "database.json"), database);

  const subdomain = await workersDevSubdomain(environment, environment.suppliedSubdomain);
  const workersDevOrigin = `https://${WORKER_NAME}.${subdomain}.workers.dev`;
  const previewConfig = buildPreviewConfig({
    accountId: environment.accountId,
    adminEmail: environment.adminEmail,
    databaseId: database.id,
    oaWorkerName: environment.oaWorkerName,
    configPath: previewConfigPath,
    origin: PREVIEW_ORIGIN,
    releaseId: environment.releaseId,
  });
  await writeJson(previewConfigPath, previewConfig);
  await writeJson(join(evidenceRoot, "target.json"), {
    format: "originmind-chat-preview-cloudflare-target-v1",
    accountId: environment.accountId,
    worker: WORKER_NAME,
    database: DATABASE_NAME,
    databaseId: database.id,
    workersDevOrigin,
    previewOrigin: PREVIEW_ORIGIN,
    hostname: HOSTNAME,
    oaServiceBinding: "OA_SERVICE",
    oaWorker: environment.oaWorkerName,
    releaseId: environment.releaseId,
  });

  progress("Inspecting existing preview Worker secret names without reading their values.");
  const existingSecretNames = await existingWorkerSecretNames(previewConfigPath, secretValues);
  await writeJson(join(evidenceRoot, "worker-secret-names-before.json"), {
    format: "originmind-chat-preview-worker-secret-names-v1",
    names: [...existingSecretNames].sort(),
  });
  const appEncryptionKey = existingSecretNames.has("APP_ENCRYPTION_KEY")
    ? null
    : environment.encryptionKey || randomBytes(48).toString("base64url");
  const rateLimitKey = existingSecretNames.has("RATE_LIMIT_HMAC_KEY")
    ? null
    : environment.rateLimitKey || randomBytes(48).toString("base64url");
  if (appEncryptionKey) secretValues.push(appEncryptionKey);
  if (rateLimitKey) secretValues.push(rateLimitKey);
  const workerSecrets = {
    PUBLIC_LAB_AI_SERVICE_TOKEN: environment.publicToken,
    ...(appEncryptionKey ? { APP_ENCRYPTION_KEY: appEncryptionKey } : {}),
    ...(rateLimitKey ? { RATE_LIMIT_HMAC_KEY: rateLimitKey } : {}),
  };
  await writeJson(join(evidenceRoot, "worker-secrets-applied.json"), {
    format: "originmind-chat-preview-worker-secrets-applied-v1",
    actions: Object.keys(workerSecrets).sort().map((name) => ({
      name,
      action: name === "PUBLIC_LAB_AI_SERVICE_TOKEN" ? "updated" : "created-if-missing",
    })),
    preserved: ["APP_ENCRYPTION_KEY", "RATE_LIMIT_HMAC_KEY"].filter((name) => existingSecretNames.has(name)).sort(),
  });

  progress("Checking the generated preview Wrangler target without publishing.");
  await mkdir(join(releaseRoot, "dry-run-preview"), { recursive: true, mode: 0o700 });
  await runWrangler(["deploy", "--dry-run", "--strict", "--config", previewConfigPath, "--outdir", join(releaseRoot, "dry-run-preview")], { secrets: secretValues });

  const bookmark = await runWrangler(["d1", "time-travel", "info", "DB", "--json", "--config", previewConfigPath], { secrets: secretValues });
  await saveText(evidenceRoot, "d1-bookmark-before.json", bookmark.stdout, secretValues);

  progress("Applying repeat-safe preview D1 migrations.");
  const migration = await runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", previewConfigPath], { secrets: secretValues });
  await saveText(evidenceRoot, "d1-migrations.txt", `${migration.stdout}\n${migration.stderr}`, secretValues);

  progress("Initializing the preview administrator only if the account is absent.");
  await seedAdmin(previewConfigPath, environment.adminPassword, secretValues);
  await writeJson(join(evidenceRoot, "admin-initialization.json"), {
    format: "originmind-chat-preview-admin-initialization-v1",
    algorithm: "PBKDF2-SHA-256",
    mode: "insert-if-absent",
    adminSeedAttempted: true,
  });

  await withSecretJson(workerSecrets, async (secretPath) => {
    progress("Deploying the preview Chat Worker.");
    const deploy = await runWrangler([
      "deploy",
      "--strict",
      "--config", previewConfigPath,
      "--secrets-file", secretPath,
      "--message", `chat-preview:${environment.releaseId}`,
    ], { secrets: secretValues });
    await saveText(evidenceRoot, "deploy-preview.txt", `${deploy.stdout}\n${deploy.stderr}`, secretValues);
  });

  progress("Publishing preview DNS.");
  const dns = await ensurePreviewDns(environment, `${WORKER_NAME}.${subdomain}.workers.dev`);
  await writeJson(join(evidenceRoot, "dns-preview.json"), dns);

  progress("Verifying the preview deployment on preview.omindos.ai.");
  const liveSmoke = await smokeCloudflare(PREVIEW_ORIGIN, { releaseId: environment.releaseId });
  await writeJson(join(evidenceRoot, "smoke-preview.json"), liveSmoke);
  const liveExtraction = await smokeSavedAdminAuthentication(PREVIEW_ORIGIN, {
    environment: { CHAT_ADMIN_PASSWORD: environment.adminPassword },
  });
  await writeJson(join(evidenceRoot, "smoke-preview-file-extraction.json"), liveExtraction);

  await writeJson(join(evidenceRoot, "summary.json"), {
    format: "originmind-chat-preview-release-summary-v1",
    completedAt: new Date().toISOString(),
    origin: PREVIEW_ORIGIN,
    workersDevOrigin,
    worker: WORKER_NAME,
    database: DATABASE_NAME,
    releaseId: environment.releaseId,
  });
  progress(`Preview release verified at ${PREVIEW_ORIGIN}`);
} catch (error) {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 }).catch(() => {});
  await writeFile(join(evidenceRoot, "failure.txt"), redact(error?.stack || error?.message || String(error), secretValues), {
    encoding: "utf8",
    mode: 0o600,
  }).catch(() => {});
  throw error;
}
