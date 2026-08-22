# mammoth (vendored)

Self-hosted copy of [mammoth.js](https://github.com/mwilliamson/mammoth.js)
(browser build, Apache License 2.0 — see `LICENSE`), used by
`public/js/doc-reader.js` to render Word (`.docx`) documents inside StudyCore.

## Why vendored instead of a CDN

StudyCore documents are protected content. Loading the Word engine from a
third-party CDN would put a third party in the request path of every document a
student opens, and would break the reader entirely if that CDN is blocked or
unreachable — a real risk on the mobile networks StudyCore students use.
Serving it from our own origin keeps document delivery entirely within
StudyCore's own infrastructure, exactly like the vendored pdf.js next door.

## How it is used

Only lazy-loaded when a resource actually turns out to be a Word document
(the reader sniffs the file's real bytes first), so PDF readers never pay the
download cost. The file bytes come from the same session-gated
`/api/resources/:id/stream` endpoint as every other document, are converted to
HTML in the browser, and are rendered inside the existing reader shell — no
download, print or save controls, matching the protected-content model.
