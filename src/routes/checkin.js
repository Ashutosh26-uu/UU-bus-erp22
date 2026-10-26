import { Router } from 'express';
import { z } from 'zod';
import { get, run, now } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, setCookie, clearCookie, clientIp, userAgent } from '../http.js';
import { randomId, sha256 } from '../security.js';
import { deviceIdentity } from '../middleware/device.js';
import { scanLimiter, lookupLimiter } from '../middleware/rateLimit.js';
import { verifyToken } from '../services/qr.js';
import { lookupStudent, studentById, publicStudent, confirmCheckin } from '../services/checkins.js';
import { getTrip } from '../services/trips.js';

const router = Router();
const CS_COOKIE = 'uu_cs';
const MAX_LOOKUPS = 6;

router.use(deviceIdentity);

const publicTrip = (t) => ({ id: t.id, bus_number: t.bus_number, bus_name: t.bus_name, bus_route: t.bus_route, direction: t.direction, started_at: t.started_at });

/** Loads the caller's check-in session (cookie) and verifies it is alive, unconsumed and on this device. */
async function loadCheckinSession(req, res) {
  const raw = req.cookies[CS_COOKIE];
  if (!raw || raw.length > 120) return null;
  const s = await get('SELECT * FROM checkin_sessions WHERE id = ?', sha256(raw));
  if (!s || s.expires_at < now() || s.device_id !== req.deviceId) { clearCookie(res, CS_COOKIE); return null; }
  return s;
}

/** Step 1: the phone scanned a live QR. Exchange the rotating token for a short private session. */
router.post('/session', scanLimiter, async (req, res) => {
  const { token, bus } = validate(z.object({ token: z.string().min(5).max(120), bus: z.string().trim().max(20).optional() }), req.body);
  const checked = await verifyToken(token);
  if (checked.error === 'NO_TRIP') {
    throw new HttpError(409, `No trip is running on Bus ${checked.bus.number} right now. Ask the incharge to start the trip, then scan again.`, { code: 'NO_TRIP', bus: checked.bus.number });
  }
  if (checked.error) throw new HttpError(410, 'This QR code is no longer valid. Scan the QR on the bus again.', { code: 'QR_EXPIRED' });
  const tripRaw = checked.trip;
  if (bus) {
    const busRow = await get('SELECT number FROM buses WHERE id = ?', tripRaw.bus_id);
    if (!busRow || busRow.number.toLowerCase() !== bus.toLowerCase()) throw new HttpError(410, 'This QR code belongs to a different bus. Scan the QR on this bus.', { code: 'QR_EXPIRED' });
  }
  const t = now();
  // Re-use a still-valid session for the same trip on this device (student re-scanned or reloaded)
  let s = await loadCheckinSession(req, res);
  let raw = req.cookies[CS_COOKIE];
  if (!s || s.trip_id !== tripRaw.id || s.consumed_at) {
    raw = randomId(32);
    await run(
      'INSERT INTO checkin_sessions(id,trip_id,device_id,ip,ua,lookups,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)',
      sha256(raw), tripRaw.id, req.deviceId, clientIp(req), userAgent(req), t, t + config.checkinTtlMs,
    );
    s = { trip_id: tripRaw.id, student_id: null, expires_at: t + config.checkinTtlMs };
  }
  setCookie(res, CS_COOKIE, raw, { maxAgeMs: Math.max(1000, s.expires_at - t), sameSite: 'Lax' });
  const trip = await getTrip(tripRaw.id);
  const student = s.student_id ? await studentById(s.student_id) : null;
  res.json({ trip: publicTrip(trip), expiresAt: s.expires_at, device: req.deviceToken, student: student ? publicStudent(student, trip) : null });
});

/** Reload-safe: what is the state of my current check-in session? */
router.get('/session', async (req, res) => {
  const s = await loadCheckinSession(req, res);
  if (!s) return res.json({ active: false, device: req.deviceToken });
  const trip = await getTrip(s.trip_id);
  if (!trip || trip.status !== 'active') return res.json({ active: false, device: req.deviceToken, reason: 'TRIP_ENDED' });
  let student = null;
  let boardedAt = null;
  if (s.student_id) {
    const st = await studentById(s.student_id);
    student = st ? publicStudent(st, trip) : null;
    boardedAt = (await get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, s.student_id))?.created_at ?? null;
  }
  res.json({ active: true, trip: publicTrip(trip), expiresAt: s.expires_at, device: req.deviceToken, student, boardedAt, consumed: !!s.consumed_at });
});

/** Step 2: identify yourself. UUID + name must both match the record. */
router.post('/lookup', lookupLimiter, async (req, res) => {
  const s = await loadCheckinSession(req, res);
  if (!s) throw new HttpError(410, 'Your check-in window has expired. Scan the QR again.', { code: 'SESSION_EXPIRED' });
  if (s.consumed_at) throw new HttpError(409, 'This check-in is already complete.', { code: 'ALREADY' });
  const { uuid, name } = validate(
    z.object({ uuid: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(80) }),
    req.body,
  );
  // count the attempt atomically first, so parallel guesses cannot slip past the limit
  const used = await run('UPDATE checkin_sessions SET lookups = lookups + 1 WHERE id = ? AND lookups < ?', s.id, MAX_LOOKUPS);
  if (!used.changes) throw new HttpError(429, 'Too many wrong attempts. Scan the QR again and check your details with the incharge.', { code: 'LOOKUPS_EXHAUSTED' });
  const student = await lookupStudent(uuid, name);
  if (!student) {
    const left = MAX_LOOKUPS - s.lookups - 1;
    throw new HttpError(404, `No student matches that ID and name.${left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}`, { code: 'NO_MATCH', attemptsLeft: left });
  }
  await run('UPDATE checkin_sessions SET student_id = ? WHERE id = ?', student.id, s.id);
  const trip = await getTrip(s.trip_id);
  const already = await get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id);
  res.json({ student: publicStudent(student, trip), trip: publicTrip(trip), boardedAt: already?.created_at ?? null });
});

/** Step 3: "Yes, that's me" -> atomic check-in with every anti-proxy rule. */
router.post('/confirm', lookupLimiter, async (req, res) => {
  const s = await loadCheckinSession(req, res);
  if (!s) throw new HttpError(410, 'Your check-in window has expired. Scan the QR again.', { code: 'SESSION_EXPIRED' });
  if (!s.student_id) throw new HttpError(400, 'Enter your ID and name first.', { code: 'NO_STUDENT' });
  if (s.consumed_at) throw new HttpError(409, 'This check-in is already complete.', { code: 'ALREADY' });
  const [trip, student] = await Promise.all([getTrip(s.trip_id), studentById(s.student_id)]);
  if (!trip || !student || !student.active) throw new HttpError(410, 'Trip or student no longer available', { code: 'GONE' });
  const r = await confirmCheckin({ sessionId: s.id, trip, student, deviceId: req.deviceId, ip: clientIp(req), ua: userAgent(req) });
  res.json({ ok: true, boardedAt: r.at, flags: r.flags, student: publicStudent(student, trip), trip: publicTrip(trip) });
});

export default router;
