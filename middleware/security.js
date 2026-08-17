// Lightweight, dependency-free security middleware. Kept intentionally small
// rather than pulling in helmet - this project has few enough response types
// that the headers below cover the real risks without adding a dependency.

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

// Minimal in-memory rate limiter for auth endpoints (login/register/password
// change) - protects against brute-force credential guessing. In-memory is
// fine for a single-process deployment; swap for a Redis-backed limiter if
// you ever run more than one instance behind a load balancer.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
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
