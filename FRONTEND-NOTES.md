# Frontend source and release assets

The maintainable browser source is deliberately dependency-free and lives in:

- `frontend/index.html`
- `frontend/app.js`
- `frontend/styles.css`

`frontend/index.html` contains the placeholders `__APP_ASSET__` and
`__STYLE_ASSET__` exactly once. `npm run build:frontend` copies the JavaScript
and CSS bytes to `public/assets/`, names each file with the first 16 hexadecimal
characters of its SHA-256 digest, replaces the placeholders in
`public/index.html`, and removes stale generated `.js` and `.css` files. Other
public assets are not removed.

Installable-web-app metadata is kept as audited release input under `public/`:

- `manifest.webmanifest` describes the standalone app.
- `service-worker.js` caches only same-origin, versioned files under `/assets/`.
- `assets/pwa/` contains versioned 192 px, 512 px, maskable and Apple icons.

The service worker deliberately does not handle the HTML shell, `/manage`,
`/_health`, or any `/api/*` request. Conversation, authentication and
administrator responses therefore never enter Cache Storage.

The generated files under `public/` are committed release inputs. Before a
release, run:

```sh
npm run build:frontend
npm run check
```

`npm run check:frontend` and the Cloudflare release preflight use
`build-frontend.mjs --check`. Check mode performs no writes and fails if the
shell, either hashed asset, or the generated JS/CSS allowlist differs from the
current source.

## Security and application contract

- Browser API requests remain root-relative and same-origin.
- `/` is the public assistant and exact `/manage` is the administrator view.
- The public name is exactly `ARTS Robotics AI assistant`.
- Chat-local document writes are always drafts with `published: 0`. Only the OA
  approved-public endpoint can provide public model knowledge.
- The administrator importer accepts TXT, Markdown, PDF, JPEG, PNG, and WebP.
  PDF and image binaries are sent only to the same-origin parsing endpoint,
  converted to editable Markdown, and not retained after the request.
- Untrusted answers, source metadata, inquiries, and transcripts are rendered
  as text. The frontend does not use `innerHTML`, dynamic code execution,
  remote scripts, or remote stylesheets.
- JavaScript and CSS filenames are content-addressed, so `/assets/*` retains
  the one-year immutable cache policy. The HTML shell remains non-cacheable.
- The stable service-worker URL is never cached, while the manifest uses a
  short one-hour cache lifetime so installation metadata can be updated.

The backend independently enforces authentication, request validation, draft
visibility, OA-only public retrieval, rate limits, and model-output safety.
