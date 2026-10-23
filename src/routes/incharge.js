import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../db.js';
import { config } from '../config.js';
import { HttpError, validate, intParam } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { tokenFor, checkinUrl, qrSvg, secondsLeftInSlot, baseUrl } from '../services/qr.js';
import { getTrip, getTripRaw, tripSummary, startTrip, endTrip, canAccessTrip, withCounts } from '../services/trips.js';
import { manualCheckin, studentByUuid } from '../services/checkins.js';

const router = Router();
router.use(requireAuth('incharge', 'admin'));

function tripForUser(req) {
  const id = intParam(req.params.id, 'trip id');
  const trip = getTrip(id);
  if (!trip) throw new HttpError(404, 'Trip not found');
  if (!canAccessTrip(req.user, trip)) throw new HttpError(403, 'This trip belongs to another bus');
  return trip;
}

router.get('/state', (req, res) => {
  const u = req.user;
  const buses = u.role === 'admin' || u.bus_id == null
    ? all('SELECT id, number, name, route FROM buses WHERE active = 1 ORDER BY number')
    : all('SELECT id, number, name, route FROM buses WHERE id = ? AND active = 1', u.bus_id);
  const active = u.role === 'admin'
    ? all("SELECT t.id FROM trips t WHERE t.status = 'active' ORDER BY t.started_at DESC")
    : all("SELECT t.id FROM trips t WHERE t.status = 'active' AND (t.incharge_id = ? OR t.bus_id = ?) ORDER BY t.started_at DESC", u.id, u.bus_id ?? -1);
  const activeTrips = active.map((r) => withCounts(getTrip(r.id)));
  res.json({ user: u, buses, activeTrips, qr: { rotateSec: config.qrRotateSec, baseUrl: baseUrl() } });
});

router.post('/trips', (req, res) => {
  const { bus_id, direction } = validate(
    z.object({ bus_id: z.coerce.number().int().positive(), direction: z.enum(['to_college', 'from_college']) }),
    req.body,
  );
  const u = req.user;
  if (u.role !== 'admin' && u.bus_id != null && u.bus_id !== bus_id) throw new HttpError(403, 'You can only run trips for your assigned bus');
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
  const url = checkinUrl(token);
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
