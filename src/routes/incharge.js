import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, intParam } from '../http.js';
import { requireAuth, canAccessBus, operatorReadOnly } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { tokenFor, dayTokenFor, regenerateDayQr, qrMode, endOfIstDay, checkinUrl, qrSvg, secondsLeftInSlot, baseUrl } from '../services/qr.js';
import { getTrip, getTripRaw, tripSummary, startTrip, endTrip, canAccessTrip, withCounts } from '../services/trips.js';
import { manualCheckin, studentByUuid } from '../services/checkins.js';

const router = Router();
router.use(requireAuth('incharge', 'admin', 'operator'));
// Operations admins can watch any bus (state, portal list, trip roster) but get no QR and no actions.
router.use(operatorReadOnly([/^\/state$/, /^\/buses$/, /^\/trips\/\d+$/]));

const BUS_ORDER = 'ORDER BY CAST(number AS INTEGER), number';

async function tripForUser(req) {
  const id = intParam(req.params.id, 'trip id');
  const trip = await getTrip(id);
  if (!trip) throw new HttpError(404, 'Trip not found');
  if (!canAccessTrip(req.user, trip)) throw new HttpError(403, 'This trip belongs to another bus');
  return trip;
}

/** Bus portal state. ?bus=<number> scopes everything to one bus (its own portal). */
router.get('/state', async (req, res) => {
  const u = req.user;
  const busNo = req.query.bus != null ? String(req.query.bus).trim().slice(0, 20) : '';
  let scopedBus = null;
  let buses;
  let activeIds;
  if (busNo) {
    const bus = await get('SELECT id, number, name, route, active FROM buses WHERE number = ?', busNo);
    if (!bus || !bus.active) throw new HttpError(404, `Bus ${busNo} does not exist`);
    if (!canAccessBus(u, bus.id)) {
      throw new HttpError(403, `This portal belongs to Bus ${bus.number}. Your portal is Bus ${u.bus_number}.`, { code: 'WRONG_BUS_PORTAL', yourBus: u.bus_number });
    }
    const [stops, students, incharges] = await Promise.all([
      all('SELECT name FROM stops WHERE bus_id = ? ORDER BY seq, name', bus.id),
      get('SELECT COUNT(*) AS c FROM students WHERE bus_id = ? AND active = 1', bus.id),
      all("SELECT name FROM users WHERE bus_id = ? AND role = 'incharge' AND active = 1 ORDER BY name", bus.id),
    ]);
    scopedBus = { ...bus, stops: stops.map((s) => s.name), students: students.c, incharges: incharges.map((x) => x.name) };
    buses = [bus];
    activeIds = await all("SELECT id FROM trips WHERE status = 'active' AND bus_id = ?", bus.id);
  } else {
    const everything = u.role === 'admin' || u.role === 'operator' || u.bus_id == null;
    buses = everything
      ? await all(`SELECT id, number, name, route FROM buses WHERE active = 1 ${BUS_ORDER}`)
      : await all('SELECT id, number, name, route FROM buses WHERE id = ? AND active = 1', u.bus_id);
    activeIds = everything
      ? await all("SELECT id FROM trips WHERE status = 'active' ORDER BY started_at DESC")
      : await all("SELECT id FROM trips WHERE status = 'active' AND (incharge_id = ? OR bus_id = ?) ORDER BY started_at DESC", u.id, u.bus_id);
  }
  const activeTrips = await Promise.all(activeIds.map(async (r) => withCounts(await getTrip(r.id))));
  res.json({ user: u, buses, activeTrips, scopedBus, qr: { mode: await qrMode(), rotateSec: config.qrRotateSec, baseUrl: await baseUrl(req) } });
});

/** Portal picker: every bus with its live status (admins and unassigned incharges see all). */
router.get('/buses', async (req, res) => {
  const u = req.user;
  const scope = u.role === 'admin' || u.role === 'operator' || u.bus_id == null ? '' : 'AND b.id = ?';
  const params = scope ? [u.bus_id] : [];
  const rows = await all(
    `SELECT b.id, b.number, b.name, b.route,
            (SELECT COUNT(*) FROM students s WHERE s.bus_id = b.id AND s.active = 1) AS students,
            (SELECT GROUP_CONCAT(x.name, ', ') FROM users x WHERE x.bus_id = b.id AND x.role = 'incharge' AND x.active = 1) AS incharge_name,
            t.id AS trip_id, t.direction, t.started_at,
            (SELECT COUNT(*) FROM checkins c WHERE c.trip_id = t.id) AS boarded
       FROM buses b LEFT JOIN trips t ON t.bus_id = b.id AND t.status = 'active'
      WHERE b.active = 1 ${scope} ORDER BY CAST(b.number AS INTEGER), b.number`,
    ...params,
  );
  res.json({
    buses: rows.map((r) => ({
      id: r.id, number: r.number, name: r.name, route: r.route, students: r.students, incharge_name: r.incharge_name,
      trip: r.trip_id ? { id: r.trip_id, direction: r.direction, started_at: r.started_at, boarded: r.boarded } : null,
    })),
  });
});

router.post('/trips', async (req, res) => {
  const { bus_id, direction } = validate(
    z.object({ bus_id: z.coerce.number().int().positive(), direction: z.enum(['to_college', 'from_college']) }),
    req.body,
  );
  const u = req.user;
  if (!canAccessBus(u, bus_id)) throw new HttpError(403, `You can only run trips for Bus ${u.bus_number}`);
  const trip = await startTrip({ busId: bus_id, inchargeId: u.id, direction });
  await audit(req, 'trip.start', 'trip', trip.id, `bus ${trip.bus_number} ${direction}`);
  res.status(201).json({ trip });
});

router.get('/trips/:id', async (req, res) => {
  const trip = await tripForUser(req);
  res.json(await tripSummary(trip.id));
});

router.get('/trips/:id/qr', async (req, res) => {
  const trip = await tripForUser(req);
  if (trip.status !== 'active') throw new HttpError(410, 'Trip has ended', { code: 'TRIP_ENDED' });
  const mode = await qrMode();
  const now = Date.now();
  let token;
  let secondsLeft;
  let validUntil;
  if (mode === 'day') {
    token = await dayTokenFor(trip.bus_id, now);
    validUntil = endOfIstDay(now);
    // the code itself only changes at midnight or on "New QR code"; re-check every few minutes
    secondsLeft = Math.max(1, Math.min(300, Math.ceil((validUntil - now) / 1000)));
  } else {
    token = tokenFor(await getTripRaw(trip.id), now);
    secondsLeft = secondsLeftInSlot(now);
    validUntil = now + secondsLeft * 1000 + config.qrGraceSlots * config.qrRotateSec * 1000;
  }
  const url = await checkinUrl(token, trip.bus_number, req);
  const svg = await qrSvg(url);
  res.set('Cache-Control', 'no-store');
  res.json({ mode, token, url, svg, rotateSec: config.qrRotateSec, secondsLeft, validUntil, serverTime: now });
});

/** Whole-day mode: replace this bus's QR now (e.g. a photo of it was shared). */
router.post('/trips/:id/new-qr', async (req, res) => {
  const trip = await tripForUser(req);
  await regenerateDayQr(trip.bus_id);
  await audit(req, 'qr.regenerate', 'bus', trip.bus_id, `bus ${trip.bus_number}`);
  res.json({ ok: true });
});

router.post('/trips/:id/end', async (req, res) => {
  const trip = await tripForUser(req);
  const ended = await endTrip(trip.id, req.user.id);
  await audit(req, 'trip.end', 'trip', trip.id, `bus ${trip.bus_number}, boarded ${ended.counts.boarded}`);
  res.json({ trip: ended });
});

router.post('/trips/:id/manual', async (req, res) => {
  const trip = await tripForUser(req);
  const { uuid, note } = validate(z.object({ uuid: z.string().trim().min(2).max(40), note: z.string().trim().max(200).default('') }), req.body);
  const student = await studentByUuid(uuid);
  if (!student) throw new HttpError(404, 'No active student with that ID');
  if (student.bus_id !== trip.bus_id) throw new HttpError(409, `${student.name} is not registered on Bus ${trip.bus_number}`, { code: 'NOT_ON_BUS' });
  const r = await manualCheckin({ trip, student, byUser: req.user, note });
  await audit(req, 'checkin.manual', 'checkin', r.id, `${student.uuid} ${student.name} on trip ${trip.id}${note ? ` — ${note}` : ''}`);
  res.status(201).json({ ok: true, boardedAt: r.at, flags: r.flags, student: { id: student.id, uuid: student.uuid, name: student.name, stop: student.stop_name || '' } });
});

/** Manual check-in search: only students registered on that bus (a bus admin never sees other buses' students). */
router.get('/students/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const u = req.user;
  const busId = u.role === 'incharge' && u.bus_id ? u.bus_id : req.query.bus ? intParam(req.query.bus, 'bus') : null;
  if (!busId) throw new HttpError(400, 'Pick a bus');
  if (!canAccessBus(u, busId)) throw new HttpError(403, 'That is not your bus');
  if (q.length < 2) return res.json({ items: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const items = await all(
    `SELECT s.id, s.uuid, s.name, s.course, s.year, st.name AS stop, b.number AS bus_number
       FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id
      WHERE s.active = 1 AND s.bus_id = ? AND (s.uuid LIKE ? OR s.name LIKE ?) ORDER BY s.name COLLATE NOCASE LIMIT 12`,
    busId, like, like,
  );
  res.json({ items });
});

export default router;
