import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, intParam } from '../http.js';
import { requireAuth, canAccessBus } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { tokenFor, checkinUrl, qrSvg, secondsLeftInSlot, baseUrl } from '../services/qr.js';
import { getTrip, getTripRaw, tripSummary, startTrip, endTrip, canAccessTrip, withCounts } from '../services/trips.js';
import { manualCheckin, studentByUuid } from '../services/checkins.js';

const router = Router();
router.use(requireAuth('incharge', 'admin'));

const BUS_ORDER = 'ORDER BY CAST(number AS INTEGER), number';

function tripForUser(req) {
  const id = intParam(req.params.id, 'trip id');
  const trip = getTrip(id);
  if (!trip) throw new HttpError(404, 'Trip not found');
  if (!canAccessTrip(req.user, trip)) throw new HttpError(403, 'This trip belongs to another bus');
  return trip;
}

/** Bus portal state. ?bus=<number> scopes everything to one bus (its own portal). */
router.get('/state', (req, res) => {
  const u = req.user;
  const busNo = req.query.bus != null ? String(req.query.bus).trim().slice(0, 20) : '';
  let scopedBus = null;
  let buses;
  let activeIds;
  if (busNo) {
    const bus = get('SELECT id, number, name, route, active FROM buses WHERE number = ?', busNo);
    if (!bus || !bus.active) throw new HttpError(404, `Bus ${busNo} does not exist`);
    if (!canAccessBus(u, bus.id)) {
      throw new HttpError(403, `This portal belongs to Bus ${bus.number}. Your portal is Bus ${u.bus_number}.`, { code: 'WRONG_BUS_PORTAL', yourBus: u.bus_number });
    }
    scopedBus = {
      ...bus,
      stops: all('SELECT name FROM stops WHERE bus_id = ? ORDER BY seq, name', bus.id).map((s) => s.name),
      students: get('SELECT COUNT(*) AS c FROM students WHERE bus_id = ? AND active = 1', bus.id).c,
      incharges: all("SELECT name FROM users WHERE bus_id = ? AND role = 'incharge' AND active = 1 ORDER BY name", bus.id).map((x) => x.name),
    };
    buses = [bus];
    activeIds = all("SELECT id FROM trips WHERE status = 'active' AND bus_id = ?", bus.id);
  } else {
    buses = u.role === 'admin' || u.bus_id == null
      ? all(`SELECT id, number, name, route FROM buses WHERE active = 1 ${BUS_ORDER}`)
      : all('SELECT id, number, name, route FROM buses WHERE id = ? AND active = 1', u.bus_id);
    activeIds = u.role === 'admin' || u.bus_id == null
      ? all("SELECT id FROM trips WHERE status = 'active' ORDER BY started_at DESC")
      : all("SELECT id FROM trips WHERE status = 'active' AND (incharge_id = ? OR bus_id = ?) ORDER BY started_at DESC", u.id, u.bus_id);
  }
  const activeTrips = activeIds.map((r) => withCounts(getTrip(r.id)));
  res.json({ user: u, buses, activeTrips, scopedBus, qr: { rotateSec: config.qrRotateSec, baseUrl: baseUrl() } });
});

/** Portal picker: every bus with its live status (admins and unassigned incharges see all). */
router.get('/buses', (req, res) => {
  const u = req.user;
  const scope = u.role === 'admin' || u.bus_id == null ? '' : 'AND b.id = ?';
  const params = scope ? [u.bus_id] : [];
  const rows = all(
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

router.post('/trips', (req, res) => {
  const { bus_id, direction } = validate(
    z.object({ bus_id: z.coerce.number().int().positive(), direction: z.enum(['to_college', 'from_college']) }),
    req.body,
  );
  const u = req.user;
  if (!canAccessBus(u, bus_id)) throw new HttpError(403, `You can only run trips for Bus ${u.bus_number}`);
  const trip = startTrip({ busId: bus_id, inchargeId: u.id, direction });
  audit(req, 'trip.start', 'trip', trip.id, `bus ${trip.bus_number} ${direction}`);
  res.status(201).json({ trip });
});

router.get('/trips/:id', (req, res) => {
  const trip = tripForUser(req);
  res.json(tripSummary(trip.id));
});

router.get('/trips/:id/qr', async (req, res) => {
  const trip = tripForUser(req);
  if (trip.status !== 'active') throw new HttpError(410, 'Trip has ended', { code: 'TRIP_ENDED' });
  const raw = getTripRaw(trip.id);
  const token = tokenFor(raw);
  const url = checkinUrl(token, trip.bus_number);
  const svg = await qrSvg(url);
  res.set('Cache-Control', 'no-store');
  res.json({ token, url, svg, rotateSec: config.qrRotateSec, secondsLeft: secondsLeftInSlot(), serverTime: Date.now() });
});

router.post('/trips/:id/end', (req, res) => {
  const trip = tripForUser(req);
  const ended = endTrip(trip.id, req.user.id);
  audit(req, 'trip.end', 'trip', trip.id, `bus ${trip.bus_number}, boarded ${ended.counts.boarded}`);
  res.json({ trip: ended });
});

router.post('/trips/:id/manual', (req, res) => {
  const trip = tripForUser(req);
  const { uuid, note } = validate(z.object({ uuid: z.string().trim().min(2).max(40), note: z.string().trim().max(200).default('') }), req.body);
  const student = studentByUuid(uuid);
  if (!student) throw new HttpError(404, 'No active student with that ID');
  const r = manualCheckin({ trip, student, byUser: req.user, note });
  audit(req, 'checkin.manual', 'checkin', r.id, `${student.uuid} ${student.name} on trip ${trip.id}${note ? ` — ${note}` : ''}`);
  res.status(201).json({ ok: true, boardedAt: r.at, flags: r.flags, student: { id: student.id, uuid: student.uuid, name: student.name, stop: student.stop_name || '' } });
});

router.get('/students/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ items: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const items = all(
    `SELECT s.id, s.uuid, s.name, s.course, s.year, st.name AS stop, b.number AS bus_number
       FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id
      WHERE s.active = 1 AND (s.uuid LIKE ? OR s.name LIKE ?) ORDER BY s.name COLLATE NOCASE LIMIT 12`,
    like, like,
  );
  res.json({ items });
});

export default router;
