# Content protection — screenshots, screen recording and copying

This documents what StudyCore now does to keep lesson material private, and —
just as importantly — **what a website can and cannot enforce**, so nobody
later assumes a guarantee that does not exist.

## The honest summary

> **A website cannot make screenshots impossible.** There is no web API for
> it, in any browser. Windows Snipping Tool, `PrtSc`, macOS `Cmd+Shift+4`,
> Android/iOS system screenshots, OBS and Zoom screen-share all run *outside*
> the browser sandbox, so page JavaScript never sees them and cannot refuse
> them. And a phone camera pointed at the monitor defeats every software
> control ever invented.

What we *can* do — and now do — is remove every in-browser copy route, blank
printing and "Save as PDF", close the in-page capture routes (`toDataURL` /
`toBlob`, `captureStream`, picture-in-picture, `getDisplayMedia`), and scrub
the clipboard after `PrintScreen`. In practice that stops the casual majority
of casual sharing.

The only true screen-capture *blocking* on the web is hardware DRM — see
[Raising the ceiling](#raising-the-ceiling-real-drm) below.

## What is protected

Scope is **learning content only**. The marketing site, login/signup, and the
Admin / Content Admin dashboards are deliberately untouched: publishers need
normal copy/paste to do their job, and locking the public site would only
hurt support and SEO.

| Page | `data-page` | Policy |
| --- | --- | --- |
| Lesson (`/pages/lesson.html`) | `lesson` | `strict` |
| Document viewer (`/viewer/:id`) | `viewer` | `strict` |
| Course home (`/course/:key`, `/pages/subjects/*.html`) | `course` | `strict` |
| Video lessons (`/pages/videos.html`) | `videos` | `strict` |
| Courses / Resources / Search listings | `courses`, `resources`, `search` | `basic` |

* **`strict`** — every deterrent, plus the in-page capture guards (canvas
  extraction, `captureStream`, picture-in-picture).
* **`basic`** — deterrents only. These are listing pages, where the in-page
  guards would be pointless.

Anything not in that table is untouched — the guard returns before binding a
single listener.

## What is in place

### 1. Every in-browser copy route is closed
Right-click, copy, cut, paste, text selection, drag-out, `Ctrl+S`, `Ctrl+U`,
`Ctrl+A`. Copy and cut also **overwrite the clipboard** with a notice, so a
clipboard manager gets nothing useful. Form fields (the document reader's
search box, the global search) stay fully typable — protection that breaks
studying is not protection.

Two routes that copy the *content itself* are closed as well, and they matter
more than the gestures above because neither shows the student a prompt:

* **`canvas.toDataURL()` / `toBlob()`** — the document reader renders every
  PDF page into a `<canvas>`, so one line in the console was a
  full-resolution PNG of the page being read.
* **`captureStream()`** on that canvas or on the `<video>` — turns the
  surface into a `MediaStream` a `MediaRecorder` can write straight to a file,
  with no permission prompt at all.

Both are **scoped to protected surfaces only** (`.sc-protected-surface`,
`.player-shell`, `.doc-reader-stage`). Any other canvas on the site — a chart,
an avatar cropper, anything added later — calls straight through to the
original, so this cannot break an unrelated feature.

### 2. Printing and "Save as PDF" are blanked
Print-to-PDF is a lossless, full-quality capture of the whole document, so
`@media print` hides the page and prints a notice instead. `window.print()`
is also replaced, so the dialog never opens from page code.

`PrintScreen` is worth a note too: the OS takes the shot before the browser
sees the key, so the shot itself cannot be stopped. What the guard does
instead is **overwrite the clipboard on keyup**, which defeats the plain
`PrtSc` → paste-into-chat route that most casual sharing actually uses.

### 3. In-page screen recording is genuinely blocked
`Permissions-Policy: display-capture=()` (in `middleware/security.js`) means
**no script in the page or any frame it embeds may call `getDisplayMedia()`**
— this one is browser-enforced, not a deterrent. `navigator.mediaDevices.
getDisplayMedia` is also overwritten client-side, unconditionally, so a
future browser or an injected polyfill hits the same refusal. This closes
tab-recording by a compromised or injected script; it does not affect the
student running OBS outside the browser.

**Picture-in-picture is closed too**, and it was a genuine hole rather than a
nicety: PiP floats the video in an **OS-level window that lives outside the
document**, where none of the in-page guards can reach it — so a student
could pop the lecture out, leave it visible, and switch to a recorder with
the protection sitting uselessly behind it. It is blocked in three places,
because each covers a case the others miss:

* `Permissions-Policy: picture-in-picture=()` — the only one that reaches
  *inside* the cross-origin Cloudflare Stream iframe, whose own player would
  otherwise render a PiP button we cannot touch from this DOM;
* `disablepictureinpicture` on the progressive `<video>`, and the removal of
  `picture-in-picture` from the Stream iframe's `allow` list;
* a JS guard on `requestPictureInPicture()` plus an `enterpictureinpicture`
  handler that exits again, covering the browsers that open PiP
  *automatically* when a tab is hidden.

Fullscreen is deliberately untouched (`fullscreen=(self)`): fullscreen
watching and fullscreen document reading are core features.

### 4. Native wrapper bridge (real OS-level blocking, when available)
If StudyCore is ever shipped inside an Android WebView / TWA / PWA wrapper,
the guard asks the host to set `FLAG_SECURE` (`WTN.disableScreenshot`,
`AndroidSecure.setSecure`, or a React Native postMessage). On Android that is
a **real, OS-enforced block**: the screenshot is refused and screen
recordings come out black. It no-ops in a normal desktop browser.

## The server side — the part that is actually enforcement

Everything above is *client-side deterrence*. It raises the effort of casual
capture. It is not access control, and it must never be mistaken for it: a
student who disables JavaScript defeats all of it in one click.

Access control lives on the server, and it always has:

* `requirePageAuth` gates the lesson, viewer and course **pages**;
* `/api/resources/:id/stream` runs `requireAuth`, then the program boundary
  (`programCanSeeResource` — a Law student cannot stream a Mines resource id),
  then the Premium/trial gate. Authorization is re-evaluated on **every single
  request**, including every 128 KB range chunk of a PDF;
* `/api/resources/:id/download` is an explicit `403`, so a saved link from
  before the download control was removed cannot quietly bypass the reader;
* R2 and Cloudflare Stream credentials exist only in server environment
  variables. The browser never addresses object storage directly — CSP's
  `media-src`/`connect-src` would refuse it even if some code tried.

### Short-lived signed tickets (`lib/content-tickets.js`)

The stream endpoint was already session-gated, so it was never guessable by an
anonymous visitor. What it *was*, though, is a **permanent** URL: once a
student had the string it kept working for the whole 7-day session, and it
looked exactly like an ordinary file link that could be pasted anywhere.

A ticket turns it into a short-lived capability. `GET /api/resources/:id/ticket`
runs the identical authorization the stream runs and returns
`/api/resources/:id/stream?t=v1.<payload>.<hmac>`, where the payload is bound
to:

* **one resource** — a ticket for a free note cannot be replayed against a
  Premium video;
* **one account** — pasted into a group chat it is refused for everyone else
  (and the account it *was* minted for could have opened the lesson anyway,
  so sharing gains nothing);
* **a wall-clock expiry** — six hours, long enough for a 90-minute lecture and
  a lunch break, short enough that a copied URL is worthless by tomorrow.

It is HMAC-SHA256 signed with a key **derived** from `JWT_SECRET` via a
labelled hash rather than the secret itself, so a ticket signature can never
be confused with — or used to attack — a session JWT. Editing the payload to
push out the expiry or swap the resource id fails the constant-time signature
comparison.

**A ticket is defence in depth, never the access decision.** It is verified
*after* `requireAuth` and the program/Premium gates, so it can only ever
narrow access, never widen it: a still-valid ticket for content the student
has since lost access to is refused exactly like any other unauthorized
request. A ticket that is *absent* is tolerated (the session gate still
applies) unless `CONTENT_TICKET_ENFORCE=true`; a ticket that is *present* must
be valid, because silently falling back to the session would defeat the whole
point of the expiry.

The front-end (`StudyCoreAPI.protectedUrl`) mints one per resource, caches it
for the life of the page and re-mints shortly before expiry, so paging a PDF
does not mint one per request. **Every consumer falls back to the plain
session-gated URL if the mint fails** — the server is the authority either
way, and a hiccup in the ticket service must never stop a paying student from
opening their lesson.

### No permanent public media URL is published

The Cloudflare Stream `hls` manifest URL used to be included in every
course/lesson/resource JSON payload. **Nothing in the front-end ever played
it** — the Cloudflare iframe player fetches its own manifest inside the frame
— so shipping it only published a permanent, directly-downloadable video
address (exactly what `yt-dlp` wants) to every client. It has been removed
from all three serializers. `stream.hlsUrl()` still exists for server-side
use.

For a further step up, `CF_STREAM_SIGNED=true` makes Cloudflare itself require
signed playback tokens (`lib/stream.js` already applies `requireSignedURLs` at
upload time when it is set) — enforcement on Cloudflare's side rather than
ours.

## Known limits — please read before promising anything

These are not oversights; they are properties of the web platform.

1. **OS screenshot tools still capture.** If a student has the Snipping Tool
   already open on a second monitor, or uses a tool that does not steal
   focus, they get the frame. On Android and iOS the system screenshot is
   likewise taken by the OS.
2. **A second device always works.** A phone camera pointed at the screen is
   undefeatable by any software, DRM included.
3. **Someone determined can disable JavaScript entirely** — which also breaks
   the app, but they could still read a cached page. The *server-side* gates
   (`requirePageAuth`, the session-gated `/api/resources/:id/stream`) are the
   real access control; this guard is a layer on top, never a substitute.
4. **`Ctrl+P` is blocked, but the browser menu → Print is not** reachable by
   JS. That is why the print *stylesheet* blackout exists as the real
   backstop.
5. **Android/iOS system screenshots cannot be refused by a web page.** There
   is no web API for `FLAG_SECURE` from inside a normal browser tab. The
   native-wrapper bridge in §4 is the only route to a real OS-level block,
   and it only applies if StudyCore is shipped inside a WebView/TWA.
6. Everything client-side here is **deterrence**. Treat it as "raises the
   effort of casual capture", not "makes leaking impossible". The
   server-side gates and the signed tickets are the parts that are actually
   enforcement.

### How to describe this system

Do **not** describe StudyCore as "100% screenshot-proof", "impossible to
record", or "DRM-protected" (it is not — see the DRM section below). Those
claims are false, and the first student who posts a screenshot in a WhatsApp
group disproves them publicly.

An accurate description: *"StudyCore content is protected — copying, printing
and downloading are disabled."* That is true and sets the right expectation.

## Raising the ceiling: real DRM

To actually make recordings come out black on desktop, the video path needs
hardware DRM via Encrypted Media Extensions — Widevine L1 (Chrome/Android),
PlayReady SL3000 (Edge/Windows) or FairPlay (Safari). With those, decoded
frames live in protected memory the OS compositor cannot read.

StudyCore already streams video through Cloudflare Stream (`lib/stream.js`),
and **Cloudflare Stream supports DRM-protected playback**. Switching the
video path onto signed DRM playback would give genuine capture-blocking for
video on supported devices. Two caveats worth knowing up front: it is a paid
feature, and it covers **video only** — PDFs and notes rendered to a canvas
can never be DRM-protected in a browser, so documents rely on the same
deterrents described above.

## Browser compatibility

The client-side guards are plain DOM/API wrappers, so they behave uniformly
across the supported browsers:

| Browser | Notes |
| --- | --- |
| **Chrome / Edge desktop** | Full support: canvas guards, PiP block. |
| **Android Chrome** | The priority platform. PiP block matters most here, since Android pops video out aggressively. |
| **Samsung Internet** | Chromium-based; behaves as Android Chrome. `-webkit-touch-callout: none` suppresses the long-press "Save image" sheet. |
| **iOS Safari** | `playsinline` keeps video inside StudyCore instead of the native fullscreen player. `captureStream` is unsupported, so that guard simply no-ops. |

Verified with `node scripts/mobile-audit.js` (0 high / 0 medium / 0 low
findings at the ≤430px phone breakpoint) and a full DOM-level pass of the
guard covering the copy routes, canvas/media guards, scoping and touch
behaviour.

## Files

| File | Role |
| --- | --- |
| `public/js/privacy-guard.js` | All client behaviour; page policy map at the top |
| `public/css/privacy-guard.css` | Selection lock, print blackout |
| `lib/content-tickets.js` | Short-lived, account-bound signed resource tickets |
| `routes/resources.routes.js` | `/:id/ticket` mint + ticket verification on `/:id/stream` |
| `public/js/api.js` | `StudyCoreAPI.protectedUrl` — mints/caches the ticketed URL |
| `middleware/security.js` | `display-capture=()`, `picture-in-picture=()` in `Permissions-Policy` |
| `lib/stream.js` | View-only Cloudflare Stream player options; `hlsUrl` no longer published |
| `scripts/test-privacy-guard.js` | Regression tests (scope, layering, no-breakage) |
| `scripts/test-content-tickets.js` | Ticket signing, binding, expiry and tamper tests |
| `scripts/live-protection-check.js` | End-to-end check against a running server (dev tool) |

### Adding protection to a new page

1. Give the page a `data-page="…"` value.
2. Add that value to `PAGE_POLICY` in `privacy-guard.js` as `'strict'` or `'basic'`.
3. Add `privacy-guard.css` in `<head>` and `privacy-guard.js` before
   `player.js` / `doc-reader.js`, so the player and reader surfaces are
   tagged as they appear.
4. Add the page to `PROTECTED_PAGES` in `scripts/test-privacy-guard.js`.

The test suite fails loudly if a protected page is missing the guard, if the
scripts are in the wrong order, or if a marketing/admin page accidentally
picks it up.
