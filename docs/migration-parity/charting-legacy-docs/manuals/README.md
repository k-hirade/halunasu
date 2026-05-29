# ハルナス manuals

This directory stores user-facing manuals as text source and generates PDF files from that source.

## Source of truth

- Edit the manual in `docs/manuals/src/user-manual-v1.md`.
- Keep generated files out of Git. `docs/manuals/dist/` is covered by the repository `dist/` ignore rule.
- Store reusable screenshots in `docs/manuals/assets/screenshots/v1/`.

## Build

Generate HTML only:

```bash
npm run docs:manual:html
```

Generate HTML and PDF:

```bash
npm run docs:manual:pdf
```

The PDF step uses Playwright. If Playwright is not installed in the local checkout or CI environment, install it first:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

Generated outputs:

- `docs/manuals/dist/harunas-user-manual-v1.html`
- `docs/manuals/dist/harunas-user-manual-v1.pdf`

## Screenshots

Capture screenshots from a running local app:

```bash
npm run docs:manual:screenshots
```

One local setup that matches the defaults:

```bash
APP_ENABLE_RUNTIME_BOOTSTRAP=true \
APP_ACCESS_PASSWORD=manual-password \
APP_SESSION_SIGNING_SECRET=manual-session-secret \
PAIRING_SIGNING_SECRET=manual-pairing-secret \
STORE_BACKEND=memory \
LIVE_STT_MODE=mock \
LIVE_STT_ALLOW_MOCK_FALLBACK=true \
ALLOW_MOCK_SOAP_FALLBACK=true \
FINALIZE_MODE=inline \
GATEWAY_PORT=8081 \
npm run start:gateway
```

In another shell:

```bash
GATEWAY_BASE_URL=http://localhost:8081 npm run dev:web
```

Defaults used by the capture script:

- Web app: `http://localhost:3000`
- Gateway: `http://localhost:8081`
- Organization code: `clinic_tokyo_001`
- Login ID: `admin`
- Password: `manual-password`

Override them with environment variables when needed:

```bash
MANUAL_WEB_BASE_URL=http://localhost:3000 \
MANUAL_GATEWAY_BASE_URL=http://localhost:8081 \
MANUAL_ORG_CODE=clinic_tokyo_001 \
MANUAL_LOGIN_ID=admin \
MANUAL_PASSWORD=manual-password \
npm run docs:manual:screenshots
```

The Markdown source can include optional screenshot comments like this:

```markdown
<!-- screenshot: ../assets/screenshots/v1/login.png alt="ログイン画面" caption="病院コード、個人ID、ログイン用パスワードでログインします。" -->
```

When the image file exists, the build script inserts it into the HTML/PDF. When the file is missing, the comment is omitted so the first manual build does not contain broken images.

Recommended screenshot names are listed in `docs/manuals/assets/screenshots/v1/README.md`.

## Versioning

For the next major manual revision, copy the Markdown source to a new file, for example:

```text
docs/manuals/src/user-manual-v2.md
```

Then adjust the default input/output in `docs/manuals/scripts/build-pdf.mjs` or pass explicit paths when extending the script.
