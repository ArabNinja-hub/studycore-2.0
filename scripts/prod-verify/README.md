# Production verification harness — single-active-device

Tooling used for the final production-flow verification of the one-active-device
authentication feature. It boots the **unmodified production build** (`NODE_ENV=production`)
and drives it over real HTTP with independent device sessions (separate cookie jars,
User-Agents and per-device public IPs so rate limiters see real device separation).

It patches **nothing** in the app. The only seam used is the email transport's existing
test hook (`__setTestSender`, the same one `scripts/test-emails.js` uses), which captures
every dispatched email verbatim to `emails.jsonl` — because a sandbox can never receive
real Resend deliveries. Everything else (cookies, JWTs, HTTPS-style redirects, SQLite
session/challenge rows, rate limits, admin API) is the real production path.

## Run

```bash
# terminal 1 — production build on 0.0.0.0:4387 (live preview usable in real browsers)
JWT_SECRET=<64 hex chars> R2_ACCOUNT_ID=x R2_ACCESS_KEY_ID=x R2_SECRET_ACCESS_KEY=x \
R2_BUCKET_NAME=x node scripts/prod-verify/launcher.js /tmp/prod-verify-run

# terminal 2 — the 35-check flow driver (steps 1-13 + edge cases + security)
BASE_URL=http://127.0.0.1:4387 RUN_DIR=/tmp/prod-verify-run JWT_SECRET=<same> \
node scripts/prod-verify/run.js
```

`R2_*` are placeholder values required by the production boot gate; the auth flows under
test never touch object storage. Exit code is 0 only when every check passes.

## What it covers

- Steps 1-13 of the two-device handover (challenge → email → verify → old device revoked →
  logout → clean re-login), magic-link variant included.
- Wrong code, expired code, 5-attempt burn + correct code after burn, page refresh,
  browser restart mid-verification, racing takeovers ("nearly the same time"), racing
  first logins, staff exemption, pre-feature legacy accounts, restart-with-live-sessions.
- Security: no token outside session-issuing responses (69 responses scanned), HttpOnly
  cookies, codes/tokens never in API responses or server logs, revoked-token replay,
  direct-API bypass attempts, admin audit feed redaction, admin revoke.

## After deploying to production (manual close-outs the sandbox can't do)

1. **Real email delivery** — with `RESEND_API_KEY` set on the host, register a student on a
   mailbox you own, log in from a second device/browser, and confirm the "New device login
   verification" email arrives (subject `StudyCore: New device login verification`), that the
   6-digit code verifies, and that `/device-verify.html?t=...` link verifies in one tap.
2. **Mobile rendering** — open `/device-verify.html` and `/login.html?session=signed-in-elsewhere`
   on a real phone to eyeball layout; the desktop/mobile *protocol* behaviour is already
   verified (the driver runs the phone UA end-to-end).

The runner exits non-zero on any failure, so it also works as a post-deploy smoke check
against the live host for everything except items 1-2 above (point `BASE_URL` at the real
host and pre-seed fixtures accordingly).
