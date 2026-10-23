import { Router } from 'express';
import { z } from 'zod';
import { get, run, now } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, setCookie, clearCookie, clientIp, userAgent } from '../http.js';
import { verifyPassword, hashPassword, burnPasswordCheck, randomId, sha256, passwordProblem } from '../security.js';
import { SESSION_COOKIE, publicUser, requireAuthPendingOk } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { audit } from '../services/audit.js';

const router = Router();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = validate(
    z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) }),
    req.body,
  );
  const t = now();
  const user = get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !user.active) {
    burnPasswordCheck(password);
    throw new HttpError(401, 'Invalid username or password');
  }
  if (user.locked_until && user.locked_until > t) {
    const mins = Math.ceil((user.locked_until - t) / 60_000);
    throw new HttpError(423, `Account locked after repeated failures. Try again in ${mins} min.`);
  }
  if (!verifyPassword(password, user.password_hash)) {
    const fails = (user.failed_logins || 0) + 1;
    const lock = fails >= LOCK_AFTER;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock ? t + LOCK_MS : null, user.id);
    audit(req, 'login.failed', 'user', user.id, lock ? 'account locked' : `attempt ${fails}`, { id: user.id, name: user.username });
    throw new HttpError(401, lock ? 'Too many failed attempts. Account locked for 15 minutes.' : 'Invalid username or password');
  }
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  const sid = randomId(32);
  const csrf = randomId(24);
  run(
    'INSERT INTO sessions(id,user_id,csrf,ip,ua,created_at,expires_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    sha256(sid), user.id, csrf, clientIp(req), userAgent(req), t, t + config.sessionTtlMs, t,
  );
  setCookie(res, SESSION_COOKIE, sid, { maxAgeMs: config.sessionTtlMs, sameSite: 'Lax' });
  audit(req, 'login', 'user', user.id, '', { id: user.id, name: user.name });
  const bus_number = user.bus_id ? get('SELECT number FROM buses WHERE id = ?', user.bus_id)?.number ?? null : null;
  res.json({ user: publicUser({ ...user, bus_number }), csrf });
});

router.get('/me', requireAuthPendingOk(), (req, res) => {
  res.json({ user: req.user, csrf: req.session.csrf });
});

router.post('/logout', requireAuthPendingOk(), (req, res) => {
  run('DELETE FROM sessions WHERE id = ?', req.session.id);
  clearCookie(res, SESSION_COOKIE);
  audit(req, 'logout', 'user', req.user.id);
  res.json({ ok: true });
});

router.post('/change-password', requireAuthPendingOk(), (req, res) => {
  const { current, next } = validate(
    z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128) }),
    req.body,
  );
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(current, user.password_hash)) throw new HttpError(400, 'Current password is wrong');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  if (current === next) throw new HttpError(400, 'New password must be different');
  run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashPassword(next), now(), user.id);
  // sign out every other device for safety
  run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', user.id, req.session.id);
  audit(req, 'password.changed', 'user', user.id);
  res.json({ ok: true, user: { ...req.user, mustChangePassword: false } });
});

export default router;
