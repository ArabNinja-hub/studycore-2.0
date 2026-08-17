# StudyCore

A secondary-school and university learning platform for students in Zambia and across Africa - documents, videos, quizzes, assignments, and announcements, managed through a real admin dashboard.

This is a full rebuild of the previous prototype. Every feature described below is wired to a real Node/Express backend, a real SQLite database, and real file storage on disk - there is no mock data, no localStorage-based "fake backend", and no placeholder buttons.

## What's real here

- **Authentication**: bcrypt-hashed passwords, JWT sessions stored in an httpOnly cookie (not readable or spoofable from the browser console).
- **Roles**: `ADMIN` and `STUDENT`, stored in the `users` table. The public signup form can only ever create `STUDENT` accounts - the only way to get an admin account is the seeded one (see below) or `npm run make-admin`.
- **Route protection**: `/admin.html` and `/dashboard.html` are gated **server-side** (see `middleware/auth.js` → `requirePageAuth`). An unauthenticated request is redirected before the HTML is ever sent - it isn't just hidden by JavaScript. Every `/api/admin/*` route re-checks the role from the database on every request.
- **File uploads**: real drag-and-drop upload in the admin dashboard, streamed directly to Cloudflare R2 (S3-compatible object storage) as they arrive - never buffered in full on the server or written to local disk, even for large videos - with metadata (title, description, category, subject, course, year, semester, tags, file size, uploader) written to SQLite. Uploads are never served as static files - they can only be reached through the authenticated `/api/resources/:id/download` and `/api/resources/:id/stream` routes, which check the student's subscription/trial status, log downloads, and support HTTP Range requests so video scrubbing/seeking works correctly.
- **CRUD**: create, edit (including replacing the file), delete, publish/unpublish - all from the admin table, all hitting real endpoints.
- **Search, filter, sort**: by category, subject, and keyword, with newest/oldest/most-downloaded/title sort - both for students browsing and for admins managing resources.
- **Analytics**: total uploads, total downloads, total users, premium students, revenue, most-downloaded resources, uploads by category - computed live from the database, not hardcoded.
- **Bookmarks**: students can save resources and see them on their dashboard.

## Getting started

```bash
npm install
cp .env.example .env   # then edit .env - see below
npm start
```

The server starts on `http://localhost:3000` (or whatever `PORT` you set).

### First run

On first boot, StudyCore seeds one admin account from your `.env` file:

```
ADMIN_EMAIL=admin@studycore.com
ADMIN_PASSWORD=ChangeMe123!
```

**Log in and change this password immediately** (Dashboard → Change password). If you don't set `ADMIN_PASSWORD` yourself, the default above is used and printed to the console - do not leave it as-is on a real deployment.

To promote another account to admin later, or create an additional admin:

```bash
npm run make-admin -- someone@example.com "Full Name"
```

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default 3000) |
| `NODE_ENV` | Set to `production` when deployed - this makes auth cookies `secure` (HTTPS-only) |
| `JWT_SECRET` | **Change this** - a long random string used to sign session tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | Seeded admin account, created once on first boot |
| `MAX_UPLOAD_MB` | Max file size for uploads (default 2000MB / 2GB - enough for a full lecture video) |

## Project structure

```
server.js               entry point - wires routes, serves public/, gates views/
db/index.js              SQLite connection, schema, admin seeding
middleware/auth.js        JWT cookie auth, role checks, page-level gating
middleware/upload.js      multer disk storage + file-type/size limits
routes/auth.routes.js     register, login, logout, me, profile, password, subscribe
routes/resources.routes.js  public browse/search/download/stream/bookmarks
routes/admin.routes.js    admin-only resource CRUD, users, analytics
scripts/make-admin.js     CLI to promote/create admin accounts
public/                  everything served as static files (css, js, marketing pages,
                          student content pages under public/pages/)
views/                   admin.html and dashboard.html - only reachable through the
                          authenticated Express routes in server.js, never as static files
lib/r2.js                Cloudflare R2 client (S3-compatible) - all uploaded files live here
data/                    studycore.sqlite lives here (gitignored)
```

## Deploying

This is a normal Node app - deploy it anywhere that runs **Node 22.5+** (Render, Railway, Fly.io, a VPS, etc). It uses Node's built-in `node:sqlite` module, so there's nothing to compile - `npm install` never touches a C++ toolchain, Python, or Visual Studio Build Tools. (`node:sqlite` is still marked "experimental" by Node itself - it prints one harmless warning line on startup - but it's stable enough for this project's needs. If a future Node release changes its API, only `db/index.js` would need updating.)

Two things matter for a real deployment:

1. **Persistent disk for the database only.** `data/studycore.sqlite` must live on a persistent volume, not an ephemeral filesystem - otherwise every deploy wipes your accounts, resource metadata, and download stats. Render/Railway/Fly all support mounting a persistent disk; point it at this app's `data/` directory. Uploaded *files themselves* (documents, videos, images) no longer need this - they live in Cloudflare R2, which survives deploys/restarts on its own.
2. **Set real environment variables** - `JWT_SECRET`, `ADMIN_PASSWORD`, `NODE_ENV=production`, and the four `R2_*` variables from `.env.example` - before going live.

If you outgrow a single SQLite file (many concurrent admins, very high traffic), the cleanest next step is swapping `node:sqlite` for a hosted Postgres database - file storage is already handled by R2 regardless of that choice, so this migration would only touch `db/` and the route files, not `middleware/upload.js` or `lib/r2.js`.

## Known limitation: mobile money payments require manual approval

The subscription flow (`POST /api/auth/subscribe`) creates a real `payments` row with status `PENDING` and shows the student your MTN/Airtel numbers to pay to. Actually charging a phone number automatically requires a merchant account and API credentials with MTN Mobile Money or Airtel Money, which no one can generate on your behalf - so instead, the admin dashboard's "Subscription payments" section lets you manually confirm you received the money (checking your own phone/app) and approve or reject each request, which is what activates a student's premium access. When you have real merchant credentials, this could be automated by adding a webhook handler for the provider's payment-confirmation callback in `routes/auth.routes.js`.

## Removed from the previous version

- The entire `src/`, `supabase/` React/TanStack/Supabase scaffold - it was unused boilerplate, never wired to anything on the live site.
- The duplicate `public/` copy of the whole site and the duplicate `pages/admin.html`, `pages/dashboard.html`, `pages/login.html`, `pages/signup.html` - there is now exactly one canonical copy of every page.
- The public "upload" and "post announcement" forms that used to sit directly on `documents.html`, `videos.html`, `announcements.html`, and every subject page - anyone visiting those pages could submit them. Uploading now only exists inside the authenticated, role-gated admin dashboard.
- All `localStorage`-backed "fake backend" code in `js/main.js`, `js/admin.js`, and `js/auth.js` - including the rule that granted admin access based on a hardcoded email address. Roles are now assigned once, server-side, at account creation, and are never re-derived from anything the client sends.
