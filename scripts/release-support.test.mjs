import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  DATABASE_NAME,
  EXPECTED_CONFIRMATION,
  HOSTNAME,
  OA_WORKER_NAME,
  PASSWORD_ITERATIONS as RELEASE_PASSWORD_ITERATIONS,
  buildWranglerConfig,
  exactDnsRecord,
  normalizePublicServiceToken,
  parseWorkerSecretNames,
  selectExactDatabase,
  sourceManifest,
  validateReleaseEnvironment,
  workersDevSubdomain,
} from "./release-support.mjs";
import { PASSWORD_ITERATIONS as RUNTIME_PASSWORD_ITERATIONS } from "../src/crypto.mjs";

const accountId = "1234567890abcdef1234567890abcdef";
const databaseId = "12345678-1234-4234-9234-1234567890ab";
const releaseId = `${"a".repeat(40)}-1`;
const oaWorkerName = OA_WORKER_NAME;
const releaseEntry = await readFile(new URL("./release-cloudflare.mjs", import.meta.url), "utf8");

function validEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CHAT_RELEASE_CONFIRM: EXPECTED_CONFIRMATION,
    GITHUB_REF: "refs/heads/main",
    CHAT_RELEASE_ID: releaseId,
    CHAT_ADMIN_EMAIL: "maganrobotics@gmail.com",
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token-long-enough",
    OA_PRODUCTION_WORKER_NAME: oaWorkerName,
    PUBLIC_LAB_AI_SERVICE_TOKEN: "A".repeat(43),
    ...overrides,
  };
}

test("release evidence includes every installable web app asset", async () => {
  const manifest = await sourceManifest();
  const paths = new Set(manifest.files.map((file) => file.path));
  for (const path of [
    "public/manifest.webmanifest",
    "public/service-worker.js",
    "public/assets/pwa/apple-touch-icon-180-v1.png",
    "public/assets/pwa/icon-192-v1.png",
    "public/assets/pwa/icon-512-v1.png",
    "public/assets/pwa/icon-maskable-512-v1.png",
  ]) {
    assert.ok(paths.has(path), path);
  }
});

test("password derivation stays within the Cloudflare production PBKDF2 ceiling", () => {
  assert.equal(RELEASE_PASSWORD_ITERATIONS, 100_000);
  assert.equal(RUNTIME_PASSWORD_ITERATIONS, RELEASE_PASSWORD_ITERATIONS);
  assert.ok(RUNTIME_PASSWORD_ITERATIONS <= 100_000);
});

test("optional generated and administrator credentials may be absent", () => {
  const environment = validateReleaseEnvironment(validEnvironment());
  assert.equal(environment.oaWorkerName, oaWorkerName);
  assert.equal(environment.encryptionKey, "");
  assert.equal(environment.rateLimitKey, "");
  assert.equal(environment.adminPassword, "");
  assert.throws(
    () => validateReleaseEnvironment(validEnvironment({ OA_PRODUCTION_WORKER_NAME: "" })),
    /OA_PRODUCTION_WORKER_NAME is missing or invalid/u,
  );
  assert.throws(
    () => validateReleaseEnvironment(validEnvironment({ OA_PRODUCTION_WORKER_NAME: "wrong/worker" })),
    /OA_PRODUCTION_WORKER_NAME must equal/u,
  );
});

test("production release requires real PDF and image extraction smoke checks", () => {
  assert.match(releaseEntry, /CHAT_ADMIN_PASSWORD is required for the production PDF\/image extraction smoke check/u);
  assert.match(releaseEntry, /smoke-staging-file-extraction\.json/u);
  assert.match(releaseEntry, /smoke-production-file-extraction\.json/u);
  assert.match(releaseEntry, /smokeSavedAdminAuthentication\(stagingOrigin/u);
  assert.match(releaseEntry, /smokeSavedAdminAuthentication\(PRODUCTION_ORIGIN/u);
});

test("workers.dev subdomain is always verified against the authorized Cloudflare account", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ success: true, result: { subdomain: "verified-team" } });
  };
  const credentials = { accountId, apiToken: "cloudflare-api-token-long-enough" };
  assert.equal(await workersDevSubdomain(credentials, ""), "verified-team");
  assert.equal(await workersDevSubdomain(credentials, "verified-team"), "verified-team");
  await assert.rejects(
    workersDevSubdomain(credentials, "attacker-team"),
    /does not match the authorized Cloudflare account/u,
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`));
  assert.ok(calls.every((call) => call.options.headers.Authorization === "Bearer cloudflare-api-token-long-enough"));
});

test("service token accepts exact values and normalizes copied values deterministically", () => {
  const token = "A".repeat(43);
  const environment = validateReleaseEnvironment(validEnvironment({
    PUBLIC_LAB_AI_SERVICE_TOKEN: ` \n${token}\r\n`,
  }));
  assert.equal(environment.publicToken, token);
  assert.equal(normalizePublicServiceToken(`\u00a0${token}\u3000`, "another-cloudflare-api-token"), token);
  assert.equal(normalizePublicServiceToken(token, "rotated-cloudflare-api-token"), token);
  const copiedValue = `${"A".repeat(42)}=`;
  const derived = normalizePublicServiceToken(copiedValue, "cloudflare-api-token-long-enough");
  assert.equal(derived, "1deoXJ_E6TPJy6PKS7aTztkKbUiXGr59FlLyiKRPFqE");
  assert.match(derived, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(normalizePublicServiceToken(copiedValue, "rotated-cloudflare-api-token"), derived);
  assert.match(
    normalizePublicServiceToken(`${"A".repeat(21)}\n${"A".repeat(22)}`, "cloudflare-api-token-long-enough"),
    /^[A-Za-z0-9_-]{43}$/u,
  );
  assert.equal(
    validateReleaseEnvironment(validEnvironment({ PUBLIC_LAB_AI_SERVICE_TOKEN: copiedValue })).publicToken,
    "1deoXJ_E6TPJy6PKS7aTztkKbUiXGr59FlLyiKRPFqE",
  );
  assert.throws(
    () => validateReleaseEnvironment(validEnvironment({ PUBLIC_LAB_AI_SERVICE_TOKEN: " \r\n " })),
    /PUBLIC_LAB_AI_SERVICE_TOKEN is missing or invalid/u,
  );
  assert.throws(
    () => normalizePublicServiceToken("A".repeat(4_097), "cloudflare-api-token-long-enough"),
    /PUBLIC_LAB_AI_SERVICE_TOKEN is missing or invalid/u,
  );
  assert.throws(
    () => normalizePublicServiceToken(copiedValue, ""),
    /CLOUDFLARE_API_TOKEN is required/u,
  );
});

test("release entry redacts and removes the raw copied token before child processes", () => {
  assert.ok(releaseEntry.indexOf("const rawPublicToken") < releaseEntry.indexOf("validateReleaseEnvironment()"));
  assert.ok(releaseEntry.indexOf("validateReleaseEnvironment()") < releaseEntry.indexOf("delete process.env.PUBLIC_LAB_AI_SERVICE_TOKEN"));
  assert.ok(releaseEntry.indexOf("delete process.env.PUBLIC_LAB_AI_SERVICE_TOKEN") < releaseEntry.indexOf("const secretValues"));
  assert.match(releaseEntry, /rawPublicToken\.trim\(\)/u);
  for (const name of ["CHAT_ADMIN_PASSWORD", "CHAT_APP_ENCRYPTION_KEY", "CHAT_RATE_LIMIT_HMAC_KEY"]) {
    assert.ok(releaseEntry.indexOf(`delete process.env.${name}`) > releaseEntry.indexOf("validateReleaseEnvironment()"));
    assert.ok(releaseEntry.indexOf(`delete process.env.${name}`) < releaseEntry.indexOf("const secretValues"));
  }
});

test("production release waits past Cloudflare Auto TTL before live smoke", () => {
  const proxyEnabled = releaseEntry.indexOf('await writeJson(join(evidenceRoot, "dns-enabled.json"), enabledState)');
  const dnsSettled = releaseEntry.indexOf('await writeJson(join(evidenceRoot, "dns-settle.json"), await settleProductionDns())');
  const liveSmoke = releaseEntry.indexOf("smokeCloudflare(PRODUCTION_ORIGIN");
  assert.ok(proxyEnabled >= 0);
  assert.ok(dnsSettled > proxyEnabled);
  assert.ok(liveSmoke > dnsSettled);
  assert.match(releaseEntry, /DNS_AUTO_TTL_MILLISECONDS = 300_000/u);
  assert.match(releaseEntry, /DNS_PROPAGATION_BUFFER_MILLISECONDS = 30_000/u);
});

test("generated Wrangler targets use explicit Worker-first static routing", () => {
  const staging = buildWranglerConfig({
    accountId,
    adminEmail: "maganrobotics@gmail.com",
    databaseId,
    oaWorkerName,
    configPath: "/tmp/chat-release/wrangler.staging.json",
    origin: "https://originmind-public-chat-production.example.workers.dev",
    production: false,
    releaseId,
  });
  assert.equal(staging.workers_dev, true);
  assert.deepEqual(staging.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.deepEqual(staging.services, [{ binding: "OA_SERVICE", service: oaWorkerName }]);
  assert.equal(staging.routes, undefined);
  assert.match(staging.assets.directory, /(?:^|\/)public$/u);
  assert.deepEqual({ ...staging.assets, directory: "<chat-public>" }, {
    directory: "<chat-public>",
    binding: "ASSETS",
    html_handling: "none",
    not_found_handling: "none",
    run_worker_first: ["/*", "!/assets/*", "!/favicon.svg", "!/LICENSES.md"],
  });

  const production = buildWranglerConfig({
    accountId,
    adminEmail: "maganrobotics@gmail.com",
    databaseId,
    oaWorkerName,
    configPath: "/tmp/chat-release/wrangler.production.json",
    origin: `https://${HOSTNAME}`,
    production: true,
    releaseId,
  });
  assert.equal(production.workers_dev, false);
  assert.deepEqual(production.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.deepEqual(production.services, [{ binding: "OA_SERVICE", service: oaWorkerName }]);
  assert.deepEqual(production.routes, [{ pattern: `${HOSTNAME}/*`, zone_name: "omindos.ai" }]);
  assert.equal(production.d1_databases[0].database_name, DATABASE_NAME);

  for (const invalidWorker of [undefined, "originmind-public-chat-production"]) {
    assert.throws(
      () => buildWranglerConfig({
        accountId,
        adminEmail: "maganrobotics@gmail.com",
        databaseId,
        oaWorkerName: invalidWorker,
        configPath: "/tmp/chat-release/wrangler.invalid.json",
        origin: `https://${HOSTNAME}`,
        production: true,
        releaseId,
      }),
      /Invalid Wrangler target/u,
    );
  }
});

test("D1 selection requires one exact, valid database", () => {
  assert.deepEqual(selectExactDatabase([{ name: DATABASE_NAME, uuid: databaseId }]), {
    name: DATABASE_NAME,
    id: databaseId,
  });
  assert.throws(
    () => selectExactDatabase([
      { name: DATABASE_NAME, uuid: databaseId },
      { name: DATABASE_NAME, uuid: "22345678-1234-4234-9234-1234567890ab" },
    ]),
    /exactly one D1/u,
  );
});

test("DNS selection is exact and can pin the Tencent IPv4 origin", () => {
  const record = {
    id: "f".repeat(32),
    type: "A",
    name: HOSTNAME,
    content: "203.0.113.10",
    ttl: 300,
    proxiable: true,
    proxied: false,
  };
  assert.equal(exactDnsRecord([record], "203.0.113.10").content, "203.0.113.10");
  assert.throws(() => exactDnsRecord([record, { ...record, id: "e".repeat(32) }]), /exactly one DNS/u);
  assert.throws(() => exactDnsRecord([record], "203.0.113.11"), /does not match/u);
});

test("Worker secret inspection exposes names only and rejects ambiguity", () => {
  assert.deepEqual(
    [...parseWorkerSecretNames([
      { name: "APP_ENCRYPTION_KEY", type: "secret_text" },
      { name: "RATE_LIMIT_HMAC_KEY", type: "secret_text" },
    ])],
    ["APP_ENCRYPTION_KEY", "RATE_LIMIT_HMAC_KEY"],
  );
  assert.throws(
    () => parseWorkerSecretNames([{ name: "APP_ENCRYPTION_KEY" }, { name: "APP_ENCRYPTION_KEY" }]),
    /duplicate names/u,
  );
  assert.throws(() => parseWorkerSecretNames([{ name: "bad-name" }]), /invalid secret descriptor/u);
});
