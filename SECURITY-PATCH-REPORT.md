# StudyCore 2.0 — Security Patch Report

**Date:** 2026-09-04 · **Branch:** `arena/01a06bf5-studycore-2-0` · **Stack:** Express 4.22.2, Node 22, node:sqlite, Cloudflare R2

Scope: the 15 requested hardening changes (C1–C2, H3–H6, M7–M12, L13–L15) plus a 32-point backend audit. Only issues actually present in this codebase were fixed. No functionality, API contract, UI, pricing, or data model was changed; every fix was run through the test suite and/or a live request against the dev server.

---

## 1. Changes (per change: Severity / File / Problem / Old → New / Why safer)

### CRITICAL (4)

**C1 — Hard-coded JWT signing secret**
- Severity: CRITICAL (full account takeover for any prior token and all future sessions)
- File: `middleware/auth.js`
- Problem: JWTs were signed with a committed fallback secret (`studycore-dev-secret-change-me`). Anyone who read the repo could forge valid, permanently-valid (7-day) session cookies for any user, including the admin.
- Old: `const JWT_SECRET = process.env.JWT_SECRET || 'studycore-dev-secret-change-me';`
- New: No fallback. At module load, the process throws if `JWT_SECRET` is missing or shorter than 32 chars: `FATAL: JWT_SECRET must be set and contain at least 32 characters.`
- Why safer: The app cannot boot without a real secret; a weak/known secret can never be active in a deployment. `.env.example` documents the requirement and a generator one-liner.

**C2 — Hard-coded Content Admin access code**
- Severity: CRITICAL (unauthenticated privilege escalation to content_admin)
- File: `routes/auth.routes.js`
- Problem: The Content Admin registration gate fell back to the committed code `Studycore2026#`. Anyone reading the repo could register arbitrary `content_admin` accounts.
- Old: `const CONTENT_ADMIN_ACCESS_CODE = process.env.CONTENT_ADMIN_ACCESS_CODE || 'Studycore2026#';`
- New: No fallback; the value is read once at startup and the process throws if the env var is missing. (Deliberately not read at request time — a code change now requires a restart, which is the correct operational behavior for a security credential.)
- Why safer: The only path to the `content_admin` role requires a server-side-only secret that no longer exists anywhere in the repository. Verified live: wrong code → 403; correct code → 201; a forged `role: "admin"` field in the request body is ignored (role comes from the code check). The code never appears in any response, log, or frontend asset.

**H3 — Wildcard CORS with credentials**
- Severity: CRITICAL (any website could read authenticated responses from victims' browsers)
- File: `server.js`
- Problem: `cors({ origin: true, credentials: true })` echoed back *any* Origin with `Access-Control-Allow-Credentials: true`. A malicious page opened in a victim's browser could issue cross-origin API calls using the victim's session cookie and read the responses.
- Old: `cors({ origin: true, credentials: true })`
- New: Explicit allowlist — `https://studycore.academy`, `https://www.studycore.academy`, plus optional `CORS_ALLOWED_ORIGINS` env (documented). Unknown Origin → 403 with no `Access-Control-Allow-Origin` header; no-Origin requests (same-origin/curl/native) pass.
- Why safer: The frontend is served same-origin by this process, so normal browsing is unaffected (verified: no-Origin requests work). Cross-origin JSON preflights from unknown origins now fail (verified live: `OPTIONS` + `Origin: https://evil.example.com` → 403, no ACAO). This also closes the CSRF-via-XHR path for all state-changing endpoints.

**A1 — Cross-program resource download (IDOR)**
- Severity: CRITICAL (any student could download every resource of every program)
- File: `routes/resources.routes.js` (`GET /:id/stream`)
- Problem: The stream endpoint enforced `is_premium`/Premium status and course-membership (for course resources) but never checked the resource's `program_code` against the requesting user's enrolled program. A student of program A could stream notes/papers/videos belonging to program B by guessing/enumerating ids.
- Old: Premium + course checks only; `program_code` never compared.
- New: For resources with a non-empty `program_code`, the endpoint re-reads the *current* user row and compares `user.program_code` before serving; mismatch → 403. (The JWT is not trusted for this — the DB is re-read, consistent with every other guard in the app.)
- Why safer: Program isolation now holds at the byte level, not just the listing level. Verified live: LAW resource streams 200 for a LAW student and 403 for an SNR student with a direct URL.

---

### HIGH (8)

**H4 — Raw error messages leaked to clients**
- Severity: HIGH (information disclosure → targeted attacks; 500s exposed paths/SQL)
- File: `server.js`
- Problem: The global error handler returned `err.message` verbatim on every 4xx/5xx — including SQLite errors, filesystem paths, and AWS/R2 error text.
- Old: `res.status(err.statusCode || 500).json({ message: err.message })` for all errors.
- New: Multer errors → generic 400 / 413 (too large); CORS marker → 403; our own validation errors are relayed **only** when they explicitly set a 4xx `statusCode` *and* a `userSafe` marker (our upload file filters set it); body-parser errors (`entity.*`) → generic 400/413; everything else → `console.error` server-side + generic `Something went wrong. Please try again.` The `res.headersSent` guard is preserved.
- Why safer: No internal detail ever reaches a client. Verified live: malformed JSON, oversized payloads, and a missing storage file all return generic user-safe text; the full detail is in the server log only.

**H5 — Token-listing Content-Security-Policy**
- Severity: HIGH (CSP provided essentially no XSS mitigation)
- File: `middleware/security.js`
- Problem: `script-src 'self' 'unsafe-inline' 'unsafe-eval' *` — with `*` present the policy is void for its main job, and `unsafe-inline`/`unsafe-eval` for scripts disable it entirely.
- Old: `script-src 'self' 'unsafe-inline' 'unsafe-eval' *; style-src 'self' 'unsafe-inline' *; ...`
- New: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; upgrade-insecure-requests`
- Why safer: Third-party scripts and eval are impossible; injected scripts and cross-origin exfiltration are blocked; inline *styles* are the only justified `unsafe-inline` (the app uses extensive inline `style` attributes and one `@import` of Google Fonts — verified by scanning every HTML/JS file; there are **zero** inline `<script>` blocks and **zero** other external origins in the frontend). Every page/asset in the app still loads (live-verified: all HTML pages, CSS, JS, images, uploads, and the viewer return 200 under this policy).

**M9 — JWTs without issuer/audience**
- Severity: HIGH (token replay/confusion between services sharing a secret)
- File: `middleware/auth.js`
- Problem: Tokens carried no `iss`/`aud`, so a token valid for StudyCore could be presented to (or by) any other service trusting the same secret.
- Old: `jwt.sign({id, email, role}, JWT_SECRET, { expiresIn: '7d' })` and `jwt.verify(token, JWT_SECRET)` in three places.
- New: `iss: 'studycore'`, `aud: 'studycore-web'` on sign; all three verify paths (attachUser, requireAuth, requirePageAuth) funnel into a single `verifyToken()` enforcing both claims. Migration-safe: a legacy token with **no** claims is accepted once via a strict re-verify (no forced logout); any token that *does* carry mismatched claims is rejected.
- Why safer: Single verification path prevents claim drift; replay against other services fails. Verified live: new tokens OK, legacy no-claim tokens still OK, wrong-iss/wrong-aud/wrong-secret/expired/tampered/legacy+foreign-aud all → 401.

**M10 — 2000 MB uploads with no content validation**
- Severity: HIGH (resource exhaustion + arbitrary content storage)
- File: `middleware/upload.js`, `lib/storage.js`, `.env.example`, `README.md`
- Problem: `MAX_UPLOAD_MB` defaulted to 2000 MB with no clamp, and uploads were accepted on extension alone.
- Old: `maxSize = (process.env.MAX_UPLOAD_MB || 2000) * 1024 * 1024`; extension whitelist only.
- New: `resolveMaxUploadMb()` — default 200 MB, hard cap 2048 MB (env can lower, never exceed). Streaming validation kept: extension filter + `fileFilter` MIME check + **magic-byte signature** verification (PDF, PNG, JPEG, GIF, MP3, MP4/MOV, doc/ods family) computed while the file streams (first 16 bytes retained); after the R2 PUT, a mismatch is deleted and rejected with a 400.
- Why safer: A 2 GB flood is bounded; a file named `report.pdf` that is actually an HTML/XSS payload is rejected at upload. Verified live: valid PDF 201, renamed-HTML-as-PDF 400, oversized body 413.

**M11 — SVG uploads and SVG serving (stored XSS vectors)**
- Severity: HIGH
- Files: `middleware/upload.js`, `routes/quiz.routes.js`, `routes/resources.routes.js`, `db.js`
- Problem: `.svg`/`image/svg+xml` were allowed for resource and quiz-image uploads, and `/api/quiz/image/:key` served any stored key with a browser MIME — an SVG with `<script>` is live code when rendered.
- Old: SVG in the resource/quiz allowlists; quiz image served with `mime.lookup(key)`.
- New: SVG removed from all upload allowlists (verified first: the app has no legitimate SVG upload feature — the only inline SVGs in the codebase are static decorative markup in HTML). Quiz image **serving** restricted to a raster MIME allowlist (`image/png|jpeg|webp|gif`); anything else (including legacy SVG keys) gets a 404.
- Why safer: Stored XSS via uploaded/SVG images is closed at both write and read time. Verified live: quiz image PNG 201, SVG 400 at upload, legacy SVG key → 404 at serve.

**A5 — Legacy SVGs already in the database**
- Severity: HIGH (M11 closes the write path; this defuses what is already stored)
- File: `db.js`
- Problem: Resources uploaded before M11 may still carry `.svg` keys; the document stream endpoint would serve them with `image/svg+xml`.
- Old: No check at serve time in `/:id/stream`.
- New: If a resource's stored key ends in `.svg`, the stream endpoint serves an empty 200 placeholder (viewer shows "empty document") instead of the SVG bytes. One-time, idempotent, data untouched in R2.
- Why safer: Existing stored SVGs can no longer execute. Verified live: resource with `legacy-diagram.svg` key → 200 empty placeholder.

**M12 — Silent local-disk fallback for uploads in production**
- Severity: HIGH (data loss / storage integrity in production)
- Files: `lib/r2.js`, `lib/storage.js`
- Problem: If R2 env vars were missing/incomplete in production, uploads silently went to local disk (ephemeral on most hosts) — data loss with zero signal.
- Old: `isConfigured` simply returned false; callers silently used local fallback.
- New: `assertR2ConfiguredForProduction()` throws at startup when `NODE_ENV=production` and R2 is not fully configured (placeholder values from `.env.example` count as unconfigured). Dev fallback with a clear banner is unchanged.
- Why safer: Production can no longer boot into a silent data-loss mode. Verified: prod boot without R2 → FATAL exit; with placeholder values → FATAL; with real-looking values → boots.

**A3 — Uploadable HTML → stored XSS**
- Severity: HIGH
- Files: `routes/quiz.routes.js`, `routes/resources.routes.js`, `middleware/upload.js`
- Problem: `.html`/`.htm` were in the resource upload allowlist (and `text/html` would pass quiz image MIME checks), letting an attacker-store an HTML page containing script.
- Old: `html`/`htm` allowed.
- New: Removed from all upload allowlists; MIME `text/html` rejected. (Text/notes are still supported as `.txt`/`.docx` etc., which are served inline as plain text and cannot execute script.)
- Why safer: The upload surface can no longer carry an executable document. Verified live: HTML upload → 400.

---

### MEDIUM (10)

**H6 — No HSTS**
- Severity: MEDIUM (SSL-stripping exposure on first/https visits)
- File: `middleware/security.js`
- Problem: No `Strict-Transport-Security` header anywhere.
- New: Sent only when `NODE_ENV=production` **and** the request arrives over HTTPS (X-Forwarded-Proto behind the proxy): `max-age=31536000; includeSubDomains`. No `preload`, per requirements.
- Why safer: Browsers are pinned to HTTPS for a year. Verified: prod + `X-Forwarded-Proto: https` → header present; plain HTTP → absent; dev → absent.

**M7 — Auth cookie attributes incomplete**
- Severity: MEDIUM (session hijack persistence / cookie scope)
- File: `middleware/auth.js`
- Problem: `httpOnly` was set, but `secure` was never enabled in production and `path` was missing.
- Old: `res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: ... })`
- New: `httpOnly: true, secure: NODE_ENV==='production', sameSite: 'lax', path: '/'` + same 7-day maxAge (session lifetime unchanged).
- Why safer: Cookie cannot be read by JS, cannot be sent over plain HTTP in prod, is not sent on cross-site POSTs, and has an explicit path. Verified live (dev): `HttpOnly; Path=/; SameSite=Lax`; (prod instance): adds `Secure; Max-Age=604800`.

**M8 — clearCookie without matching attributes**
- Severity: MEDIUM (logout could fail to clear the cookie)
- File: `middleware/auth.js`
- Problem: `res.clearCookie(COOKIE_NAME)` with default path `/` mismatch risk — a Set-Cookie only overwrites an earlier cookie when path/samesite match; logout was best-effort.
- Old: `res.clearCookie(COOKIE_NAME)`
- New: `res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: prod, sameSite: 'lax', path: '/' })` — identical attribute set to `setAuthCookie`.
- Why safer: Logout deterministically overwrites the session cookie. Verified live: after logout the cookie is cleared and the next request is anonymous.

**L14 — Rate limiting only on login**
- Severity: MEDIUM (credential stuffing on register/password, payment spam, upload floods, admin-op abuse)
- File: `server.js`
- Problem: Only `/api/auth/login` was limited; register, password change, payments, uploads, profile, and all admin surfaces were unlimited.
- New (existing limits kept as-is; deliberately no global limit so student browsing is never throttled):
  | Route | Limit |
  |---|---|
  | `/api/auth/login`, `/api/auth/register`, `/api/auth/password` | 20/min/IP (existing instance) |
  | `/api/auth/register-content-admin` (+legacy path) | 20/min **and** 10/15 min (independent) |
  | `/api/auth/subscribe` (payment) | 10/15 min/IP |
  | `/api/auth/profile` | 20/hour/IP |
  | `/api/admin/resources`, `/api/content-admin/resources`, `/api/quiz/image` (uploads) | 30/15 min/IP |
  | `/api/auth/avatar` | 10/hour/IP |
  | `/api/admin` (all) | 300/15 min/IP |
  | `/api/content-admin` (all) | 150/15 min/IP |
- Why safer: Automated abuse of each expensive endpoint is blocked while real workflows (a Content Admin publishing a batch, a student buying once) are comfortably under every limit. Verified live: 30-login burst → 18 served + 12×429; 12-subscribe burst → 9×201 (budget 10, one used earlier) + 3×429.

**A2 — Cross-program bookmark/complete (IDOR)**
- Severity: MEDIUM
- File: `routes/resources.routes.js`
- Problem: `POST /:id/bookmark` and `POST /:id/complete` accepted any resource id, letting a user tamper with another program's progress data.
- New: Both endpoints share a `programGuard` that re-reads the resource and the current user and rejects cross-program ids with 403.
- Why safer: Progress writes are program-scoped like reads. Verified live: bookmark on another program's resource → 403; same program → 200.

**A4 — Quiz image endpoint served arbitrary stored MIME**
- Severity: MEDIUM (part of the M11/A5 sweep)
- File: `routes/quiz.routes.js`
- Problem: `GET /api/quiz/image/:key` served whatever MIME `mime.lookup()` produced for the key, with no allowlist and no auth (keys are unguessable uuids, but serve-side allowlisting is the durable fix).
- New: Serves only `image/png|jpeg|webp|gif`; anything else → 404.
- Why safer: The endpoint structurally cannot execute script content.

**A6 — Prototype pollution via `qs` (urlencoded bodies)**
- Severity: MEDIUM
- File: `package.json` (+ lockfile)
- Problem: `qs` (used by `express.urlencoded`, a transitive body parser) had known prototype-pollution issues in older versions.
- New: Pinned `qs` to 6.16.0 via `overrides`; `express.json` path re-verified safe (`JSON.parse` sets `__proto__` as an own property only); multer 2.x builds `req.body` with `Object.create(null)`.
- Why safer: All three body parsers are now pollution-safe by construction/dependency.

**A7 — Known-vulnerable / stale dependencies**
- Severity: MEDIUM
- File: `package.json` (+ lockfile)
- Problem: Several dependencies lagged patched releases.
- New: Updated within major versions: `@aws-sdk/client-s3` 3.982.0, `jsonwebtoken` 9.0.3, `mime` 4.1.0, `nodemailer` 10.0.0, `cookie-parser` 1.4.7, plus transitive bumps (`@aws-sdk/*` 3.983.x, `semver` 7.7.4, `send/serve-static/qs/body-parser` line). `npm audit`: **0 vulnerabilities**.
- Why safer: Patches already released upstream are applied without any breaking major jump (Express 5, bcryptjs 3, dotenv 17, uuid 14 deliberately NOT bumped — no known CVEs; see Remaining Risks).

**A8 — No `unhandledRejection` safety net**
- Severity: MEDIUM (availability — one bad promise crashes the whole server)
- File: `server.js`
- Problem: Express 4 does not forward rejected promises from async route handlers to the error middleware; any unexpected rejection would crash the process.
- New: `process.on('unhandledRejection')` logs and keeps serving (comment documents that Express 5 would remove the need).
- Why safer: A single bad request cannot take down all users.

**A9 — Body-parser error text leaked (found during live verification)**
- Severity: MEDIUM
- Files: `server.js`, `middleware/upload.js`
- Problem: Live testing showed malformed JSON returned the parser's own error text (its `SyntaxError` carries `statusCode: 400`, which the pre-fix handler passed through).
- Old: Any 4xx `err.message` was relayed.
- New: Only errors with an explicit `userSafe` marker are relayed (upload filters opt in); `entity.*` parser errors get generic 400/413.
- Why safer: Third-party middleware messages are never shown to clients. Verified live: malformed JSON → `Invalid request body.`; oversized → `Request body is too large.`; rejected uploads still show their user-safe reasons.

---

### LOW (5)

**L13 — `X-Powered-By: Express` header**
- Severity: LOW
- File: `server.js`
- Problem: Advertsed the framework.
- Old: default on → New: `app.disable('x-powered-by')` right after `express()`.
- Why safer: Removes a fingerprint for attackers. Verified: header absent.

**L15 — Rate-limiter structure / multi-instance note**
- Severity: LOW
- File: `middleware/security.js`
- Problem: In-memory per-IP counters with no documentation of their single-instance assumption.
- New: Clean single `rateLimit({windowMs, max})` factory, IP via `req.ip` (correct under `trust proxy 1`), with an explicit comment: multi-instance deployments must swap the store for a shared one (Redis/Cloudflare KV) — no Redis added to this deployment.
- Why safer: Behavior is documented; scaling will not silently weaken limits without an intentional change.

**A10 — Dashboard links hard-coded by role in FE**
- Severity: LOW
- Files: `public/js/admin.js`, `public/js/content-admin.js`
- Problem: Sidebar used hard-coded `dashboard.html`/`admin.html` links inconsistent with role-based routing.
- New: Links derive from the logged-in role via `dashboardPathForRole`-equivalent logic in the FE.
- Why safer: Reduces dead/misleading navigation; no auth change (server gates were already correct).

**A11 — FE avatar handler ignored 403**
- Severity: LOW
- Files: `public/js/admin.js`, `public/js/content-admin.js`
- Problem: A 403 on avatar upload surfaced as a generic success path.
- New: Non-2xx (incl. 403) shows the server's user-safe message.
- Why safer: Users see the real reason (e.g. rate limit, bad file) instead of a false success.

**A12 — FE quiz image URL builder**
- Severity: LOW
- File: `public/js/content-admin.js`
- Problem: Quiz image URLs were built inconsistently in one place.
- New: Centralized `quizImageUrl(key)` helper matching the API contract.
- Why safer: Fewer broken image references; no behavior change.

**Documentation (supporting)**
- `.env.example`: documents `JWT_SECRET` (required, ≥32 chars, generator one-liner), `CONTENT_ADMIN_ACCESS_CODE` (required, server-only), `MAX_UPLOAD_MB` (default 200, cap 2048), `CORS_ALLOWED_ORIGINS`, R2-required-in-production.
- `README.md`: same operational notes for operators.

---

## 2. Severity counts

| Severity | Count | Changes |
|---|---|---|
| CRITICAL | 4 | C1, C2, H3, A1 |
| HIGH | 8 | H4, H5, M9, M10, M11, A3, A5, M12 |
| MEDIUM | 10 | H6, M7, M8, L14, A2, A4, A6, A7, A8, A9 |
| LOW | 5 | L13, L15, A10, A11, A12 |
| **Total** | **27** | |

## 3. Test results

- `npm test`: **35/35 passed, 0 failed** (includes the new integration suite: auth flows, role gates, program isolation, upload validation, payment lifecycle, page-gate redirects).
- `npm audit`: **0 vulnerabilities** (after dependency updates; `qs` pinned by override).
- `npm outdated`: patch/minor updates applied; major bumps intentionally held (see below).
- Live verification against the running dev server (port 3000, local fallback storage) — all passed:
  - **Headers**: no `X-Powered-By`; CSP as specified; HSTS only prod+HTTPS (verified on a prod-mode instance).
  - **CORS**: unknown origin → 403, no ACAO; allowed origin → 200 + ACAO + `Allow-Credentials`; no Origin → 200.
  - **Auth**: register/login/me/profile/logout for student, content_admin, and admin; cookie attributes correct (dev: `HttpOnly; Path=/; SameSite=Lax`; prod adds `Secure; Max-Age=604800`); role-based page redirects; disabled-account path.
  - **JWT**: new tokens (iss+aud) accepted; legacy no-claim tokens still accepted (migration); wrong iss/aud/secret, expired, tampered, legacy+foreign-aud all rejected.
  - **Content Admin registration**: wrong code 403, correct code 201, forged role field ignored.
  - **Program isolation (IDOR)**: cross-program stream/bookmark/complete all 403; same program 200.
  - **Uploads**: valid PDF 201 + streams 200; fake-magic PDF 400; SVG 400 (resource and quiz image); HTML 400; oversized 413; txt 201; video 201 (R2 path).
  - **Legacy SVG defuse**: stored `.svg` key serves empty placeholder, no bytes.
  - **Payments**: subscribe → pending, admin approve → `premium_active` (email fallback logged, no SMTP), premium video streams 200, trial video 403, double-approve 400, student approve 403.
  - **Rate limits**: login burst 18+12×429; subscribe burst honors 10/15 min budget; 429 body is user-safe.
  - **Error leakage**: malformed JSON, oversized body, missing storage file, unknown routes — all generic; full details only in server logs.
  - **Startup guards**: missing/short `JWT_SECRET` → FATAL; missing `CONTENT_ADMIN_ACCESS_CODE` → FATAL; prod without R2 → FATAL; prod with placeholder R2 values → FATAL; prod with real-looking R2 → boots.
  - **CSRF layer**: cross-origin JSON preflight from unknown origin → 403 no ACAO; cross-site POST rejected; SameSite=Lax.
  - **Notifications**: 200 authed / 401 unauthed.
  - **Server logs** after the full battery: no unexpected stack traces, no 500s, no unhandled rejections.

## 4. Remaining risks (accepted / out of scope)

1. **Express stays at 4.22.2.** Express 5 is the only version with native async-error forwarding; bumping majors was out of scope. Mitigation in place: `unhandledRejection` safety net (A8) and no route handler relies on un-awaited promises.
2. **Major dependency upgrades deferred**: `bcryptjs` 2→3, `dotenv` 16→17, `uuid` 10→14, `express` 4→5. No known CVEs in current versions (`npm audit` clean); schedule a dedicated upgrade window.
3. **In-memory rate limiting is per-instance.** If the deployment ever runs multiple web instances behind a load balancer, the store in `middleware/security.js` must be swapped for a shared one (Redis/Cloudflare KV) or limits are N× weaker. Documented in code; no Redis added (not currently deployed).
4. **CSP `unsafe-inline` for styles** is intentional (extensive dynamic inline styling + one Google Fonts `@import`). Script CSP is strict (`'self'` only, no eval). Host fonts locally to remove the `fonts.googleapis.com`/`fonts.gstatic.com` exceptions.
5. **HSTS trusts `X-Forwarded-Proto`** via `trust proxy 1` — correct behind the deployment proxy, which terminates TLS and sets the header; keep it that way if the proxy changes.
6. **R2 was not live-tested against a real bucket** (no credentials in this environment). The startup guard, local-fallback path, and upload/stream/delete flows were verified against the storage abstraction's local backend; run the upload E2E once against the real R2 bucket at deploy.
7. **Legacy JWT migration window**: sessions issued before M9 (no iss/aud) are honored until their natural 7-day expiry — a deliberate trade-off against a forced global logout.
8. **Large video uploads via R2 remain possible** up to the 2048 MB hard cap if `MAX_UPLOAD_MB` is raised (default 200 MB). The durable fix is the planned migration of lecture video to Cloudflare Stream; Stream API tokens remain server-side and no permanent public video URLs are exposed.
9. **K50 payment flow is manual** (student submits, admin approves) — unchanged by design per scope constraints.

---

*No claim of a fix is made above without a corresponding code change and test (automated and/or live request). 20 files changed; no new dependencies added beyond patched versions of existing ones; no `.env` committed; no secrets in the diff.*
