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
- **Video Lessons page** (`/pages/videos.html?course=<slug>&term=<Term N>`): videos
  for **one course and one term only**. Each course home shows Term 1 / Term 2 /
  Term 3 as cards; clicking a term opens that course's videos for that term.
- **Lesson experience** (`/pages/lesson.html?id=…&subject=…`): breadcrumbs, the StudyCore
  video player (resume position, speed, fullscreen, progress + completion tracking) or the
  StudyCore document viewer, key concepts, related resources, mark-complete, and
  previous/next navigation. The document viewer renders **PDFs** (pdf.js → canvas) and
  **Word `.docx`** (mammoth → HTML) in-browser; it sniffs the file's real bytes so a file
  uploaded without an extension (or with a mismatched mime) still opens with the right
  renderer. Unsupported types show an honest preview-unavailable message and remain
  view-only—there is no source-file download fallback.
- **Quizzes & assignments**: removed from the student experience. The backend keeps their
  tables and admin upload options for compatibility, but they never appear in the student
  UI, course listings, or search.

## Access control (enforced server-side)

| Content                | Free trial (30 days) | Trial expired | Premium active |
|------------------------|----------------------|---------------|----------------|
| Video lessons          | **locked** (Premium only) | locked | unlocked |
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

## Payments

Manual mobile-money flow (no merchant API required):
1. Student pays K50 to the configured MTN/Airtel number (shown by `GET /api/auth/payment-info`).
2. Student submits phone + method + reference from the dashboard **Premium section**
   (`/dashboard.html#premium`) → creates a `PENDING` payment.
3. Admin confirms receipt on their phone and **Approves** in the admin dashboard →
   30 days of Premium is activated, and the student is **emailed an "access granted"
   confirmation** (payment confirmed, Premium active-until date, what it unlocks, and a
   start-watching link). Rejecting leaves the student's plan unchanged.

Emails go out over SMTP configured in `.env` (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
`SMTP_PASS` / `EMAIL_FROM`), so any provider works — Gmail app password, Brevo, Mailgun,
SendGrid, Resend SMTP. When SMTP is not configured (local dev, tests), approving still
works: the email is rendered to the server console instead, and a mail failure can never
block or roll back an approval. See `lib/mailer.js`.

The public Pricing page routes logged-out visitors to signup and logged-in students
straight to the dashboard Premium payment section.

## Public pages (home & pricing)

The marketing surface is built from the same design system as the app — no page-specific
one-off styling:

- **Home** (`/`): hero (with a short reassurance row) → programs → what's inside a course
  → how it works → Premium → Quizzes → **FAQ** → closing CTA. Signed-in visitors never see
  trial-only copy: the reassurance row is removed and the closing CTA becomes
  "Open My Dashboard".
- **Pricing** (`/pages/pricing.html`): plans, how mobile-money payment works, and a
  **payment FAQ** covering activation time, no auto-renew, paying from another number and
  what happens when the trial ends.
- Shared components live in `public/css/style.css`: `.faq-list` / `.faq-item` (native
  `<details>`, so it is keyboard accessible and works with JavaScript disabled),
  `.cta-banner` (the dark brand CTA panel, replacing hand-rolled inline gradients) and
  `.trust-row`. Both FAQs are mirrored as `FAQPage` JSON-LD for search results.

## Profile pictures

`POST /api/auth/avatar` streams the image to R2, then **verifies the actual file
signature** (PNG/JPEG/WebP magic bytes) by reading the first bytes back from storage — a
disguised file is deleted and rejected. 4MB cap, image-only extension filter, stored
under a private key; only the owner's own avatar is ever served
(`GET /api/auth/avatar`). Displayed in the nav account menu, dashboard hero and profile
section, with a professional User-icon fallback (never an emoji).

## Student community (`/pages/community.html`)

One shared, WhatsApp-style group room for the whole platform — students ask questions
freely, answer each other, and the admin joins in like any other member (with moderator
powers). It is a real conversation, not a notice board, so it is kept completely separate
from the announcement centre and has its own unread pill on the Community nav link.

| | Students | Admin |
|---|---|---|
| Post / reply / heart | yes | yes |
| Edit own message (marked *edited*) | yes | yes |
| Delete own message | yes (soft — "You deleted this message") | yes |
| Delete somebody else's message | no (403) | yes (hard delete — spam is gone) |
| Pin / unpin (max 3 at once) | no (403) | yes |

- **Live updates**: `GET /api/community/stream` is a Server-Sent Events feed (built into
  Node/Express — no new dependency) carrying `message`, `edit`, `delete`, `react`, `pin`,
  `typing` and `presence`. SSE is treated as an optimisation: the client also catches up
  with `GET /api/community?after=<seq>` every 25s, so a dropped stream costs latency, not
  messages.
- **Fan-out is viewer-agnostic**: `mine` and `reactions.mine` are per-viewer facts, so the
  stream never asserts them — the client derives them from the author id.
- **Ordering** uses SQLite's implicit `rowid` (exposed as `seq`), which is strictly
  increasing and immune to two messages sharing a millisecond.
- **Unread tracking** is one row per student (`community_read_state.last_read_at`), seeded
  lazily on first touch so a brand-new student is never greeted with the whole history as
  "unread".
- **Moderation & abuse**: 2000-character cap, control characters stripped, 30 posts/min per
  IP, server-side typing throttle (2s). Every member-authored string is escaped in the DOM;
  only `http(s)` URLs are ever linkified, and profile pictures stay private to their owner,
  so other members are shown as initials.

## Project structure

```
server.js               entry point - static public/, gated views/, API routes, real 404
db/index.js             SQLite schema + safe column migrations (topic, pinned, avatar, video_progress)
middleware/auth.js      JWT cookie auth, role checks, page-level gating
middleware/security.js  security headers + in-memory rate limiting (auth endpoints)
middleware/upload.js    streaming R2 upload (SHA-256) + strict avatar upload config
lib/r2.js               Cloudflare R2 client (S3-compatible)
lib/storage.js          R2 + local-disk fallback, range-aware reads (never buffers whole files)
lib/mailer.js           SMTP email (access-granted confirmation), console fallback when unconfigured
routes/auth.routes.js   register/login/me, profile, password, avatar, subscribe, payment-info
routes/courses.routes.js  public course directory, course home (topics/progress/continue), lesson flow
routes/resources.routes.js  resource list/detail/view-only stream, search, bookmarks,
                            completion, video progress, quiz compatibility endpoints
routes/admin.routes.js  resource CRUD (incl. topic + pinned), users, payments, analytics
routes/notifications.routes.js  announcement list, unread count, per-user read tracking
routes/community.routes.js  student community room: messages, replies, reactions, pins,
                            moderation, unread state, members + the SSE live stream
views/dashboard.html    student dashboard (Premium section #premium, profile #profile, community #community)
views/admin.html        admin dashboard (uploads, topics, announcements, payments, students)
public/js/icons.js      single SVG icon system (Lucide-style) - no emoji in the UI
public/js/layout.js     shared navbar / mobile nav / account menu / footer / global search overlay
public/js/player.js     StudyCore video player (custom controls, resume, progress, premium wall)
public/js/hero.js       per-course canvas hero animations (math/physics/chem/bio/code/comm)
public/js/video.js      Video Lessons page (/pages/videos.html) — per-course, per-term
public/pages/community.html  the community room UI (chat column + members rail + composer)
public/js/community.js  room logic: SSE + catch-up polling, bubbles, replies, reactions, pins
public/css/community.css   chat layout, bubbles, day/unread dividers, typing dots (light + dark)
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
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 storage. **Required in production** - with `NODE_ENV=production` the app refuses to start if R2 is not configured. In local development uploads stream to `DATA_DIR/uploads` instead. |
| `PAYMENT_PHONE_MTN` / `PAYMENT_NAME_MTN` / `PAYMENT_PHONE_AIRTEL` / `PAYMENT_NAME_AIRTEL` | Mobile-money numbers shown on the Premium payment screen |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | SMTP for the access-granted email sent when a payment is approved. Unset = email is logged to console instead of sent. |
| `APP_URL` | Public base URL of this deployment, used for links inside emails |
| `WHATSAPP_CHANNEL_URL` | Official academic channel link (community panels, footer) |
| `WHATSAPP_GROUP_URL` | Official WhatsApp group invite link ("Join the WhatsApp Group" buttons) |

Promote another admin later: `npm run make-admin -- someone@example.com "Full Name"`.

## Deploying

Any Node 22.5+ host (Render, Railway, Fly.io, VPS). Two things matter:

1. **Persistent disk for `data/`** (the SQLite file). Uploaded files live in R2 and
   survive on their own.
2. **Real environment variables** - `JWT_SECRET` (32+ chars),
   `CONTENT_ADMIN_ACCESS_CODE`, `ADMIN_PASSWORD`, `NODE_ENV=production`,
   the four `R2_*` variables. The app refuses to start in production
   without all of them.

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
- Quizzes & assignments removed from the student UI (backend kept for compatibility).
- Standalone **Documents** and **Videos** pages removed - documents/videos live inside
  courses, lessons and the unified **Resources** page (filterable by course and type).
- Global navigation redesigned to a learning-first model
  (logo/Home · Courses · Resources · Announcements · About · Search · Dashboard · Profile)
  with a compact mobile drawer. Course pages use five clear desktop shortcuts and a
  native mobile section picker instead of a long horizontally scrolling sub-navigation.
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
