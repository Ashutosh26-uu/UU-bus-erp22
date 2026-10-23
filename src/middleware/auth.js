import { get, run, now } from '../db.js';
import { config } from '../config.js';
import { parseCookies, clearCookie, HttpError } from '../http.js';
import { sha256, safeEqual } from '../security.js';

export const SESSION_COOKIE = 'uu_sid';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ABSOLUTE_MAX_MS = 7 * 86_400_000; // no session lives longer than a week, whatever the activity

export const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  bus_id: u.bus_id,
  bus_number: u.bus_number ?? null,
  mustChangePassword: !!u.must_change_password,
  home: homeFor(u),
});

/** Where this user lands after sign-in: admin console, their own bus portal, or the portal picker. */
export function homeFor(u) {
  if (u.role === 'admin') return '/admin';
  if (u.bus_number) return `/bus/${encodeURIComponent(u.bus_number)}`;
  return '/incharge';
}

/** Can this user operate this bus's portal? Admins and unassigned incharges can use any bus. */
export const canAccessBus = (user, busId) => user.role === 'admin' || user.bus_id == null || user.bus_id === busId;

/** Attach req.user / req.session when a valid session cookie is present. */
export async function loadSession(req, res, next) {
  req.cookies = parseCookies(req);
  req.user = null;
  req.session = null;
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid || sid.length > 120) return next();
  const h = sha256(sid);
  const row = await get(
    `SELECT s.csrf, s.expires_at, s.last_seen, s.created_at AS session_created,
            u.id, u.username, u.name, u.role, u.bus_id, u.active, u.must_change_password, b.number AS bus_number
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN buses b ON b.id = u.bus_id WHERE s.id = ?`,
    h,
  );
  const t = now();
  if (!row || row.expires_at < t || row.session_created + ABSOLUTE_MAX_MS < t || !row.active) {
    if (row) await run('DELETE FROM sessions WHERE id = ?', h);
    clearCookie(res, SESSION_COOKIE);
    return next();
  }
  if (t - row.last_seen > 60_000) {
    await run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', t, t + config.sessionTtlMs, h);
  }
  req.session = { id: h, csrf: row.csrf };
  req.user = publicUser(row);
  next();
}

function checkCsrfAndOrigin(req) {
  const token = req.get('x-csrf-token');
  if (!token || !safeEqual(token, req.session.csrf)) {
    throw new HttpError(403, 'Security token mismatch. Reload the page and try again.', { code: 'CSRF' });
  }
  let origin = req.get('origin');
  if (!origin && req.get('referer')) { try { origin = new URL(req.get('referer')).origin; } catch { origin = null; } }
  if (origin && origin !== 'null') {
    let host = null;
    try { host = new URL(origin).host; } catch { host = null; }
    const expected = (config.trustProxy && req.get('x-forwarded-host')) || req.get('host');
    if (!host || host !== expected) throw new HttpError(403, 'Cross-site request blocked', { code: 'ORIGIN' });
  }
}

/** Require a signed-in user with one of the roles. State-changing requests also need CSRF + same-origin. */
export function requireAuth(...roles) {
  return (req, res, next) => {
    if (!req.user) throw new HttpError(401, 'Please sign in', { code: 'UNAUTHENTICATED' });
    if (roles.length && !roles.includes(req.user.role)) throw new HttpError(403, 'You are not allowed to do that', { code: 'FORBIDDEN' });
    if (!SAFE_METHODS.has(req.method)) checkCsrfAndOrigin(req);
    if (req.user.mustChangePassword && !req.allowPasswordChangePending) {
      throw new HttpError(403, 'You must change your password first', { code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
  };
}

/** Same as requireAuth but lets a user with a pending password change through (for /auth/* only). */
export function requireAuthPendingOk() {
  return (req, res, next) => { req.allowPasswordChangePending = true; requireAuth()(req, res, next); };
}
