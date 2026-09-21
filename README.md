# OriginMind Public Preview

OriginMind Public Preview is the external demonstration version of the
ARTS Robotics / OriginMind chat experience. It is intended for public showcase,
customer previews, investor demos and product walkthroughs.

This repository is deliberately separate from the internal OA repository. Keep
internal approval flows, member data, private knowledge bases, production
credentials and unpublished project material out of this public codebase.

This project serves the public `chat.omindos.ai` assistant from one Cloudflare
Worker. Static Assets serve the verified production frontend, D1 stores
inquiries and operational state, Workers AI is the default model provider, and
the OA public endpoint contributes only knowledge explicitly approved for
public visibility.

The dependency-free browser source is maintained under `frontend/`. A small
deterministic builder writes content-hashed JavaScript and CSS plus the resolved
HTML shell under `public/`; those generated release assets are checked in.

The same release includes a standalone web-app manifest, OriginMind-derived
install icons and a root-scope service worker. The service worker caches only
versioned static files; it never caches HTML, chat/API responses, health checks,
authentication state or the management surface.

Answers remain grounded in OA-approved public knowledge. Numbered citations are
required and checked inside the Worker, then removed before the answer is
returned or stored in signed conversation context. OA-public source records stay
in the API response as release evidence but are not part of the visible answer.

The public frontend restores recent conversations and drafts separately for each
section from this browser's local storage (up to 40 messages / 80,000 characters
per section, expiring after seven days). Clearing a section or starting its new
conversation removes that saved record. Interrupted questions return as drafts
and are never resent automatically. Storage failures leave chat usable. Contact
forms, administrative state and knowledge suggestions are not persisted. Signed
conversation context expires independently after twelve hours; subsequent
retrieval can use prior user questions, never unsigned assistant messages.

Answers support inert Markdown emphasis, lists, code and horizontally scrollable
tables. Raw HTML, images and links are never executed or loaded by this renderer;
reference hiding still runs before display and again when restoring history.

## Isolation and visibility

- This Worker and its D1 database are separate from the internal OA Worker and
  OA D1 database.
- The public Chat application never receives OA sessions or internal-only
  knowledge.
- Internal OA features should be added here only as public demo flows, mock
  screens, or integrations against approved public endpoints.
- Chat-local document writes remain drafts and never reach the public model.
  Only knowledge returned by the OA approved-public endpoint may reach a model.
- The authenticated management page accepts TXT, Markdown, PDF, JPEG, PNG and
  WebP. PDF and image files (up to 10 MiB) are sent to Cloudflare Workers AI and
  converted transiently through its `toMarkdown` binding. The site does not
  retain the original binary. Parsed text is no longer capped at 30,000
  characters; the 5 MiB UTF-8 safety ceiling remains aligned with OA import.
  Large documents bypass Chat draft storage, enter OA as one review item, and
  are split into storage parts of at most 20,000 characters. Human review and OA
  approval remain mandatory before internal or public retrieval.
- Public Chat responses remain text-only. File ingestion does not add PDF or
  image generation to visitor-facing answers.
- The public path works before an administrator password is provisioned.
  Management login is deliberately fail-closed until a controlled password
  record is inserted into D1.

## Runtime bindings

| Kind | Name | Purpose |
| --- | --- | --- |
| D1 | `DB` | Inquiries, sessions, drafts, settings, exact budgets |
| Workers AI | `AI` | Default answer model plus transient PDF/image conversion |
| Static Assets | `ASSETS` | Public and management frontend |
| Secret | `APP_ENCRYPTION_KEY` | Optional Bailian credential encryption |
| Secret | `RATE_LIMIT_HMAC_KEY` | Pseudonymous abuse-control identifiers |
| Secret | `PUBLIC_LAB_AI_SERVICE_TOKEN` | OA public retrieval authentication |

`APP_ORIGIN` is strict: preview and production deployments must generate their
own configuration with the exact public origin. Production disables both
`workers.dev` and preview URLs and is attached using the route
`chat.omindos.ai/*` only after a successful preview smoke test.

## Verification

```sh
npm ci
npm run build:frontend
npm run check
npm run check:wrangler
```

Use `npm run check:frontend` when verifying that committed public assets still
match their source without changing any files. Content-hashed files under
`/assets/` are cached immutably; `/` and `/manage` always serve the same
non-cacheable HTML shell.

The production workflow additionally applies the D1 migration, writes secrets
without logging them, validates the exact release ID and a real Workers AI
response backed exclusively by OA-public sources, verifies the generated
frontend source hashes and static responses, and
only then enables Cloudflare proxying for the existing DNS record. A failed
live smoke test restores the previous proxy state so the Tencent origin remains
the fallback.

See `MIGRATION.md` for the audited Tencent-to-Workers mapping.
