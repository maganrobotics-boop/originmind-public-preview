import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CHAT_ROOT,
  DATABASE_NAME,
  HOSTNAME,
  PRODUCTION_ORIGIN,
  WORKER_NAME,
  buildWranglerConfig,
  ensureDatabase,
  existingWorkerSecretNames,
  readDnsSnapshot,
  redact,
  runWrangler,
  seedAdmin,
  setDnsProxy,
  sourceManifest,
  validateReleaseEnvironment,
  verifySourceTree,
  withSecretJson,
  workersDevSubdomain,
  writeJson,
} from "./release-support.mjs";
import { checkOaPublicRetrieve, checkOaPublicSuggestions } from "./check-oa-public.mjs";
import { smokeCloudflare, smokeSavedAdminAuthentication } from "./smoke-cloudflare.mjs";

const rawPublicToken = process.env.PUBLIC_LAB_AI_SERVICE_TOKEN || "";
const environment = validateReleaseEnvironment();
if (!environment.adminPassword) {
  throw new Error("CHAT_ADMIN_PASSWORD is required for the production PDF/image extraction smoke check");
}
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
const releaseRoot = join(CHAT_ROOT, ".wrangler", "releases", environment.releaseId);
const evidenceRoot = join(releaseRoot, "evidence");
const bootstrapConfigPath = join(releaseRoot, "wrangler.bootstrap.json");
const stagingConfigPath = join(releaseRoot, "wrangler.staging.json");
const productionConfigPath = join(releaseRoot, "wrangler.production.json");
let dnsSnapshot = null;
let cutoverAttempted = false;
const DNS_AUTO_TTL_MILLISECONDS = 300_000;
const DNS_PROPAGATION_BUFFER_MILLISECONDS = 30_000;
const PRODUCTION_DNS_SETTLE_MILLISECONDS = DNS_AUTO_TTL_MILLISECONDS + DNS_PROPAGATION_BUFFER_MILLISECONDS;

function progress(message) {
  process.stdout.write(`${message}\n`);
}

async function saveText(name, value) {
  await writeFile(join(evidenceRoot, name), redact(value, secretValues), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function settleProductionDns() {
  progress("Waiting 330 seconds for the previous automatic DNS TTL to expire before live checks.");
  await new Promise((resolve) => setTimeout(resolve, PRODUCTION_DNS_SETTLE_MILLISECONDS));
  return {
    format: "originmind-chat-dns-settle-v1",
    completedAt: new Date().toISOString(),
    waitedMilliseconds: PRODUCTION_DNS_SETTLE_MILLISECONDS,
  };
}

async function deploy(configPath, secretPath, stage) {
  const result = await runWrangler([
    "deploy",
    "--strict",
    "--config", configPath,
    "--secrets-file", secretPath,
    "--message", `chat-${stage}:${environment.releaseId}`,
  ], { secrets: secretValues });
  await saveText(`deploy-${stage}.txt`, `${result.stdout}\n${result.stderr}`);
}

async function rollbackToTencent(error) {
  if (!dnsSnapshot) return null;
  try {
    const state = await setDnsProxy(environment, dnsSnapshot, false);
    await writeJson(join(evidenceRoot, "dns-fallback-after-failure.json"), state);
    return null;
  } catch (rollbackError) {
    return rollbackError;
  }
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
    const status = oaSuggestionsPreflight.retrievalHttpStatus
      ?? oaSuggestionsPreflight.suggestionsHttpStatus;
    const statusDetail = status === null ? "" : ` (HTTP ${status})`;
    throw new Error(
      `OA public suggestions preflight failed: ${oaSuggestionsPreflight.classification}${statusDetail}`,
    );
  }

  await writeJson(bootstrapConfigPath, {
    account_id: environment.accountId,
    name: WORKER_NAME,
    main: "../../../src/index.mjs",
    compatibility_date: "2026-09-11",
    workers_dev: false,
    preview_urls: false,
  });

  progress("Resolving the dedicated Chat D1 database.");
  const database = await ensureDatabase(bootstrapConfigPath, secretValues);
  await writeJson(join(evidenceRoot, "database.json"), database);

  const subdomain = await workersDevSubdomain(environment, environment.suppliedSubdomain);
  const stagingOrigin = `https://${WORKER_NAME}.${subdomain}.workers.dev`;
  const stagingConfig = buildWranglerConfig({
    accountId: environment.accountId,
    adminEmail: environment.adminEmail,
    databaseId: database.id,
    oaWorkerName: environment.oaWorkerName,
    configPath: stagingConfigPath,
    origin: stagingOrigin,
    production: false,
    releaseId: environment.releaseId,
  });
  const productionConfig = buildWranglerConfig({
    accountId: environment.accountId,
    adminEmail: environment.adminEmail,
    databaseId: database.id,
    oaWorkerName: environment.oaWorkerName,
    configPath: productionConfigPath,
    origin: PRODUCTION_ORIGIN,
    production: true,
    releaseId: environment.releaseId,
  });
  await writeJson(stagingConfigPath, stagingConfig);
  await writeJson(productionConfigPath, productionConfig);
  await writeJson(join(evidenceRoot, "target.json"), {
    format: "originmind-chat-cloudflare-target-v1",
    accountId: environment.accountId,
    worker: WORKER_NAME,
    database: DATABASE_NAME,
    databaseId: database.id,
    stagingOrigin,
    productionOrigin: PRODUCTION_ORIGIN,
    hostname: HOSTNAME,
    oaServiceBinding: "OA_SERVICE",
    oaWorker: environment.oaWorkerName,
    releaseId: environment.releaseId,
  });

  progress("Inspecting existing Worker secret names without reading their values.");
  const existingSecretNames = await existingWorkerSecretNames(stagingConfigPath, secretValues);
  await writeJson(join(evidenceRoot, "worker-secret-names-before.json"), {
    format: "originmind-chat-worker-secret-names-v1",
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
    format: "originmind-chat-worker-secrets-applied-v1",
    actions: Object.keys(workerSecrets).sort().map((name) => ({
      name,
      action: name === "PUBLIC_LAB_AI_SERVICE_TOKEN" ? "updated" : "created-if-missing",
    })),
    preserved: ["APP_ENCRYPTION_KEY", "RATE_LIMIT_HMAC_KEY"]
      .filter((name) => existingSecretNames.has(name))
      .sort(),
  });

  progress("Checking both generated Wrangler targets without publishing.");
  await mkdir(join(releaseRoot, "dry-run-staging"), { recursive: true, mode: 0o700 });
  await mkdir(join(releaseRoot, "dry-run-production"), { recursive: true, mode: 0o700 });
  await runWrangler(["deploy", "--dry-run", "--strict", "--config", stagingConfigPath, "--outdir", join(releaseRoot, "dry-run-staging")], { secrets: secretValues });
  await runWrangler(["deploy", "--dry-run", "--strict", "--config", productionConfigPath, "--outdir", join(releaseRoot, "dry-run-production")], { secrets: secretValues });

  progress("Capturing the exact existing DNS origin and keeping it on Tencent during validation.");
  dnsSnapshot = await readDnsSnapshot(environment, environment.expectedOriginIpv4);
  await writeJson(join(evidenceRoot, "dns-before.json"), dnsSnapshot);
  const fallbackState = await setDnsProxy(environment, dnsSnapshot, false);
  await writeJson(join(evidenceRoot, "dns-fallback-before-release.json"), fallbackState);

  const bookmark = await runWrangler(["d1", "time-travel", "info", "DB", "--json", "--config", stagingConfigPath], { secrets: secretValues });
  await saveText("d1-bookmark-before.json", bookmark.stdout);

  progress("Applying repeat-safe D1 migrations.");
  const migration = await runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", stagingConfigPath], { secrets: secretValues });
  await saveText("d1-migrations.txt", `${migration.stdout}\n${migration.stderr}`);
  if (environment.adminPassword) {
    progress("Initializing the administrator only if the account is absent.");
    await seedAdmin(stagingConfigPath, environment.adminPassword, secretValues);
    await writeJson(join(evidenceRoot, "admin-initialization.json"), {
      format: "originmind-chat-admin-initialization-v1",
      algorithm: "PBKDF2-SHA-256",
      mode: "insert-if-absent",
      adminSeedAttempted: true,
    });
  } else {
    await writeJson(join(evidenceRoot, "admin-initialization.json"), {
      format: "originmind-chat-admin-initialization-v1",
      mode: "skipped-no-secret",
      adminSeedAttempted: false,
    });
  }

  await withSecretJson(workerSecrets, async (secretPath) => {
    progress("Deploying the same Worker to workers.dev for staging verification.");
    await deploy(stagingConfigPath, secretPath, "staging");
    const stagingSmoke = await smokeCloudflare(stagingOrigin, { releaseId: environment.releaseId });
    await writeJson(join(evidenceRoot, "smoke-staging.json"), stagingSmoke);
    const stagingExtraction = await smokeSavedAdminAuthentication(stagingOrigin, {
      environment: { CHAT_ADMIN_PASSWORD: environment.adminPassword },
    });
    await writeJson(join(evidenceRoot, "smoke-staging-file-extraction.json"), stagingExtraction);

    progress("Staging passed. Deploying the production route while DNS is still unproxied.");
    await deploy(productionConfigPath, secretPath, "production-route");

    progress("Enabling Cloudflare proxying for the one verified DNS record.");
    cutoverAttempted = true;
    const enabledState = await setDnsProxy(environment, dnsSnapshot, true);
    await writeJson(join(evidenceRoot, "dns-enabled.json"), enabledState);

    await writeJson(join(evidenceRoot, "dns-settle.json"), await settleProductionDns());

    const liveSmoke = await smokeCloudflare(PRODUCTION_ORIGIN, { releaseId: environment.releaseId });
    await writeJson(join(evidenceRoot, "smoke-production.json"), liveSmoke);
    const liveExtraction = await smokeSavedAdminAuthentication(PRODUCTION_ORIGIN, {
      environment: { CHAT_ADMIN_PASSWORD: environment.adminPassword },
    });
    await writeJson(join(evidenceRoot, "smoke-production-file-extraction.json"), liveExtraction);
  });

  const deployments = await runWrangler(["deployments", "list", "--json", "--config", productionConfigPath], { secrets: secretValues });
  await saveText("deployments-after.json", deployments.stdout);
  await writeJson(join(evidenceRoot, "release-receipt.json"), {
    format: "originmind-chat-cloudflare-release-v1",
    releasedAt: new Date().toISOString(),
    releaseId: environment.releaseId,
    worker: WORKER_NAME,
    database: DATABASE_NAME,
    hostname: HOSTNAME,
    route: `${HOSTNAME}/*`,
    live: true,
    fallbackOriginPreserved: true,
  });
  progress("Chat Cloudflare production release and live smoke checks passed.");
} catch (error) {
  const rollbackError = await rollbackToTencent(error);
  const message = redact(error instanceof Error ? error.message : "Chat Cloudflare release failed", secretValues);
  if (evidenceRoot) {
    try {
      await writeJson(join(evidenceRoot, "failure.json"), {
        format: "originmind-chat-cloudflare-failure-v1",
        failedAt: new Date().toISOString(),
        cutoverAttempted,
        fallbackRequested: Boolean(dnsSnapshot),
        error: message,
        rollbackError: rollbackError instanceof Error ? redact(rollbackError.message, secretValues) : null,
      });
    } catch {
      // The primary error remains authoritative if evidence could not be written.
    }
  }
  if (rollbackError) {
    process.stderr.write(`Release failed and DNS fallback also failed: ${message}; ${redact(rollbackError.message, secretValues)}\n`);
  } else if (dnsSnapshot) {
    process.stderr.write(`Release failed; chat.omindos.ai was kept or returned to the Tencent origin: ${message}\n`);
  } else {
    process.stderr.write(`Release failed before DNS was selected: ${message}\n`);
  }
  process.exitCode = 1;
}
