import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

// A page session: proof that someone who manages the page logged in recently. Facebook's own login token lasts
// about an hour, so after the owner has proved they manage the page we hand the browser our own signed token for
// that page. It is checked here with no call to Facebook, expires after a day, and works for that page only.
// It is signed with a key derived from the Facebook app secret, so it needs no extra setting.
const TTL_SECONDS = 24 * 3600;
const PREFIX = 'ps1';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

const key = () => {
  const secret = process.env.SESSION_SECRET || process.env.FB_APP_SECRET;
  if (!secret) throw new Error('FB_APP_SECRET (or SESSION_SECRET) is not set, so page sessions cannot be signed.');
  return createHmac('sha256', secret).update('pagesense-page-session-v1').digest();
};
const sign = (body) => b64(createHmac('sha256', key()).update(body).digest());

export const isSessionToken = (t) => typeof t === 'string' && t.startsWith(`${PREFIX}.`);

export function signSession(pageId, now = Date.now()) {
  const body = b64(JSON.stringify({ p: String(pageId), exp: Math.floor(now / 1000) + TTL_SECONDS }));
  return `${PREFIX}.${body}.${sign(body)}`;
}

// Returns the page id, or throws an error with status 401 and code "session_expired" (the app then asks the owner to
// log in again). A token that was tampered with is rejected the same way.
export function verifySession(token, now = Date.now()) {
  const fail = (message) => Object.assign(new Error(message), { status: 401, code: 'session_expired' });
  const [prefix, body, sig] = String(token).split('.');
  if (prefix !== PREFIX || !body || !sig) throw fail('Your login is not valid. Please log in with Facebook again.');
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw fail('Your login is not valid. Please log in with Facebook again.');
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw fail('Your login is not valid. Please log in with Facebook again.'); }
  if (!data?.p || !Number.isFinite(data.exp) || data.exp * 1000 < now) throw fail('Your login has expired. Please log in with Facebook again.');
  return data.p;
}
