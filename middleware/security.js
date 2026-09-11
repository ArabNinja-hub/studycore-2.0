// Lightweight, dependency-free security middleware. Kept intentionally small
// rather than pulling in helmet - this project has few enough response types
// that the headers below cover the real risks without adding a dependency.

// Content-Security-Policy.
//
// Built from a full inspection of the ACTUAL frontend:
//   * every <script src> is same-origin (/js/*.js, /vendor/pdfjs/*.js) -
//     no CDN scripts, no inline event handlers (onclick="...");
//   * each page carries one small page-specific bootstrap <script> block and
//     the layouts use inline style attributes extensively - that is why
//     'unsafe-inline' appears for scripts/styles. It is retained deliberately
//     (removing it would require rewriting every page's bootstrap), and it is
//     NOT a blanket allowance: default-src 'self' still blocks all remote
//     script/style sources.
//   * NO 'unsafe-eval': nothing in the app calls eval() or new Function().
//     The vendored PDF.js detects its absence (isEvalSupported) and falls
//     back to its interpreter; its only eval() is behind a Node-only branch.
//   * fonts: the site loads Google Fonts (style.css @import) - the only
//     legitimate external origin in the frontend.
//   * media: videos/documents stream from the session-gated
//     /api/resources/:id/stream endpoint ('self'); R2 is never addressed
//     directly by the browser. Cloudflare Stream (when adopted) will be
//     authorized through the same server-side gate, not via public URLs.
//   * workers: the PDF.js worker is a same-origin file.
//   * Google Drive Picker (Content Admin dashboard): the official
//     implementation requires three remote origins -
//       - script-src: https://apis.google.com (gapi loader) and
//         https://accounts.google.com (Google Identity Services);
//       - connect-src: the Picker/GIS XHRs plus the Drive REST API;
//       - frame-src: the Picker renders inside https://docs.google.com and
//         https://drive.google.com iframes, and GIS uses an
//         accounts.google.com frame for the OAuth token flow.
//     Without these the browser silently refuses to evaluate api.js /
//     gsi/client, which is exactly how the Picker "fails to load".
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com https://ajax.googleapis.com https://embed.cloudflarestream.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com https://drive-thirdparty.googleusercontent.com https://ssl.gstatic.com https://*.cloudflarestream.com https://cloudflarestream.com https://videodelivery.net",
  "media-src 'self' blob: https://*.cloudflarestream.com https://videodelivery.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https://apis.google.com https://accounts.google.com https://content.googleapis.com https://www.googleapis.com https://oauth2.googleapis.com https://*.cloudflarestream.com https://cloudflarestream.com https://videodelivery.net",
  "frame-src 'self' https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com https://*.cloudflarestream.com https://embed.cloudflarestream.com https://iframe.cloudflarestream.com",
  "manifest-src 'self'"
].join('; ');

// ---------------------------------------------------------------------------
// Cross-Origin-Opener-Policy.
//
// The value matters for the Content Admin "Select from Google Drive" flow.
// Google Identity Services opens the OAuth consent screen with window.open()
// and then watches the returned handle (popup.closed) to detect when Google
// has handed back an access token. Under COOP `same-origin` that popup is
// placed in a different browsing context group, so the handle is severed:
// `popup.closed` reads true immediately, the browser logs "Cross-Origin-
// Opener-Policy policy would block the window.closed call", and GIS reports
// error_callback({ type: 'popup_closed' }) -> "Popup window closed".
//
// `same-origin-allow-popups` is the policy Google documents for exactly this
// situation ("when FedCM is disabled, set the COOP header to same-origin and
// include same-origin-allow-popups"; failing to do so "breaks communication
// between windows, leading to a blank pop-up window"):
//   https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#cross_origin_opener_policy
//
// It is still hardening relative to what StudyCore sent before this header
// existed (no COOP at all, i.e. the browser default `unsafe-none`): this
// document is placed in its own browsing context group, so any page that
// OPENS StudyCore can no longer reach it through window.opener, while
// StudyCore keeps the opener -> popup relationship the GIS popup needs.
// The residual difference from plain `same-origin` is that a popup StudyCore
// itself opens stays reachable - which is the capability the OAuth flow is
// built on.
//
// Deliberately NOT setting Cross-Origin-Embedder-Policy here: `require-corp`
// would demand CORP/CORS on every cross-origin subresource and would break
// the accounts.google.com and docs.google.com iframes the Picker renders in.
const CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups';

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN keeps protected media embeddable by StudyCore's own viewer
  // while still preventing other sites from framing application responses.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', CROSS_ORIGIN_OPENER_POLICY);
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // `display-capture=()` is the browser-enforced half of the content
  // privacy work (see public/js/privacy-guard.js): no script in this
  // document or any frame it embeds may call getDisplayMedia() to record
  // the tab. It does NOT stop an OS screenshot tool - nothing on the web
  // can - but it does close the one screen-recording route that lives
  // inside the page, including via an injected or compromised script.
  //
  // `picture-in-picture=()` closes a real hole in the capture protection:
  // PiP floats the video in an OS-level window that lives OUTSIDE the
  // document, where the privacy curtain cannot cover it and the student can
  // keep the lesson on screen while switching to a recorder. Blocking it in
  // the header (rather than only on the <video> element) also covers the
  // cross-origin Cloudflare Stream iframe, whose own player would otherwise
  // offer its PiP button.
  //
  // `fullscreen=(self)` is unchanged and deliberately kept - fullscreen
  // watching and fullscreen document reading are core features, and the
  // watermark is painted inside the element that gets fullscreened.
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), display-capture=(), picture-in-picture=(), fullscreen=(self)'
  );

  // HSTS: only in production AND only when the request actually arrived
  // over HTTPS (req.secure is honored through the configured proxy).
  // Sending it over plain HTTP would make the browser refuse the site for
  // the max-age period, so both conditions are required. preload is
  // intentionally NOT set - that requires domain-verification review.
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

// ---------------------------------------------------------------------------
// Minimal in-memory rate limiter.
//
// The store is a per-process Map keyed by client IP, which is correct for
// StudyCore's current single-instance deployment. If the app ever runs as
// more than one instance behind a load balancer, the per-IP counters below
// must be replaced with a SHARED store (e.g. Redis / Cloudflare rate
// limiting / the host's WAF) - the in-memory maps would then only see a
// fraction of each client's traffic and an attacker could rotate across
// instances to multiply the allowed attempt count. The limiter's public
// shape (options in, middleware out) is unchanged by that swap, so only the
// body of the two closures below needs to change.
//
// Protects against brute-force credential guessing and abuse of sensitive
// endpoints (payments, uploads, profile changes, admin operations).
// ---------------------------------------------------------------------------
const MAX_TRACKED_CLIENTS = 100_000; // memory bound: never grow unbounded

function rateLimit({ windowMs, max, methods }) {
  const hits = new Map();
  const limitedMethods = methods ? new Set(methods.map((method) => method.toUpperCase())) : null;

  // Periodic sweep keeps the map small and frees memory for gone clients.
  // .unref() so the timer never keeps the process alive (e.g. in tests).
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
    // Defensive bound against a flood of rotating client addresses.
    if (hits.size > MAX_TRACKED_CLIENTS) hits.clear();
  }, windowMs).unref();

  return (req, res, next) => {
    // Upload-specific limits must not count GET/HEAD requests for the same
    // URL (avatar display and resource listings are ordinary page reads).
    if (limitedMethods && !limitedMethods.has(req.method)) return next();
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);
    timestamps.push(now);
    hits.set(key, timestamps);
    if (timestamps.length > max) {
      return res.status(429).json({ message: 'Too many attempts. Please wait a minute and try again.' });
    }
    next();
  };
}

module.exports = { securityHeaders, rateLimit };
