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

What we *can* do — and now do — is remove every in-browser copy route, make
the common capture gestures produce a **black rectangle instead of the
lesson**, scrub the clipboard after `PrintScreen`, and **sign every protected
surface with the student's own name and email** so anything that does leak is
traceable to one account. In practice that stops the casual majority: the
student who would have screenshotted a past paper into a WhatsApp group
thinks twice when their own email is written across it.

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

* **`strict`** — every deterrent, plus the focus-loss curtain, the devtools
  curtain and the per-student watermark.
* **`basic`** — deterrents only. These are listing pages; a curtain there
  would be pure annoyance for no protective gain.

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
is replaced, and the curtain is also raised on `beforeprint` in case a
browser ignores the print stylesheet.

### 3. The visibility / focus-loss curtain — the most effective measure here
Any capture route that takes focus off the page or backgrounds it — Snipping
Tool, the macOS screenshot overlay, alt-tabbing to OBS, switching to a
recorder, a screen-share picker, `Cmd+Shift+4`, the Android recent-apps
button, the iOS app switcher — raises an **opaque black panel** over the
content. The capture gets the panel, not the lesson. It is deliberately
opaque rather than blurred, because a blur is recoverable.

The panel reads **"Protected StudyCore content — content viewing has been
temporarily paused."** with a short line explaining which action caused it.
Nothing accuses the student: the usual cause is an alt-tab or a notification
stealing focus. It never navigates, never reloads and never signs anyone out,
and it is always cleared unconditionally on return — a student stuck behind a
black panel would be a far worse bug than any leak this prevents.

**Mobile is driven by the Page Visibility API**, and that is the important
part for StudyCore because most students are on phones. There is no "window
blur" on Android or iOS the way there is on a desktop; what the page actually
observes when a student hits recent-apps, pulls down the notification shade,
or takes a system screenshot is `visibilitychange` with `document.hidden`.
The curtain is raised **synchronously inside that handler** on purpose: the
browser paints the app-switcher thumbnail (and the frame a screen recorder
keeps capturing after backgrounding) from the last painted state, so doing
this work in a `setTimeout` would let the *un-curtained* frame be the one
that gets stored. Three lifecycle pairs are covered, because no single one is
universal:

| Event pair | Browser |
| --- | --- |
| `visibilitychange` | Chrome/Edge desktop, Android Chrome, Samsung Internet |
| `pagehide` / `pageshow` | iOS Safari (bfcache), back-swipe gesture |
| `freeze` / `resume` | Android Chrome discarding a backgrounded tab |

**Playback is paused behind the curtain** and resumed on return. Two reasons:
a student who alt-tabs should not lose two minutes of a lecture to an empty
screen, and audio continuing under a black panel is exactly what an external
recorder wants. Only videos *the guard itself paused* are resumed, so a video
the student had deliberately paused stays paused.

`PrintScreen` is special: the OS takes the shot before the browser sees the
key, so the shot itself cannot be stopped. What we do instead is **overwrite
the clipboard on keyup**, which defeats the plain `PrtSc` → paste-into-chat
route that most casual sharing actually uses.

### 4. In-page screen recording is genuinely blocked
`Permissions-Policy: display-capture=()` (in `middleware/security.js`) means
**no script in the page or any frame it embeds may call `getDisplayMedia()`**
— this one is browser-enforced, not a deterrent. `navigator.mediaDevices.
getDisplayMedia` is also overwritten client-side, unconditionally, so a
future browser or an injected polyfill hits the same refusal. This closes
tab-recording by a compromised or injected script; it does not affect the
student running OBS outside the browser.

**Picture-in-picture is closed too**, and it was a genuine hole rather than a
nicety: PiP floats the video in an **OS-level window that lives outside the
document**, where the privacy curtain cannot cover it — so a student could pop
the lecture out, leave it visible, and switch to a recorder with the
protection sitting uselessly behind it. It is blocked in three places, because
each covers a case the others miss:

* `Permissions-Policy: picture-in-picture=()` — the only one that reaches
  *inside* the cross-origin Cloudflare Stream iframe, whose own player would
  otherwise render a PiP button we cannot touch from this DOM;
* `disablepictureinpicture` on the progressive `<video>`, and the removal of
  `picture-in-picture` from the Stream iframe's `allow` list;
* a JS guard on `requestPictureInPicture()` plus an `enterpictureinpicture`
  handler that exits again, covering the browsers that open PiP
  *automatically* when a tab is hidden.

Fullscreen is deliberately untouched (`fullscreen=(self)`): fullscreen
watching and fullscreen document reading are core features, and the watermark
is painted inside the element that gets fullscreened.

### 5. Per-student watermark — the part that changes behaviour
`StudyCore · Name · SC-A1B2C3D4 · 2026-09-11 14:32`, tiled diagonally across
the video player and the document reader, refreshed every minute, **nudged to
a new position every 20 seconds**, and restored automatically if anything
removes it from the DOM.

**What may go in the watermark — read this before adding a field.** A
watermark ends up in WhatsApp groups, on Facebook and on strangers' phones.
It is therefore a *publication surface*, and it must never carry anything
that could harm the student it identifies:

| | |
| --- | --- |
| **Allowed** | display name, the account reference below, StudyCore branding, a timestamp |
| **Never** | email address, phone number, password, physical address, payment details, national ID, the session token |

`SC-A1B2C3D4` is a short, opaque **account reference** — the tail of the
random `user-<uuid>` primary key, uppercased. It is enough for support to
trace a leak back to exactly one account from the database, and useless to
anyone else: it is not a login, not a contact detail, and cannot be reversed
into one. (An earlier revision stamped the student's *email address* here.
That was a privacy problem in its own right — it published a contact detail
to every person who ever saw a leaked screenshot — and it has been replaced.)

**It moves.** A watermark that never moves is one that can be cropped or
patched out once and then forgotten. Every 20 seconds the tile shifts a few
percent and its angle changes slightly, so removing it from a *recording*
means redoing the edit for every frame, and a crop that misses it on one
screenshot catches it on the next. The offsets are small and the transition is
slow, so it reads as a living page rather than something twitching in front of
the material. The tile overhangs the surface by 40% on every side, so drifting
never uncovers a corner. Under `prefers-reduced-motion` the *glide* is dropped
but the repositioning still happens — the protection is not traded away for
comfort.

It is placed *inside* `.player-shell` and `.doc-reader-stage` on purpose:
those are the elements that get fullscreened, and **a fullscreen element only
paints its own subtree** — a watermark anywhere else would disappear exactly
when a student is most likely to capture. It sits at `z-index: 2`, above the
media but below the controls (`.player-title` 3, `.player-state` 4,
`.doc-fs-ui` 20), and is `pointer-events: none`, so it never eats a click.

### 6. Devtools deters tampering
Devtools is how someone would delete the watermark and the curtain, so an
open inspector curtains the content. The detector is **baselined against the
window chrome at page load** rather than a fixed pixel threshold — a fixed
threshold false-positives on setups with a bookmarks bar plus a tab strip,
and a student who gets a black screen for no reason simply cannot study.
The trade is that devtools *already open* at load is not caught; zero false
positives is worth more than catching that rare case. Disabled on touch
devices, where the soft keyboard resizes the viewport constantly.

### 7. Native wrapper bridge (real OS-level blocking, when available)
If StudyCore is ever shipped inside an Android WebView / TWA / PWA wrapper,
the guard asks the host to set `FLAG_SECURE` (`WTN.disableScreenshot`,
`AndroidSecure.setSecure`, or a React Native postMessage). On Android that is
a **real, OS-enforced block**: the screenshot is refused and screen
recordings come out black. It no-ops in a normal desktop browser.

## The server side — the part that is actually enforcement

Everything above is *client-side deterrence*. It raises the effort and makes
leaks traceable. It is not access control, and it must never be mistaken for
it: a student who disables JavaScript defeats all of it in one click.

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
   focus, the curtain never triggers. They get the frame — with their own
   name and account reference written across it. On Android and iOS the
   system screenshot is likewise taken by the OS; what the curtain reliably
   protects there is the *app-switcher thumbnail* and everything a recorder
   captures after the app is backgrounded.
2. **A second device always works.** A phone camera pointed at the screen is
   undefeatable by any software, DRM included.
3. **Devtools detection is a heuristic**, and someone determined can disable
   JavaScript entirely — which also breaks the app, but they could still read
   a cached page. The *server-side* gates (`requirePageAuth`, the
   session-gated `/api/resources/:id/stream`) are the real access control;
   this guard is a layer on top, never a substitute.
4. **`Ctrl+P` is blocked, but the browser menu → Print is not** reachable by
   JS. That is why the print *stylesheet* blackout exists as the real
   backstop.
5. **Android/iOS system screenshots cannot be refused by a web page.** There
   is no web API for `FLAG_SECURE` from inside a normal browser tab. The
   native-wrapper bridge in §7 is the only route to a real OS-level block,
   and it only applies if StudyCore is shipped inside a WebView/TWA.
6. Everything client-side here is **deterrence**. Treat it as "raises the
   effort and makes leaks traceable", not "makes leaking impossible". The
   server-side gates and the signed tickets are the parts that are actually
   enforcement.

### How to describe this system

Do **not** describe StudyCore as "100% screenshot-proof", "impossible to
record", or "DRM-protected" (it is not — see the DRM section below). Those
claims are false, and the first student who posts a screenshot in a WhatsApp
group disproves them publicly.

An accurate description: *"StudyCore content is protected — copying, printing
and downloading are disabled, and every document and video is watermarked
with your name and account reference."* That is true, it sets the right
expectation, and the watermark clause is the sentence that actually changes
behaviour.

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
can never be DRM-protected in a browser, so the watermark remains the real
protection for documents.

## Browser compatibility

| Browser | Curtain trigger that fires | Notes |
| --- | --- | --- |
| **Chrome desktop** | `blur` + `visibilitychange` | Full support: canvas guards, PiP block, devtools heuristic. |
| **Edge desktop** | `blur` + `visibilitychange` | Same as Chrome (Chromium). |
| **Android Chrome** | `visibilitychange`, `freeze`/`resume` | The priority platform. Devtools heuristic is **off** on touch (see below); PiP block matters most here, since Android pops video out aggressively. |
| **Samsung Internet** | `visibilitychange` | Chromium-based; behaves as Android Chrome. `-webkit-touch-callout: none` suppresses the long-press "Save image" sheet. |
| **iOS Safari** | `pagehide`/`pageshow`, `visibilitychange` | `playsinline` keeps video inside StudyCore instead of the native fullscreen player. `captureStream` is unsupported, so that guard simply no-ops. |

Two mobile-specific decisions worth knowing:

* **The devtools heuristic is disabled on touch devices.** It works by
  watching the window chrome grow, and a soft keyboard resizes the viewport
  by far more than the threshold every time a student taps the search box. A
  phone user blacked out for opening the keyboard simply cannot study, and
  that trade is not worth catching an inspector on a device that mostly does
  not have one.
* **The watermark shrinks at ≤640px** (`0.62rem`, tighter rows) so it stays
  legible in a screenshot without covering a phone-sized page of text.

Verified with `node scripts/mobile-audit.js` (0 high / 0 medium / 0 low
findings at the ≤430px phone breakpoint) and a full DOM-level pass of the
guard covering watermarking, curtain lifecycle, media pause/resume, scoping
and touch behaviour.

## Files

| File | Role |
| --- | --- |
| `public/js/privacy-guard.js` | All client behaviour; page policy map at the top |
| `public/css/privacy-guard.css` | Selection lock, watermark, curtain, print blackout |
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
3. Add `privacy-guard.css` in `<head>` and `privacy-guard.js` right after
   `auth.js` (it reads the session for the watermark, and must load before
   `player.js` / `doc-reader.js`).
4. Add the page to `PROTECTED_PAGES` in `scripts/test-privacy-guard.js`.

The test suite fails loudly if a protected page is missing the guard, if the
scripts are in the wrong order, or if a marketing/admin page accidentally
picks it up.
