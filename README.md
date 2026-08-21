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
- **Lesson experience** (`/pages/lesson.html?id=…&subject=…`): breadcrumbs, the StudyCore
  video player (resume position, speed, fullscreen, progress + completion tracking) or the
  StudyCore document viewer, key concepts, related resources, mark-complete, and
  previous/next navigation.
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
   30 days of Premium is activated. Rejecting leaves the student's plan unchanged.

The public Pricing page routes logged-out visitors to signup and logged-in students
straight to the dashboard Premium payment section.

## Profile pictures

`POST /api/auth/avatar` streams the image to R2, then **verifies the actual file
signature** (PNG/JPEG/WebP magic bytes) by reading the first bytes back from storage — a
disguised file is deleted and rejected. 4MB cap, image-only extension filter, stored
under a private key; only the owner's own avatar is ever served
(`GET /api/auth/avatar`). Displayed in the nav account menu, dashboard hero and profile
section, with a professional User-icon fallback (never an emoji).

## Project structure

```
server.js               entry point - static public/, gated views/, API routes, real 404
db/index.js             SQLite schema + safe column migrations (topic, pinned, avatar, video_progress)
middleware/auth.js      JWT cookie auth, role checks, page-level gating
middleware/security.js  security headers + in-memory rate limiting (auth endpoints)
middleware/upload.js    streaming R2 upload (SHA-256) + strict avatar upload config
lib/r2.js               Cloudflare R2 client (S3-compatible)
routes/auth.routes.js   register/login/me, profile, password, avatar, subscribe, payment-info
routes/courses.routes.js  public course directory, course home (topics/progress/continue), lesson flow
routes/resources.routes.js  resource list/detail/stream/download, search, bookmarks,
                            completion, video progress, quiz compatibility endpoints
routes/admin.routes.js  resource CRUD (incl. topic + pinned), users, payments, analytics
views/dashboard.html    student dashboard (Premium section #premium, profile #profile, community #community)
views/admin.html        admin dashboard (uploads, topics, announcements, payments, students)
public/js/icons.js      single SVG icon system (Lucide-style) - no emoji in the UI
public/js/layout.js     shared navbar / mobile nav / account menu / footer / global search overlay
public/js/player.js     StudyCore video player (custom controls, resume, progress, premium wall)
public/js/hero.js       per-course canvas hero animations (math/physics/chem/bio/code/comm)
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
| `PORT` / `NODE_ENV` | Port; `production` makes cookies `secure` |
| `JWT_SECRET` | **Change this** - signs session tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Seeded admin, created once on first boot |
| `MAX_UPLOAD_MB` | Max upload size (default 2000MB) |
| `DATA_DIR` | Persistent disk path for the SQLite file (Render etc.) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 storage |
| `PAYMENT_PHONE_MTN` / `PAYMENT_NAME_MTN` / `PAYMENT_PHONE_AIRTEL` / `PAYMENT_NAME_AIRTEL` | Mobile-money numbers shown on the Premium payment screen |
| `WHATSAPP_CHANNEL_URL` | Official academic channel link (community panels, footer) |
| `WHATSAPP_GROUP_URL` | Official WhatsApp group invite link ("Join the WhatsApp Group" buttons) |

Promote another admin later: `npm run make-admin -- someone@example.com "Full Name"`.

## Deploying

Any Node 22.5+ host (Render, Railway, Fly.io, VPS). Two things matter:

1. **Persistent disk for `data/`** (the SQLite file). Uploaded files live in R2 and
   survive on their own.
2. **Real environment variables** - `JWT_SECRET`, `ADMIN_PASSWORD`,
   `NODE_ENV=production`, the four `R2_*` variables.

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
  server-side and covers streams, downloads, detail fetches and progress endpoints.
- Quizzes & assignments removed from the student UI (backend kept for compatibility).
- Standalone **Documents** and **Videos** pages removed - documents/videos live inside
  courses, lessons and the unified **Resources** page (filterable by course and type).
- Global navigation redesigned to a learning-first model
  (Home · Courses · Resources · Announcements · About · Search · Dashboard · Profile)
  with a deliberate mobile menu; course pages get their own sub-nav
  (Overview · Topics · Lessons · Resources · Past Papers · Progress).
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
- **Community**: official WhatsApp academic channel section
  (`https://whatsapp.com/channel/0029Vb6sMBVIiRp0rg5RKQ2k`) and the STUDYCORE PREFRESHERS
  WhatsApp group QR (`public/assets/whatsapp-group-qr.jpg`) on Home, About and the dashboard.
- SEO: sitemap, robots.txt, canonicals, JSON-LD, per-course meta.
- Real 404 page (unknown URLs no longer silently serve the homepage).
