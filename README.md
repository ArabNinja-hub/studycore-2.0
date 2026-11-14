# StudyCore

A modern **university learning platform** — courses, structured lessons, video learning,
study notes, past papers and revision resources together in one place, built around a
clear **Course → Topic → Lesson** hierarchy.

Full rebuild of the student experience on top of the same battle-tested backend:
Node 22 / Express / SQLite (`node:sqlite`) with JWT cookie sessions, Cloudflare R2 file
storage, and manual mobile-money (MTN MoMo / Airtel Money) subscription approval.

## The learning model

```
StudyCore
└── Course            (Mathematics, Physics, Chemistry, Biology, Programming, Communication Skills)
    └── Topic         (e.g. Physics → Circular Motion)   — set per resource by the admin
        └── Lesson    (video lesson / notes / tutorial sheet / past paper)
            ├── Video        (StudyCore in-app player — Premium only)
            ├── Notes        (StudyCore document viewer — free during trial)
            ├── Related resources
            ├── Mark complete
            └── Previous / Next lesson
```

- **Course home page** (`/pages/subjects/<slug>.html`): unique animated hero per course
  (lightweight canvas, respects `prefers-reduced-motion`, loaded only on course pages),
  continue-learning card, topics with per-topic progress, all lessons, notes, past papers
  (grouped by year) and overall progress.
- **Video Lessons page** (`/pages/videos.html?course=<slug>`): every video lesson for
  one course, rendered as **cards on term shelves** — Term 1 / Term 2 / Term 3, plus an
  "Other" shelf for videos uploaded before terms existed, so each video sits in its
  designated term and nothing is hidden. Each course home shows the terms as cards;
  clicking one deep-links (`&term=<Term N>`) straight to that term's shelf. The term
  strip on the page scrolls between shelves and shows per-term counts.
- **Lesson experience** (`/pages/lesson.html?id=…&subject=…`): breadcrumbs, the StudyCore
  video player (resume position, speed, fullscreen, progress + completion tracking) or the
  StudyCore document viewer, key concepts, related resources, mark-complete, and
  previous/next navigation. The document viewer renders **PDFs** (pdf.js → canvas) and
  **Word `.docx`** (mammoth → HTML) in-browser; it sniffs the file's real bytes so a file
  uploaded without an extension (or with a mismatched mime) still opens with the right
  renderer. Unsupported types show an honest preview-unavailable message and remain
  view-only—there is no source-file download fallback.
- **Quizzes** (`/quiz.html`): live. Practice quizzes are written by Content Admins and the
  Main Admin, targeted at programs, and marked by the server. See
  [Quizzes](#quizzes-quizhtml) below.

## Access control (enforced server-side)

| Content                | Free trial (30 days) | Trial expired | Premium active |
|------------------------|----------------------|---------------|----------------|
| Video lessons          | **locked** (Premium only) | locked | unlocked |
| Quizzes                | **locked** (Premium only) | locked | unlocked |
| Notes / tutorials / past papers | unlocked | **locked** unless free preview | unlocked |
| Free previews (`is_premium = 0`) | unlocked | unlocked | unlocked |
| Announcements          | unlocked | unlocked | unlocked |

Everything is checked against the **users table on every request** — never against the
client. Video *stream* URLs are only reachable through `GET /api/resources/:id/stream`,
which re-verifies the session and subscription; streams are served with
`Cache-Control: no-store` and no permanent public URL ever exists. Video playback
position is stored per student (`video_progress`) and is itself only readable by
authorized Premium sessions. 90% watched auto-completes the lesson server-side.

Subscription states computed in `routes/auth.routes.js → subscriptionStatus()`:
`trial_active`, `trial_expired`, `premium_active`, `premium_expired`, `payment_pending`.

## Content privacy (screenshots, recording, copying)

Learning pages — lessons, the document viewer, course homes and video pages —
run a **content privacy guard** (`public/js/privacy-guard.js` +
`public/css/privacy-guard.css`). Marketing, auth and the Admin / Content Admin
dashboards are deliberately untouched, so publishers keep normal copy/paste.

- no right-click, copy, cut, selection, drag-out or `Ctrl+S`/`Ctrl+U`; copy
  attempts overwrite the clipboard with a notice
- printing and "Save as PDF" are blanked
- `Permissions-Policy: display-capture=()` means **no script in the page can
  record the tab** with `getDisplayMedia()` (browser-enforced, not a deterrent)

> **Important:** no website can truly prevent an OS screenshot — Snipping
> Tool, `PrtSc`, `Cmd+Shift+4`, OBS and a phone camera all live outside the
> browser sandbox. The above raises the effort sharply; genuine
> capture-blocking needs hardware DRM.
> Read **[`docs/content-protection.md`](docs/content-protection.md)** for the
> full threat model, the known limits, and how to move the video path onto
> Bunny Stream DRM.

## Payments

Manual mobile-money flow (no merchant API required):
1. Student pays K50 to the configured MTN/Airtel number (shown by `GET /api/auth/payment-info`).
2. Student submits phone + method + reference from the dashboard **Premium section**
   (`/dashboard.html#premium`) → creates a `PENDING` payment.
3. Admin confirms receipt on their phone and **Approves** in the admin dashboard →
   30 days of Premium is activated, and the student is **emailed an "access granted"
   confirmation** (payment confirmed, Premium active-until date, what it unlocks, and a
   start-watching link). Rejecting leaves the student's plan unchanged.

Approving **and** rejecting both email the student automatically — see
[Transactional email](#transactional-email-resend) below.

The public Pricing page routes logged-out visitors to signup and logged-in students
straight to the dashboard Premium payment section.

## Transactional email (Resend)

All StudyCore email goes through the **Resend API** via one centralized service,
`lib/email/`. Routes never talk to Resend directly, never see the API key and never
build a template — they call one named function with data already read from the
database.

**Live today** (three emails, all branded *StudyCore — Stay curious and winning*):

| Email | Trigger | Sent from |
|---|---|---|
| Welcome | a student successfully registers | `POST /api/auth/register` |
| Subscription approved | an admin approves a payment | `POST /api/admin/payments/:id/approve` |
| Subscription rejected | an admin rejects a payment | `POST /api/admin/payments/:id/reject` |

Also implemented and tested, but **not wired to any flow** (no template work needed to
enable them later): `sendLoginNotificationEmail`, `sendEmailVerificationEmail`,
`sendPasswordResetEmail`, `sendSubscriptionExpiringEmail`, `sendSubscriptionExpiredEmail`.

**Guarantees**

- **Email never breaks StudyCore.** Every send resolves to a result object and never
  throws, so a Resend outage cannot fail, delay or roll back a registration or an
  approval. An approved subscription stays approved; the admin just sees an honest
  "email could not be sent" note.
- **One action = one email.** Sends are claimed in the `email_log` table
  (`UNIQUE(kind, dedupe_key)`) *before* dispatch, keyed on the user id for the welcome
  email and the payment id for approval/rejection. Frontend retries, double-clicks,
  duplicate requests and restarts cannot produce a second message.
- **The recipient always comes from the database**, never from the request body.
- **The API key is server-side only.** `RESEND_API_KEY` is read exclusively inside
  `lib/email/` and is never logged, never returned by an API route and never present in
  any frontend asset. Log lines mask addresses (`ch****@gmail.com`) and record the
  Resend message id so delivery can be confirmed without exposing personal data.

**Configuration** — `RESEND_API_KEY` and `EMAIL_FROM` (see the table below). Links inside
emails use `APP_URL`, falling back to `https://studycore.academy`. With
`RESEND_API_KEY` unset (local dev, tests) nothing is sent: the email is reported on the
console instead and the underlying action still succeeds.

**Testing**

```bash
npm test                              # includes scripts/test-emails.js (30 checks)
node scripts/preview-emails.js ./out  # render every template to HTML - sends nothing
```

For a real end-to-end check, sign in as Main Admin and use the admin-only endpoints —
the test send always goes to *your own* stored admin address, so it can never be used as
an open relay:

```
GET  /api/admin/email/status                     # is a key configured + last 20 dispatches
POST /api/admin/email/test?template=welcome      # welcome | approved | rejected
```

## Profile pictures

`POST /api/auth/avatar` streams the image to R2, then **verifies the actual file
signature** (PNG/JPEG/WebP magic bytes) by reading the first bytes back from storage — a
disguised file is deleted and rejected. 4MB cap, image-only extension filter, stored
under a private key; only the owner's own avatar is ever served
(`GET /api/auth/avatar`). Displayed in the nav account menu, dashboard hero and profile
section, with a professional User-icon fallback (never an emoji).

## Quizzes (`/quiz.html`)

Quizzes are a live part of the student experience. (An earlier on-site community chat
room has been removed; the student community now lives in the official WhatsApp channel
and group linked from the site.)

- **Who writes them**: Content Admins and the Main Admin, from the quiz editor in their
  dashboards (`public/js/quiz-admin.js`). A quiz is stored as a resource with
  `category = 'quiz'`, so it uses the same program targeting as every other resource.
- **Who can take them**: students in a targeted program with an **active Premium**
  subscription. Quizzes are Premium-only, like videos - a free trial does not open them.
  The Main Admin can preview.
- **Marking is done by the server**: the student submits answers to
  `POST /api/quiz/:id/attempt` and the server calculates the score. Answer keys are never
  sent to students, and generic resource responses return `quizData: null` to students.
  The old score-only endpoint (`POST /api/resources/:id/quiz-attempt`) is retired and
  returns `410 Gone`.
- **History**: a student's past attempts come from `GET /api/quiz/:id/attempts/mine`.

## Project structure

```
server.js               entry point - static public/, gated views/, API routes, real 404
db/index.js             SQLite schema + safe column migrations (topic, pinned, avatar, video_progress)
middleware/auth.js      JWT cookie auth, role checks, page-level gating
middleware/security.js  security headers + in-memory rate limiting (auth endpoints)
middleware/upload.js    streaming R2 upload (SHA-256) + strict avatar upload config
lib/r2.js               Cloudflare R2 client (S3-compatible)
lib/storage.js          R2 + local-disk fallback, range-aware reads (never buffers whole files)
lib/email/              transactional email service (Resend): index.js = the eight
                        send* functions + duplicate protection, transport.js = the only
                        module that touches the API key, templates.js = branded
                        responsive HTML, config.js = env-driven settings
lib/db-backup.js        automatic database backups to R2 (startup + daily, keeps 14 days)
lib/access-policy.js    which content types are trial / Premium-only, and the lock messages
lib/programs.js, lib/program-access.js, lib/program-sharing.js
                        program + course catalogue, who may see what, shared program groups
lib/device-sessions.js  one active device per student, with email verification of a new device
lib/stream.js           Bunny Stream video upload + playback
lib/content-tickets.js  short-lived signed viewing tickets for protected media
lib/resumable-uploads.js  chunked, resumable uploads for large files
lib/terms.js, lib/lab-reports.js, lib/resource-types.js, lib/roles.js, lib/google-drive.js
                        academic terms, lab-report rules, resource types, roles, Drive links
routes/auth.routes.js   register/login/me, profile, password, avatar, subscribe, payment-info
routes/courses.routes.js  public course directory, course home (topics/progress/continue), lesson flow
routes/resources.routes.js  resource list/detail/view-only stream, search, bookmarks,
                            completion, video progress
routes/admin.routes.js  resource CRUD (incl. topic + pinned), users, payments, analytics
routes/notifications.routes.js  announcement list, unread count, per-user read tracking
routes/quiz.routes.js   quizzes: authoring, student listing, server-side marking, attempts
routes/programs.routes.js  programs and their courses (the dynamic course catalogue)
routes/content-admin.routes.js  Content Admin dashboard API (their own uploads)
routes/uploads.routes.js  resumable upload sessions
views/dashboard.html    student dashboard (Premium section #premium, profile #profile)
views/quiz.html         quiz page for students (public/js/quiz.js)
views/content-admin.html  Content Admin dashboard (uploads, quizzes)
scripts/restore-db.js   list / restore database backups (see "Database backups")
views/admin.html        admin dashboard (uploads, topics, announcements, payments, students)
public/js/icons.js      single SVG icon system (Lucide-style) - no emoji in the UI
public/js/layout.js     shared navbar / mobile nav / account menu / footer / global search overlay
public/js/player.js     StudyCore video player (custom controls, resume, progress, premium wall)
public/js/privacy-guard.js  content privacy on learning pages: copy/print/capture blocks
                            (see docs/content-protection.md)
public/js/hero.js       per-course canvas hero animations (math/physics/chem/bio/code/comm)
public/js/auth-stage.js animated backdrop behind login / signup / admin signup, and the
                        rotating study line above the card (decoration only - the form
                        works unchanged if it never loads)
public/css/auth.css     the auth "study desk" stage: navy gradient, drifting graph paper,
                        aurora, course glyphs, and the glass card that sits on it
public/js/video.js      Video Lessons page (/pages/videos.html) — per-course video cards on term shelves
public/sitemap.xml      public pages only - no dashboards, auth or admin URLs
public/robots.txt       allows public pages + brand assets; disallows private surfaces
```

## Getting started

```bash
npm install
cp .env.example .env   # then edit .env - see below
npm start
```

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` / `NODE_ENV` | Port; `production` makes cookies `secure` and enables HSTS over HTTPS |
| `JWT_SECRET` | **Required** - signs session tokens. Must be at least 32 characters; the app refuses to start without it (no dev fallback). |
| `CONTENT_ADMIN_ACCESS_CODE` | **Required** - server-side registration code for Content Admin accounts. Never exposed to the frontend; the app refuses to start without it. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Seeded admin, created once on first boot |
| `MAX_UPLOAD_MB` | Max upload size in MB (default 200, hard cap 2048) |
| `CORS_ALLOWED_ORIGINS` | Optional comma-separated extra trusted origins (defaults to `studycore.academy` + `www`) |
| `DATA_DIR` | Persistent disk path for the SQLite file (Render etc.) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 for documents/images/audio only. **Required in production**; videos never use it. |
| `BUNNY_LIBRARY_ID` / `BUNNY_API_KEY` / `BUNNY_CDN_HOSTNAME` | **Required for video uploads.** Bunny Stream library, server-only API key, and playback CDN hostname. |
| `PAYMENT_PHONE_MTN` / `PAYMENT_NAME_MTN` / `PAYMENT_PHONE_AIRTEL` / `PAYMENT_NAME_AIRTEL` | Mobile-money numbers shown on the Premium payment screen |
| `RESEND_API_KEY` | **Server-only secret.** Resend API key for the welcome / subscription-approved / subscription-rejected emails. Never exposed to the frontend or any API response. Unset = emails are skipped and logged instead, and every StudyCore action still succeeds. |
| `EMAIL_FROM` | Sender identity on the Resend-verified domain, e.g. `StudyCore <no-reply@studycore.academy>` |
| `DB_BACKUP_ENABLED` / `DB_BACKUP_KEEP_DAYS` | Optional. Automatic database backups are on whenever R2 is configured; set `DB_BACKUP_ENABLED=false` to turn them off. `DB_BACKUP_KEEP_DAYS` is how many days of backups to keep (default 14). |
| `APP_URL` | Public base URL of this deployment, used for links inside emails (falls back to `https://studycore.academy`) |
| `WHATSAPP_CHANNEL_URL` | Official WhatsApp academic channel link (WhatsApp panels, footer) |
| `WHATSAPP_GROUP_URL` | Official WhatsApp group invite link ("Join the WhatsApp Group" buttons) |

Promote another admin later: `npm run make-admin -- someone@example.com "Full Name"`.

Maintenance scripts open the same SQLite file as the running server, so they are
safe to run against a live deployment: the database is opened in WAL mode with a
5s `busy_timeout`, meaning a script that starts while the server is mid-write
waits for the lock instead of failing with `database is locked`. Covered by
`scripts/test-db-concurrency.js`.

## Deploying

Any Node 22.5+ host (Render, Railway, Fly.io, VPS). Two things matter:

1. **Persistent disk for `data/`** (the SQLite file). Uploaded files live in R2 and
   survive on their own.
2. **Real environment variables** - `JWT_SECRET` (32+ chars),
   `CONTENT_ADMIN_ACCESS_CODE`, `ADMIN_PASSWORD`, `NODE_ENV=production`,
   the four `R2_*` variables, and the three `BUNNY_*` variables. Bunny is the
   only video provider; when it is absent video uploads fail without creating a database row.
3. **No `Cross-Origin-Opener-Policy: same-origin` injected in front of the app.**
   StudyCore sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`
   (see `middleware/security.js`), which is what the Google Picker's OAuth
   popup needs. If a host, CDN or reverse proxy overrides that with
   `same-origin`, the sign-in popup is severed from the page and Google
   Identity Services reports *"Popup window closed"* even though the user never
   touched it. Check with:

   ```bash
   curl -sSI https://studycore.academy/api/config | grep -i cross-origin
   ```

   Exactly one `Cross-Origin-Opener-Policy: same-origin-allow-popups` line is
   correct. The Content Admin dashboard also self-checks this and names the
   header in its console audit (row 11 of `window.__STUDYCORE_PICKER_DIAGNOSTICS__()`).

### Database backups

The whole database is one SQLite file, so it is copied off the server automatically
(`lib/db-backup.js`):

- **When**: about 15 seconds after every startup, then every 24 hours.
- **How**: SQLite's online backup API takes a consistent snapshot while the app keeps
  running (never a plain file copy), the snapshot must pass `PRAGMA integrity_check`,
  and it is gzip-compressed.
- **Where**: the same private R2 bucket, as
  `db-backups/studycore-<UTC date and time>.sqlite.gz`. No extra credentials are needed.
- **How long**: the newest backup of each of the last 14 days is kept; older ones are
  deleted.
- **Privacy**: no route serves `db-backups/`. `lib/storage.js` refuses that folder to
  every caller except the backup module itself, so a backup cannot be streamed or deleted
  through a resource, even one made to point at it (`scripts/test-db-backup-privacy.js`).
  The R2 bucket itself must stay private (no public `r2.dev` URL or public custom domain).
- **Logs**: look for `[db-backup] SUCCESS …` or `[db-backup] FAILED …` in the server log.
  A failed backup never affects the running app.

Restoring (run on the server, e.g. the Render **Shell** tab):

```bash
node scripts/restore-db.js --list              # show available backups
node scripts/restore-db.js --latest --yes      # restore the newest one
node scripts/restore-db.js <backup-name> --yes # restore a specific one
node scripts/restore-db.js --backup-now        # take an extra backup right now
```

A restore checks the backup first, keeps the current database next to it as
`studycore.sqlite.before-restore-<time>`, then swaps the backup in. **Restart the app
straight afterwards** - until it restarts it is still using the old data. Covered by
`scripts/test-db-backup.js`.

### Search Console / SEO

- `https://studycore.academy/sitemap.xml` - submit in Google Search Console after verifying
  the domain.
- `https://studycore.academy/robots.txt` - allows public pages and brand assets, disallows
  private surfaces.
- Homepage + course pages carry canonical URLs, meta descriptions, Open Graph tags and
  JSON-LD (`Organization`, `WebSite`, `Course` per subject).
- Indexing, rankings, favicon display and AI-search visibility are decided by Google -
  these files only make the signals accurate and crawlable.

## What changed from v2

- Student experience rebuilt around **Course → Topic → Lesson** (topics are a real,
  admin-set field on every resource).
- New **lesson experience page** with the StudyCore video player (resume, speed,
  completion) and document viewer; videos and documents are watched/read inside
  StudyCore with no external links, no download/share controls.
- **Videos are strictly Premium** - trial students can no longer stream them; the gate is
  server-side and covers streams, detail fetches and progress endpoints. All student media
  is view-only, and the former direct-download URL is explicitly denied.
- **Quizzes** are a live, Premium-only, server-marked feature at `/quiz.html`; the
  on-site community chat room was removed.
- Standalone **Documents** and **Videos** pages removed - documents/videos live inside
  courses, lessons and the unified **Resources** page (filterable by course and type).
- Global navigation redesigned to a learning-first model
  (logo/Home · Courses · Resources · Announcements · About · Search · Dashboard · Profile).
- **Mobile navigation simplified to one bottom tab bar** (Home · Courses · Search ·
  Resources · Account) shown to every visitor — no hamburger drawer, no accordions, no
  section labels. The Account tab opens one compact bottom sheet (dashboard, profile,
  premium, theme, log out); "Home" is the signed-in user's own dashboard. The top bar
  collapses to brand + notification bell, edge-to-edge. Course pages keep their native
  mobile section picker instead of a long horizontally scrolling sub-navigation.
- **Premium dashboard section** (`/dashboard.html#premium`) with real subscription
  states, trial countdown, payment flow and renewal; Pricing page connects into it.
- **Profile pictures** with server-side validation, plus achievements, study streak,
  recent activity and recommendations on the dashboard.
- Course completion experience at 100%, per-topic progress, continue-learning across
  courses, and global search (permission-aware) from the nav bar.
- All emoji UI replaced by a single Lucide-style SVG icon system; new professional
  brand icon, favicon set and Open Graph image.
- **Legal**: public Terms & Conditions and Privacy Policy pages (legal-entity details are
  marked placeholders for the owner), linked from the footer and referenced at signup.
- **Community**: official WhatsApp academic channel and group invite buttons
  on Home, About and the dashboard (no QR code).
- SEO: sitemap, robots.txt, canonicals, JSON-LD, per-course meta.
- Real 404 page (unknown URLs no longer silently serve the homepage).
