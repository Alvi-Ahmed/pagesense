// Sliding-window limiter kept in memory: fine for a single Render instance, reset by a restart.
// Used so the public demo cannot drain model credits.
const hits = new Map();

export function takeToken(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return { ok: false, retryAfterSec: Math.ceil((recent[0] + windowMs - now) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true, left: max - recent.length };
}

// Express middleware: `keyOf(req)` picks who is being limited, `maxOf(req)` how many calls per window.
export const rateLimit = (keyOf, maxOf, windowMs = 3600_000) => (req, res, next) => {
  const r = takeToken(keyOf(req), maxOf(req), windowMs);
  if (r.ok) { res.set('X-RateLimit-Remaining', String(r.left)); return next(); }
  const mins = Math.ceil(r.retryAfterSec / 60);
  res.set('Retry-After', String(r.retryAfterSec));
  res.status(429).json({ error: `You have reached the limit for now. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.` });
};
