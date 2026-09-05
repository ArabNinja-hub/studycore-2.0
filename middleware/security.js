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
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN keeps protected media embeddable by StudyCore's own viewer
  // while still preventing other sites from framing application responses.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), fullscreen=(self)');

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
