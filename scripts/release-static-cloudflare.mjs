import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CHAT_ROOT,
  DATABASE_NAME,
  HOSTNAME,
  OA_WORKER_NAME,
  PRODUCTION_ORIGIN,
  WORKER_NAME,
  buildWranglerConfig,
  ensureDatabase,
  runWrangler,
  sourceManifest,
  verifySourceTree,
  writeJson,
} from "./release-support.mjs";

const EXPECTED_CONFIRMATION = `${WORKER_NAME}:static-assets:${HOSTNAME}`;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const RELEASE_ID_PATTERN = /^[a-f0-9]{40}-[1-9][0-9]{0,5}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function requiredText(key, minimum = 1, maximum = 4_096) {
  const value = process.env[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${key} is missing or invalid`);
  }
  return value;
}

function validateEnvironment() {
  const accountId = requiredText("CLOUDFLARE_ACCOUNT_ID").toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId) || /^0+$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the authorized non-zero account id");
  }
  if (requiredText("CHAT_STATIC_RELEASE_CONFIRM") !== EXPECTED_CONFIRMATION) {
    throw new Error(`CHAT_STATIC_RELEASE_CONFIRM must equal ${EXPECTED_CONFIRMATION}`);
  }
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Chat static production release is restricted to refs/heads/main");
  }
  const releaseId = requiredText("CHAT_RELEASE_ID");
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("CHAT_RELEASE_ID must be a Git commit and run attempt");
  const apiToken = requiredText("CLOUDFLARE_API_TOKEN", 20, 2_048);
  const adminEmail = (process.env.CHAT_ADMIN_EMAIL || "maganrobotics@gmail.com").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(adminEmail)) throw new Error("CHAT_ADMIN_EMAIL is invalid");
  const oaWorkerName = requiredText("OA_PRODUCTION_WORKER_NAME", 1, 63).trim().toLowerCase();
  if (oaWorkerName !== OA_WORKER_NAME) throw new Error(`OA_PRODUCTION_WORKER_NAME must equal ${OA_WORKER_NAME}`);
  return { accountId, adminEmail, apiToken, oaWorkerName, releaseId };
}

function progress(message) {
  process.stdout.write(`${message}\n`);
}

async function saveText(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const environment = validateEnvironment();
const secretValues = [environment.apiToken];
delete process.env.PUBLIC_LAB_AI_SERVICE_TOKEN;
delete process.env.CHAT_ADMIN_PASSWORD;
delete process.env.CHAT_APP_ENCRYPTION_KEY;
delete process.env.CHAT_RATE_LIMIT_HMAC_KEY;

const releaseRoot = join(CHAT_ROOT, ".wrangler", "static-releases", environment.releaseId);
const evidenceRoot = join(releaseRoot, "evidence");
const bootstrapConfigPath = join(releaseRoot, "wrangler.bootstrap.json");
const productionConfigPath = join(releaseRoot, "wrangler.production.json");

await verifySourceTree();
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await writeJson(join(evidenceRoot, "source-manifest.json"), await sourceManifest());

progress("Resolving the existing Chat D1 database without migration or mutation.");
await writeJson(bootstrapConfigPath, {
  account_id: environment.accountId,
  name: WORKER_NAME,
  main: "../../../src/index.mjs",
  compatibility_date: "2026-09-11",
  workers_dev: false,
  preview_urls: false,
});
const database = await ensureDatabase(bootstrapConfigPath, secretValues);
await writeJson(join(evidenceRoot, "database.json"), database);

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
delete productionConfig.routes;
productionConfig.workers_dev = false;
await writeJson(productionConfigPath, productionConfig);
await writeJson(join(evidenceRoot, "target.json"), {
  format: "originmind-chat-static-release-target-v1",
  worker: WORKER_NAME,
  database: DATABASE_NAME,
  databaseId: database.id,
  productionOrigin: PRODUCTION_ORIGIN,
  hostname: HOSTNAME,
  releaseId: environment.releaseId,
  secretMutation: false,
  dnsMutation: false,
  routeMutation: false,
  d1Migration: false,
});

progress("Checking the production Wrangler target without publishing or touching routes.");
await mkdir(join(releaseRoot, "dry-run-production"), { recursive: true, mode: 0o700 });
await runWrangler(["deploy", "--dry-run", "--strict", "--config", productionConfigPath, "--outdir", join(releaseRoot, "dry-run-production")], { secrets: secretValues });

progress("Deploying Chat Worker and static assets without changing routes, secrets, DNS, or D1 migrations.");
const deploy = await runWrangler([
  "deploy",
  "--strict",
  "--config", productionConfigPath,
  "--message", `chat-static-assets:${environment.releaseId}`,
], { secrets: secretValues });
await saveText(join(evidenceRoot, "deploy-static.txt"), `${deploy.stdout}\n${deploy.stderr}`);

await writeJson(join(evidenceRoot, "static-release.json"), {
  format: "originmind-chat-static-release-v1",
  completedAt: new Date().toISOString(),
  origin: PRODUCTION_ORIGIN,
  releaseId: environment.releaseId,
});
progress("Chat static release completed.");
