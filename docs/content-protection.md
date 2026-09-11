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
Right-click, copy, cut, text selection, drag-out, `Ctrl+S`, `Ctrl+U`,
`Ctrl+A`. Copy and cut also **overwrite the clipboard** with a notice, so a
clipboard manager gets nothing useful. Form fields (the document reader's
search box, the global search) stay fully typable — protection that breaks
studying is not protection.

### 2. Printing and "Save as PDF" are blanked
Print-to-PDF is a lossless, full-quality capture of the whole document, so
`@media print` hides the page and prints a notice instead. `window.print()`
is replaced, and the curtain is also raised on `beforeprint` in case a
browser ignores the print stylesheet.

### 3. The focus-loss curtain — the most effective measure here
Any capture route that takes focus off the page — Snipping Tool, the macOS
screenshot overlay, alt-tabbing to OBS, switching to a recorder, a
screen-share picker, `Cmd+Shift+4` — raises an **opaque black panel** over the
content. The capture gets the panel, not the lesson. It is deliberately
opaque rather than blurred, because a blur is recoverable.

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

### 5. Per-student watermark — the part that changes behaviour
`Name · email@example.com · 2026-09-11 14:32`, tiled diagonally across the
video player and the document reader, refreshed every minute, and restored
automatically if anything removes it from the DOM.

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

## Known limits — please read before promising anything

These are not oversights; they are properties of the web platform.

1. **OS screenshot tools still capture.** If a student has the Snipping Tool
   already open on a second monitor, or uses a tool that does not steal
   focus, the curtain never triggers. They get the frame — with their own
   name and email written across it.
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
5. Everything here is **client-side deterrence**. Treat it as "raises the
   effort and makes leaks traceable", not "makes leaking impossible".

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

## Files

| File | Role |
| --- | --- |
| `public/js/privacy-guard.js` | All behaviour; page policy map at the top |
| `public/css/privacy-guard.css` | Selection lock, watermark, curtain, print blackout |
| `middleware/security.js` | `display-capture=()` in `Permissions-Policy` |
| `scripts/test-privacy-guard.js` | Regression tests (scope, layering, no-breakage) |

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
