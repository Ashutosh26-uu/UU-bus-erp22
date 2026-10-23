import { config } from '../config.js';
import { parseCookies, setCookie } from '../http.js';
import { randomId, sign, unsign } from '../security.js';

export const DEVICE_COOKIE = 'uu_dev';
const DEVICE_MAX_AGE = 400 * 86_400_000; // browsers cap cookies at 400 days
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Gives every phone a stable, signed identity. Stored in an HttpOnly cookie, mirrored by the
 * page into localStorage and sent back as X-Device-Token, so clearing one of the two is not enough
 * to look like a new phone. The id is what we bind to a student to stop proxy check-ins.
 */
export function deviceIdentity(req, res, next) {
  req.cookies = req.cookies || parseCookies(req);
  let id = unsign(req.cookies[DEVICE_COOKIE], config.sessionSecret);
  let refresh = false;
  if (!id || !ID_RE.test(id)) {
    const fromHeader = unsign(req.get('x-device-token'), config.sessionSecret);
    id = fromHeader && ID_RE.test(fromHeader) ? fromHeader : null;
    refresh = true;
  }
  if (!id) { id = randomId(18); refresh = true; }
  req.deviceId = id;
  req.deviceToken = sign(id, config.sessionSecret);
  if (refresh) setCookie(res, DEVICE_COOKIE, req.deviceToken, { maxAgeMs: DEVICE_MAX_AGE, sameSite: 'Lax' });
  next();
}
