# Tencent-to-Cloudflare migration notes

## Audited source

The prototype was derived from the verified Tencent package at:

`../chat-package-final-verify-xYhUV1/ma-assistant-tencent/`

The package manifest identifies release `20260911-e892ed9a54b82bad`; its `server.mjs` manifest digest is `e28555847c7410bb8fb624083e98cb74873f0a7682ce2e725b27308326e51b19`.

### `//#region` inventory

| Original lines | Region | Cloudflare treatment |
| --- | --- | --- |
| 9–91 | `deploy/tencent/runtime.ts` | Replaced. Removed mutable globals and `AsyncLocalStorage`; Worker state is passed in a per-request context. D1 remains asynchronous. |
| 92–3632 | bundled Zod 3 runtime | Removed from the Worker artifact. The finite API contract is enforced by strict local validators. |
| 3633–3722 | `lib/knowledge.ts` | Replaced by `src/knowledge.mjs`. Legacy seeds and Chat-local retrieval were removed so public answers can use only OA-approved public knowledge. |
| 3723–3854 | `lib/server.ts` | Extracted into `src/app.mjs`; Web Crypto and D1 replace Node crypto/SQLite adapters. |
| 3855–4002 | `lib/oa-public.ts` | Extracted into `src/oa-public.mjs`; keeps token validation, 3-second timeout, 16 KiB response cap, strict chunk schema, and no redirects/credentials. |
| 4003–4195 | `app/api/[...path]/route.ts` | Extracted into `src/app.mjs`; endpoint shapes and user-facing errors are retained, with new provider/status fields. |
| 4196–4269 | `deploy/tencent/application.ts` | Replaced. Login/session behavior uses D1 and Web Crypto PBKDF2; request-local context replaces the Node wrapper. |
| 4270–4490 | `deploy/tencent/server.ts` | Removed. Cloudflare supplies HTTP/TLS/process lifecycle. Static asset delivery is outside this backend-only prototype. |

The Worker source imports no `node:*` modules and contains no `node:http`, `node:fs`, `node:net`, `node:sqlite`, systemd, or Nginx runtime path.

## Provider decision

For each request:

1. If D1 contains a Bailian config with both an encrypted key and `verifiedAt`, Bailian is attempted as the optional override.
2. Otherwise, if `env.AI.run` exists, Workers AI uses `@cf/qwen/qwen3-30b-a3b-fp8`.
3. If a verified Bailian request fails and the Workers AI binding exists, the request falls back to Workers AI.
4. If no provider is ready, or retrieval yields no documents, the route returns `mode: "retrieval"` without model inference.

`GET /api/status` reports `storageReady`, `modelReady`, `provider`, and `model`. Workers AI therefore makes `modelReady=true` without a Bailian API key. The model is always called with `stream:false`; this port does not emit SSE.

## Security changes retained or strengthened

- Same-origin enforcement remains on POST/PATCH endpoints.
- The canonical `APP_ORIGIN` is enforced at the Worker boundary.
- IP identifiers are HMACed with the independent `RATE_LIMIT_HMAC_KEY`; the encryption key is not reused.
- The OA response remains capped at 16 KiB and is validated before use.
- Worker-runtime OA and Bailian fetches use workerd-compatible `redirect:"manual"` and reject every non-2xx response, so redirects are never followed; Bailian also uses `cache:"no-store"` and `credentials:"omit"`. JSON is streamed into a maximum 256 KiB buffer and its response shape is validated.
- At most two user messages and 3,000 total characters reach a model. Client assistant messages never reach it.
- A model is never called without at least one retrieved source.
- AI output must cite an existing source with `[n]`; output containing a URL, email, or phone-number pattern is discarded and replaced with retrieval fallback.
- Chat-local document writes cannot publish and are never read by the public chat route. Public material must arrive through the OA public route.
- `/_health` checks service/D1 availability and neither depends on nor reveals whether the administrator account exists.

## Data compatibility

| Tencent data | D1 action |
| --- | --- |
| `documents` | Import only after visibility review. Existing unreviewed material must stay unpublished and should enter through OA review. |
| `inquiries` | Can be copied after row-count and unique-key checks. |
| `limits` | Do not migrate; they are short-lived counters. |
| `sessions` | Do not migrate; users must sign in again. |
| `settings.model` | Re-entry is preferred. Existing ciphertext is usable only if the matching encryption secret is deliberately transferred. Workers AI makes this optional. |
| `admin_account` | Do not copy. Tencent uses scrypt; this port uses PBKDF2-SHA-256 via Web Crypto. A controlled one-time password reset/import is required for management login. |

The public chat path does not require an `admin_account` row. Management login does.

## Release contract (not executed here)

1. Create a dedicated D1 database and apply `migrations/0001_initial.sql`.
2. Bind `DB` and Workers AI as `AI`.
3. Set the three secrets through Cloudflare secret storage; never put them in variables, source, workflow logs, or frontend bundles.
4. Set `APP_ORIGIN` and `ADMIN_EMAIL` as ordinary variables.
5. Deploy the frontend/assets separately or add an audited asset binding; this backend prototype intentionally does not serve them.
6. Attach only the authorized `chat.omindos.ai` routes, keep `workers.dev` disabled, and preserve the prior deployment as rollback.
7. Initialize the administrator account through a separately approved secret-handling step if management access is required.

### Required smoke checks

- `GET /_health` → `{app:"arts-robotics-ai-assistant",ready:true,releaseId:"<expected release>"}`
- `GET /api/status` → `storageReady:true`, `modelReady:true`, provider `workers-ai` or `bailian`
- Same-origin `POST /api/chat` with a question matching approved knowledge → HTTP 200, `mode:"ai"`, `oaPublicStatus:"connected"`, the expected `releaseId`, a nonempty citation-free answer, and sources whose `origin` is exclusively `oa_public`
- A no-match question → `mode:"retrieval"` and zero model calls
- OA admin probe → `connected` after the matching public token is configured on both services

## Verification performed

- Node syntax check of the Worker entry and modules
- In-memory D1 adapter executing the actual migration SQL and Worker SQL statements
- Worker/D1 health without an administrator row
- Workers AI default provider and `stream:false`
- No-document inference suppression
- User-only bounded model context
- Bailian override and hardened fetch options
- Chunked Bailian response rejection above 256 KiB
- OA publication bypass rejection
- Independent rate-limit HMAC key
- AI output citation/contact-information gate

No Cloudflare account, D1 database, DNS record, secret, route, or production service was changed by this prototype.
