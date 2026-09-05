# Bug audit and code walkthrough

Date: 2026-09-05

## The code, decoded

StudyCore is one Node/Express application, not separate frontend and backend services:

```text
Browser: public/*.html, public/js/*, protected views/*
  → public/js/api.js: relative /api URLs and session cookies
  → server.js: CORS, request parsing, security headers, rate limits, routes
  → middleware/auth.js: verify JWT; reload account state, role and program
  → routes/*: validate requests and enforce feature-specific permissions
  → lib/program-access.js: program targeting AND course membership
  → db/index.js: SQLite users, courses, resources, subscriptions and progress
  → lib/storage.js: private R2 objects, or local files during development
```

The database is authoritative: a JWT identifies a user but must not determine their current role, program or subscription. Main Admin manages the platform; Content Admin publishes their own resources; students receive content according to program/course membership and subscription rules.

There are **two course APIs**: legacy subject pages (`/api/courses`) and dynamic program courses (`/api/programs`). Both remain reachable. Quizzes also share the `resources` table while having a dedicated authoring/grading API (`/api/quiz`). These overlapping paths explain several bugs: securing the new API alone did not secure the older routes or shared serializers. Some older README sections describe quizzes as removed; the current application includes a dedicated quiz experience.

## Confirmed issues fixed

| Area | Before | Fix |
| --- | --- | --- |
| Browser requests / CORS | The server assumed same-origin requests omit `Origin`. Browser login and other writes failed on local/custom deployment hosts. | Accept the request's exact scheme/host/port, including trusted proxy TLS, while retaining the external-origin allowlist. Do not use `X-Forwarded-Host` to grant access. |
| Program and course permissions | Direct access returned early for `target_all`, skipping course membership. Unassigned students could list course-bound content, and legacy course pages exposed other programs' resources. | Apply both restrictions to direct reads/writes and SQL listings; filter legacy course homes and lesson navigation too. Global, course-independent resources remain available to unassigned students. |
| Quiz availability | Authentication attached identity/role but omitted `program_code`, so targeted quizzes disappeared or returned 403 to correctly enrolled students. | Attach the current database program on every authenticated request, overriding stale/missing token fields. |
| Quiz answer keys and Premium access | Generic resource list/detail/bookmark responses serialized full `quiz_data`, including answers. Generic detail access also treated quizzes as trial-accessible documents. | Students receive `quizData: null` on generic resources. Quiz content follows the canonical Premium gate; questions come from the quiz API without answer keys. Authoring access remains intact. |
| Forged quiz scores | The legacy `POST /api/resources/:id/quiz-attempt` accepted a student's claimed `score` and `total`, without server grading. | Retire score-only writes with HTTP 410. The current UI already submits answers to `POST /api/quiz/:id/attempt`, where the server calculates the result. |
| Quiz display and history | The UI received missing point/targeting metadata; history read `createdAt` from a `created_at` database row; `value || 50` replaced a valid zero-percent pass mark. | Return the required metadata and timestamps, and preserve zero consistently in the API and quiz editor/student UI. |
| Async errors and registration | Express 4 did not forward rejected route promises. Malformed login/password fields, duplicate concurrent signups and media errors could leave requests hanging. | Wrap async handlers so errors reach the sanitized HTTP error handler. Validate credential types before string/bcrypt operations. Use SQLite email-conflict handling so simultaneous registrations return one 201 and one 409. |
| Upload rate limits | Viewing an avatar 11 times or listing resources 31 times exhausted an upload allowance. | Count mutations rather than GET/HEAD requests. Upload/change limits and broader admin limits remain enforced. |
| Dashboard progress | Singular category names were used to read plural SQL aliases, reporting zero lessons. Progress also counted drafts, announcements and retargeted resources. | Calculate counts and completions from the same visible, published learning-resource set used by the course home. |
| Media responses | SVG neutralization reassigned a `const`. Unicode filenames were inserted directly into an HTTP header, causing `ERR_INVALID_CHAR`. | Compute a separate safe response MIME type. Preserve the Unicode filename in `filename*` with an ASCII fallback. Legacy SVGs remain inert attachments; PDF range/HEAD behavior is covered. |

## Compatibility and deployment notes

- No database schema migration or new runtime dependency is required.
- The old score-submission endpoint intentionally returns **410 Gone**. Integrations must submit answers to `/api/quiz/:id/attempt`, not calculated scores.
- Historical quiz-attempt reads remain available. Existing scores are **not** deleted or retroactively verified by this patch.
- Generic student resource responses no longer expose quiz questions/answer keys through `quizData`; use the dedicated quiz endpoint.
- Same-origin deployments do not need an extra CORS entry. Explicitly trusted *external* frontends still use `CORS_ALLOWED_ORIGINS`.

## Verification

```bash
npm ci
npm test

# Run only the new regression suites:
node --test scripts/test-http-regressions.js scripts/test-learning-regressions.js
```

- Original suite: **35 passing tests**, despite the bugs above.
- Added **21 regression tests**; the initial regression run reproduced failures in 19 checks, with two existing CORS protections already passing.
- After fixes: **56 passing tests, 0 failures**.
- The new suites use isolated temporary SQLite databases and local object stores. They cover positive and denied access, reverse-proxy Origin headers, upload throttling, registration races, sanitized async failures, quiz grading/history, progress counts and media headers/ranges.
- Application JavaScript parsing is included in `npm test`; `git diff --check` also passes.

This was a targeted code/HTTP audit, not an exhaustive security assessment. Live Cloudflare R2, real SMTP delivery and full browser/device playback were not exercised. Upload replacement/cleanup under storage failures and large-file/device behavior remain useful staging-test follow-ups.
