# pdf.js (vendored)

Self-hosted copy of Mozilla's pdf.js **v3.11.174 (legacy build)**, used by
`public/js/doc-reader.js` to render StudyCore documents.

## Why vendored instead of a CDN

StudyCore documents are protected content. Loading the PDF engine from a
third-party CDN would mean a third party is in the request path of every
document a student opens, and would break the reader entirely if that CDN is
blocked or unreachable — a real risk on the mobile networks StudyCore students
use. Serving it from our own origin keeps document delivery entirely within
StudyCore's own infrastructure.

## Why the *legacy* build

The legacy build targets older JavaScript syntax and is the variant Mozilla
ships for maximum browser reach — notably older iOS Safari and the Android
WebView-based browsers common among StudyCore's users. The modern build
assumes very recent engines.

## Contents

| File | Purpose |
|---|---|
| `pdf.min.js` | Main library, loaded on demand the first time a document is opened |
| `pdf.worker.min.js` | Web worker that does the actual parsing/decoding off the main thread |
| `standard_fonts/` | The PDF standard-14 fonts (Helvetica, Times, Courier…), needed for documents that do not embed their fonts |
| `LICENSE` | Apache 2.0 |

## Upgrading

```bash
npm pack pdfjs-dist@<version>
# copy legacy/build/pdf.min.js, legacy/build/pdf.worker.min.js and standard_fonts/
```
Keep `pdf.min.js` and `pdf.worker.min.js` on the **same version** — a mismatch
makes pdf.js refuse to start. The paths are declared at the top of
`public/js/doc-reader.js`.
