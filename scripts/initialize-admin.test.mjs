import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { verifyPassword } from "../src/crypto.mjs";

import {
  AdminInitializationError,
  DATABASE_NAME,
  EXPECTED_CONFIRMATION,
  EXPECTED_REPAIR_CONFIRMATION,
  EXPECTED_REPOSITORY,
  LEGACY_PASSWORD_ITERATIONS,
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  consumeAdminInitializationEnvironment,
  initializeChatAdmin,
  selectExactDatabase,
  validateAdminInitializationEnvironment,
} from "./initialize-admin.mjs";

const accountId = "1234567890abcdef1234567890abcdef";
const databaseId = "12345678-1234-4234-9234-1234567890ab";
const apiToken = "cloudflare-api-token-long-enough";
const adminPassword = "independent-admin-password";
const commitSha = "a".repeat(40);
const bookmark = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";

function validEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    CHAT_ADMIN_PASSWORD: adminPassword,
    CHAT_ADMIN_INITIALIZATION_CONFIRM: EXPECTED_CONFIRMATION,
    GITHUB_REPOSITORY: EXPECTED_REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: commitSha,
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function listPayload() {
  return { success: true, result: [{ name: DATABASE_NAME, uuid: databaseId }] };
}

function queryPayload(results) {
  return { success: true, result: [{ success: true, results, meta: {} }] };
}

function batchPayload(resultSets) {
  return {
    success: true,
    result: resultSets.map((results) => ({ success: true, results, meta: {} })),
  };
}

function bookmarkPayload() {
  return { success: true, result: { bookmark } };
}

function accountRow() {
  return { id: 1, algorithm: PASSWORD_ALGORITHM, iterations: PASSWORD_ITERATIONS };
}

function legacyAccountRow() {
  return { id: 1, algorithm: PASSWORD_ALGORITHM, iterations: LEGACY_PASSWORD_ITERATIONS };
}

function repairEnvironment(overrides = {}) {
  return validEnvironment({
    CHAT_ADMIN_OPERATION: "repair-cloudflare-pbkdf2",
    CHAT_ADMIN_INITIALIZATION_CONFIRM: EXPECTED_REPAIR_CONFIRMATION,
    ...overrides,
  });
}

function prepareEnvironment(overrides = {}) {
  return repairEnvironment({
    CHAT_ADMIN_OPERATION: "prepare-cloudflare-pbkdf2",
    CHAT_ADMIN_PASSWORD: undefined,
    ...overrides,
  });
}

test("environment validation requires the exact repository, main ref, confirmation, and independent secrets", () => {
  assert.equal(validateAdminInitializationEnvironment(validEnvironment()).accountId, accountId);
  assert.equal(validateAdminInitializationEnvironment(repairEnvironment()).operation, "repair-cloudflare-pbkdf2");
  assert.equal(validateAdminInitializationEnvironment(prepareEnvironment()).adminPassword, null);
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_PASSWORD: "too-short" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-chat-admin-password",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_INITIALIZATION_CONFIRM: "wrong" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-confirmation",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ GITHUB_REF: "refs/heads/feature" })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-git-ref",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(validEnvironment({ CHAT_ADMIN_PASSWORD: apiToken })),
    (error) => error instanceof AdminInitializationError && error.code === "credentials-must-be-independent",
  );
  assert.throws(
    () => validateAdminInitializationEnvironment(repairEnvironment({ CHAT_ADMIN_INITIALIZATION_CONFIRM: EXPECTED_CONFIRMATION })),
    (error) => error instanceof AdminInitializationError && error.code === "invalid-confirmation",
  );
  assert.equal(PASSWORD_ITERATIONS, 100_000);
  assert.ok(PASSWORD_ITERATIONS <= 100_000);
});

test("secret environment values are removed before any network operation", () => {
  const environment = validEnvironment();
  const consumed = consumeAdminInitializationEnvironment(environment);
  assert.equal(consumed.apiToken, apiToken);
  assert.equal(consumed.adminPassword, adminPassword);
  assert.equal("CLOUDFLARE_API_TOKEN" in environment, false);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
});

test("database selection requires one exact existing production database", () => {
  assert.deepEqual(selectExactDatabase([{ name: DATABASE_NAME, uuid: databaseId }]), {
    id: databaseId,
    name: DATABASE_NAME,
  });
  assert.throws(
    () => selectExactDatabase([]),
    (error) => error instanceof AdminInitializationError && error.code === "database-target-not-unique",
  );
  assert.throws(
    () => selectExactDatabase([
      { name: DATABASE_NAME, uuid: databaseId },
      { name: DATABASE_NAME, uuid: "22345678-1234-4234-9234-1234567890ab" },
    ]),
    (error) => error instanceof AdminInitializationError && error.code === "database-target-not-unique",
  );
});

test("a missing administrator is created with bound parameters and verified", async () => {
  const environment = validEnvironment();
  const calls = [];
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([])),
    jsonResponse(queryPayload([accountRow()])),
    jsonResponse(queryPayload([accountRow()])),
  ];
  const result = await initializeChatAdmin({
    environment,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    randomBytesImpl: () => Buffer.alloc(32, 7),
    pbkdf2Impl: () => Buffer.alloc(32, 9),
    now: () => "2026-09-12T12:00:00.000Z",
  });

  assert.equal(result.outcome, "created-and-verified");
  assert.equal(result.secretApplied, true);
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /\/d1\/database\?name=originmind-public-chat-production/u);

  const insertBody = JSON.parse(calls[2].options.body);
  assert.match(insertBody.sql, /VALUES \(\?, \?, \?, \?, \?\)/u);
  assert.equal(insertBody.sql.includes(adminPassword), false);
  assert.deepEqual(insertBody.params.slice(0, 3), ["1", PASSWORD_ALGORITHM, String(PASSWORD_ITERATIONS)]);
  assert.ok(insertBody.params.every((value) => typeof value === "string"));
  assert.equal(insertBody.params[3], Buffer.alloc(32, 7).toString("base64"));
  assert.equal(insertBody.params[4], Buffer.alloc(32, 9).toString("base64"));

  const serializedReceipt = JSON.stringify(result);
  for (const secret of [apiToken, adminPassword, insertBody.params[3], insertBody.params[4]]) {
    assert.equal(serializedReceipt.includes(secret), false);
  }
  assert.equal("CLOUDFLARE_API_TOKEN" in environment, false);
  assert.equal("CHAT_ADMIN_PASSWORD" in environment, false);
});

test("an existing administrator is preserved without deriving or applying the supplied password", async () => {
  let randomCalled = false;
  let hashCalled = false;
  const replies = [jsonResponse(listPayload()), jsonResponse(queryPayload([accountRow()]))];
  const result = await initializeChatAdmin({
    environment: validEnvironment(),
    fetchImpl: async () => replies.shift(),
    randomBytesImpl: () => {
      randomCalled = true;
      return Buffer.alloc(32);
    },
    pbkdf2Impl: () => {
      hashCalled = true;
      return Buffer.alloc(32);
    },
  });
  assert.equal(result.outcome, "already-exists-no-change");
  assert.equal(result.secretApplied, false);
  assert.equal(randomCalled, false);
  assert.equal(hashCalled, false);
});

test("repair preparation records a bookmark without requiring a password or mutating D1", async () => {
  const calls = [];
  let checkpoint;
  let derived = false;
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([legacyAccountRow()])),
    jsonResponse(bookmarkPayload()),
  ];
  const result = await initializeChatAdmin({
    environment: prepareEnvironment(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    pbkdf2Impl: () => {
      derived = true;
      return Buffer.alloc(32);
    },
    onRepairCheckpoint: async (value) => {
      checkpoint = value;
    },
  });
  assert.equal(result.outcome, "repair-prepared-no-change");
  assert.equal(result.secretApplied, false);
  assert.equal(result.bookmarkBefore, bookmark);
  assert.equal(checkpoint.operation, "prepare-cloudflare-pbkdf2");
  assert.equal(calls.length, 3);
  assert.equal(derived, false);
  assert.equal(calls.some((call) => call.options.method === "POST"), true);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
  assert.match(JSON.parse(calls[1].options.body).sql, /^SELECT /u);
});

test("the explicit repair operation replaces only the known incompatible 210k record and clears sessions", async () => {
  const calls = [];
  let checkpoint;
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([legacyAccountRow()])),
    jsonResponse(bookmarkPayload()),
    jsonResponse(batchPayload([[accountRow()], []])),
    jsonResponse(queryPayload([accountRow()])),
  ];
  const salt = Buffer.alloc(32, 4);
  const hash = Buffer.alloc(32, 5);
  const result = await initializeChatAdmin({
    environment: repairEnvironment(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    randomBytesImpl: () => salt,
    pbkdf2Impl: () => hash,
    now: () => "2026-09-12T13:00:00.000Z",
    onRepairCheckpoint: async (value) => {
      checkpoint = value;
    },
  });

  assert.equal(result.outcome, "repaired-cloudflare-compatible");
  assert.equal(result.secretApplied, true);
  assert.equal(result.operation, "repair-cloudflare-pbkdf2");
  assert.equal(result.iterations, PASSWORD_ITERATIONS);
  assert.equal(result.bookmarkBefore, bookmark);
  assert.deepEqual(checkpoint, {
    format: "originmind-chat-admin-repair-checkpoint-v1",
    operation: "repair-cloudflare-pbkdf2",
    database: DATABASE_NAME,
    bookmarkBefore: bookmark,
    commitSha,
    githubRun: "123456789-1",
    preparedAt: "2026-09-12T13:00:00.000Z",
  });
  assert.equal(calls.length, 5);
  assert.match(calls[2].url, /\/time_travel\/bookmark$/u);
  assert.equal(calls[2].options.method, "GET");
  const repairBody = JSON.parse(calls[3].options.body);
  assert.equal(Array.isArray(repairBody.batch), true);
  assert.equal(repairBody.batch.length, 2);
  assert.match(repairBody.batch[0].sql, /^UPDATE admin_account/u);
  assert.equal(repairBody.batch[0].sql.includes(adminPassword), false);
  assert.deepEqual(repairBody.batch[0].params, [
    PASSWORD_ALGORITHM,
    String(PASSWORD_ITERATIONS),
    salt.toString("base64"),
    hash.toString("base64"),
    "1",
    PASSWORD_ALGORITHM,
    String(LEGACY_PASSWORD_ITERATIONS),
  ]);
  assert.ok(repairBody.batch[0].params.every((value) => typeof value === "string"));
  assert.equal(repairBody.batch[1].sql, "DELETE FROM sessions WHERE changes() = 1;");
  assert.deepEqual(repairBody.batch[1].params, []);
  const serialized = JSON.stringify(result);
  for (const secret of [apiToken, adminPassword, salt.toString("base64"), hash.toString("base64")]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("the repair operation is idempotent and refuses unknown account formats", async () => {
  let derived = false;
  const compatibleCalls = [];
  const compatibleReplies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([accountRow()])),
    jsonResponse(bookmarkPayload()),
    jsonResponse(queryPayload([])),
    jsonResponse(queryPayload([accountRow()])),
  ];
  const compatible = await initializeChatAdmin({
    environment: repairEnvironment(),
    fetchImpl: async (url, options) => {
      compatibleCalls.push({ url, options });
      return compatibleReplies.shift();
    },
    pbkdf2Impl: () => {
      derived = true;
      return Buffer.alloc(32);
    },
  });
  assert.equal(compatible.outcome, "already-compatible-sessions-cleared");
  assert.equal(compatible.secretApplied, false);
  assert.equal(compatible.bookmarkBefore, bookmark);
  const clearBody = JSON.parse(compatibleCalls[3].options.body);
  assert.equal(clearBody.sql, "DELETE FROM sessions;");
  assert.deepEqual(clearBody.params, []);
  assert.equal(derived, false);

  const unsupportedReplies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([{ id: 1, algorithm: PASSWORD_ALGORITHM, iterations: 150_000 }])),
  ];
  await assert.rejects(
    initializeChatAdmin({
      environment: repairEnvironment(),
      fetchImpl: async () => unsupportedReplies.shift(),
    }),
    (error) => error instanceof AdminInitializationError && error.code === "unsupported-admin-account-record",
  );
});

test("repair persists its recovery bookmark before a response-lost mutation", async () => {
  const calls = [];
  let checkpoint;
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([legacyAccountRow()])),
    jsonResponse(bookmarkPayload()),
  ];
  await assert.rejects(
    initializeChatAdmin({
      environment: repairEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (replies.length) return replies.shift();
        throw new Error("response lost after request");
      },
      randomBytesImpl: () => Buffer.alloc(32, 6),
      pbkdf2Impl: () => Buffer.alloc(32, 8),
      onRepairCheckpoint: async (value) => {
        checkpoint = value;
      },
    }),
    (error) => error instanceof AdminInitializationError && error.code === "cloudflare-network-failure",
  );
  assert.equal(calls.length, 4);
  assert.equal(checkpoint.bookmarkBefore, bookmark);
  assert.equal(JSON.stringify(checkpoint).includes(adminPassword), false);
});

test("the repair-generated record is accepted by the Worker password verifier", async () => {
  const calls = [];
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([legacyAccountRow()])),
    jsonResponse(bookmarkPayload()),
    jsonResponse(batchPayload([[accountRow()], []])),
    jsonResponse(queryPayload([accountRow()])),
  ];
  await initializeChatAdmin({
    environment: repairEnvironment(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
    randomBytesImpl: () => Buffer.alloc(32, 11),
  });
  const params = JSON.parse(calls[3].options.body).batch[0].params;
  const record = {
    algorithm: params[0],
    iterations: Number(params[1]),
    salt: params[2],
    hash: params[3],
  };
  assert.equal(await verifyPassword(adminPassword, record), true);
  assert.equal(await verifyPassword("different-password-value", record), false);
  await assert.rejects(
    verifyPassword(adminPassword, { ...record, iterations: PASSWORD_ITERATIONS + 1 }),
    /PASSWORD_RECORD_UNSUPPORTED/u,
  );
});

test("repair CAS conflicts do not clear sessions", async () => {
  const calls = [];
  const replies = [
    jsonResponse(listPayload()),
    jsonResponse(queryPayload([legacyAccountRow()])),
    jsonResponse(bookmarkPayload()),
    jsonResponse(batchPayload([[], []])),
  ];
  await assert.rejects(
    initializeChatAdmin({
      environment: repairEnvironment(),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return replies.shift();
      },
      randomBytesImpl: () => Buffer.alloc(32, 6),
      pbkdf2Impl: () => Buffer.alloc(32, 8),
    }),
    (error) => error instanceof AdminInitializationError && error.code === "admin-repair-conflict",
  );
  const batch = JSON.parse(calls[3].options.body).batch;
  assert.equal(batch[1].sql, "DELETE FROM sessions WHERE changes() = 1;");
});

test("a concurrent insert cannot be reported as successful", async () => {
  const replies = [jsonResponse(listPayload()), jsonResponse(queryPayload([])), jsonResponse(queryPayload([]))];
  await assert.rejects(
    initializeChatAdmin({
      environment: validEnvironment(),
      fetchImpl: async () => replies.shift(),
      randomBytesImpl: () => Buffer.alloc(32, 7),
      pbkdf2Impl: () => Buffer.alloc(32, 9),
    }),
    (error) => error instanceof AdminInitializationError && error.code === "admin-initialization-conflict",
  );
});

test("Cloudflare error bodies and credential material are never copied into thrown errors", async () => {
  const hostileText = `${apiToken}:${adminPassword}:derived-hash`;
  await assert.rejects(
    initializeChatAdmin({
      environment: validEnvironment(),
      fetchImpl: async () => jsonResponse({ success: false, errors: [{ message: hostileText }] }, 403),
    }),
    (error) => {
      assert.equal(error.code, "cloudflare-api-failure");
      assert.equal(error.httpStatus, 403);
      assert.equal(String(error).includes(hostileText), false);
      assert.equal(String(error).includes(apiToken), false);
      assert.equal(String(error).includes(adminPassword), false);
      return true;
    },
  );
});

test("the initialization entrypoint and workflow have no deployment, migration, Worker-secret, or DNS mutation path", async () => {
  const source = await readFile(new URL("./initialize-admin.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/initialize-chat-admin.yml", import.meta.url), "utf8");
  const repairWorkflow = await readFile(new URL("../.github/workflows/repair-chat-admin-pbkdf2.yml", import.meta.url), "utf8");
  const combined = `${source}\n${workflow}\n${repairWorkflow}`;
  for (const forbidden of [
    /wrangler\s+deploy/iu,
    /d1\s+migrations/iu,
    /secret\s+put/iu,
    /setDnsProxy/u,
    /ensureDatabase/u,
    /dns_records/u,
    /\/workers\/scripts\//u,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
  assert.match(workflow, /environment:\s*\n\s+name: production-oa/u);
  assert.match(workflow, /group: chat-cloudflare-production/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(repairWorkflow, /repair-cloudflare-pbkdf2/u);
  assert.match(repairWorkflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(repairWorkflow, /smoke-cloudflare\.mjs https:\/\/chat\.omindos\.ai --admin-saved-secret/u);
  assert.match(repairWorkflow, /admin-initialization\/\*\.json/u);
  assert.ok(
    repairWorkflow.indexOf("Externalize the D1 recovery bookmark before mutation") <
      repairWorkflow.indexOf("Repair only the incompatible production administrator password record"),
  );
});
