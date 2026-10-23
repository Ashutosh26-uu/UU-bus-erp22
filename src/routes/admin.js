import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, now, tx, getSetting, setSetting } from '../db.js';
import { config, lanIp } from '../config.js';
import { HttpError, validate, intParam } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { hashPassword, generatePassword, passwordProblem, normUuid } from '../security.js';
import { audit } from '../services/audit.js';
import { parseCsv, toCsv, mapHeaders } from '../services/csv.js';
import { tripSummary, listTrips, activeTrips, endTrip } from '../services/trips.js';
import { clientCount } from '../services/events.js';
import { baseUrl } from '../services/qr.js';

const router = Router();
router.use(requireAuth('admin'));

// ------------------------------------------------------------------ helpers
const idOrNull = z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable());
const str = (max, min = 0) => z.string().trim().min(min).max(max);

function dayRange(dateStr) {
  let d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, dd] = dateStr.split('-').map(Number);
    d = new Date(y, m - 1, dd);
  } else {
    d = new Date();
    d.setHours(0, 0, 0, 0);
  }
  const start = d.getTime();
  return { start, end: start + 86_400_000 };
}

function ensureStopOnBus(stopId, busId) {
  if (stopId == null) return null;
  if (busId == null) throw new HttpError(400, 'Pick a bus before picking a stop');
  const stop = get('SELECT id FROM stops WHERE id = ? AND bus_id = ?', stopId, busId);
  if (!stop) throw new HttpError(400, 'That stop does not belong to the selected bus');
  return stopId;
}

const fmtLocal = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { hour12: false }) : '');

// ------------------------------------------------------------------ dashboard
router.get('/dashboard', (req, res) => {
  const { start, end } = dayRange();
  const stats = {
    todayBoarded: get('SELECT COUNT(*) AS c FROM checkins WHERE created_at >= ? AND created_at < ?', start, end).c,
    todayFlagged: get("SELECT COUNT(*) AS c FROM checkins WHERE created_at >= ? AND created_at < ? AND flags <> ''", start, end).c,
    todayTrips: get('SELECT COUNT(*) AS c FROM trips WHERE started_at >= ? AND started_at < ?', start, end).c,
    students: get('SELECT COUNT(*) AS c FROM students WHERE active = 1').c,
    buses: get('SELECT COUNT(*) AS c FROM buses WHERE active = 1').c,
    incharges: get("SELECT COUNT(*) AS c FROM users WHERE role = 'incharge' AND active = 1").c,
    liveScreens: clientCount(),
  };
  const recent = all(
    `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, s.uuid, s.name, s.course, s.year, st.name AS stop, b.number AS bus_number, t.direction
       FROM checkins c JOIN students s ON s.id = c.student_id JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id
       LEFT JOIN stops st ON st.id = s.stop_id
      WHERE c.created_at >= ? ORDER BY c.created_at DESC LIMIT 40`,
    start,
  );
  res.json({ stats, activeTrips: activeTrips(), recent, serverTime: Date.now() });
});

// ------------------------------------------------------------------ students
const studentSchema = z.object({
  uuid: str(40, 2).transform(normUuid),
  name: str(80, 2),
  course: str(80).default(''),
  year: str(20).default(''),
  specialization: str(80).default(''),
  bus_id: idOrNull.optional().default(null),
  stop_id: idOrNull.optional().default(null),
  phone: str(20).default(''),
  active: z.boolean().optional().default(true),
});

router.get('/students', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const bus = String(req.query.bus || '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const where = [];
  const params = [];
  if (q) { const like = `%${q.replace(/[%_]/g, '')}%`; where.push('(s.name LIKE ? OR s.uuid LIKE ? OR s.course LIKE ?)'); params.push(like, like, like); }
  if (bus === 'none') where.push('s.bus_id IS NULL');
  else if (bus) { where.push('s.bus_id = ?'); params.push(intParam(bus, 'bus')); }
  if (req.query.active === '1') where.push('s.active = 1');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS c FROM students s ${w}`, ...params).c;
  const items = all(
    `SELECT s.*, st.name AS stop_name, b.number AS bus_number FROM students s
       LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id
       ${w} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    ...params, limit, (page - 1) * limit,
  );
  res.json({ items, total, page, limit });
});

router.post('/students', (req, res) => {
  const d = validate(studentSchema, req.body);
  ensureStopOnBus(d.stop_id, d.bus_id);
  if (get('SELECT id FROM students WHERE uuid = ?', d.uuid)) throw new HttpError(409, 'A student with that ID already exists');
  const t = now();
  const id = run(
    'INSERT INTO students(uuid,name,course,year,specialization,bus_id,stop_id,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    d.uuid, d.name, d.course, d.year, d.specialization, d.bus_id, d.stop_id, d.phone, d.active, t, t,
  ).lastInsertRowid;
  audit(req, 'student.create', 'student', id, `${d.uuid} ${d.name}`);
  res.status(201).json({ id });
});

router.put('/students/:id', (req, res) => {
  const id = intParam(req.params.id);
  if (!get('SELECT id FROM students WHERE id = ?', id)) throw new HttpError(404, 'Student not found');
  const d = validate(studentSchema, req.body);
  ensureStopOnBus(d.stop_id, d.bus_id);
  const dup = get('SELECT id FROM students WHERE uuid = ? AND id <> ?', d.uuid, id);
  if (dup) throw new HttpError(409, 'Another student already has that ID');
  run(
    'UPDATE students SET uuid=?, name=?, course=?, year=?, specialization=?, bus_id=?, stop_id=?, phone=?, active=?, updated_at=? WHERE id = ?',
    d.uuid, d.name, d.course, d.year, d.specialization, d.bus_id, d.stop_id, d.phone, d.active, now(), id,
  );
  audit(req, 'student.update', 'student', id, `${d.uuid} ${d.name}`);
  res.json({ ok: true });
});

router.delete('/students/:id', (req, res) => {
  const id = intParam(req.params.id);
  const s = get('SELECT uuid, name FROM students WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'Student not found');
  const hasHistory = get('SELECT 1 FROM checkins WHERE student_id = ? LIMIT 1', id);
  if (hasHistory) {
    run('UPDATE students SET active = 0, updated_at = ? WHERE id = ?', now(), id);
    audit(req, 'student.deactivate', 'student', id, `${s.uuid} ${s.name} (has boarding history, kept)`);
    return res.json({ ok: true, deactivated: true });
  }
  run('DELETE FROM students WHERE id = ?', id);
  audit(req, 'student.delete', 'student', id, `${s.uuid} ${s.name}`);
  res.json({ ok: true, deleted: true });
});

router.get('/students/:id/history', (req, res) => {
  const id = intParam(req.params.id);
  const items = all(
    `SELECT c.id, c.created_at, c.method, c.flags, c.note, t.direction, b.number AS bus_number
       FROM checkins c JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id
      WHERE c.student_id = ? ORDER BY c.created_at DESC LIMIT 60`,
    id,
  );
  const devices = all('SELECT id, ua, bound_at, first_seen, last_seen FROM devices WHERE student_id = ? ORDER BY last_seen DESC', id)
    .map((d) => ({ ...d, id: d.id.slice(0, 8) + '…', fullId: d.id }));
  res.json({ items, devices });
});

router.post('/students/:id/devices/reset', (req, res) => {
  const id = intParam(req.params.id);
  const r = run('UPDATE devices SET student_id = NULL, bound_at = NULL WHERE student_id = ?', id);
  audit(req, 'student.devices.reset', 'student', id, `${r.changes} device(s) unlinked`);
  res.json({ ok: true, unlinked: r.changes });
});

router.post('/students/import', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Send CSV text');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one student');
  const idx = mapHeaders(rows[0]);
  if (idx.uuid == null || idx.name == null) throw new HttpError(400, 'CSV header must include "uuid" (or id/enrollment) and "name" columns');
  const cell = (r, k) => (idx[k] == null ? '' : String(r[idx[k]] ?? '').trim());
  const summary = { inserted: 0, updated: 0, skipped: 0, errors: [], busesCreated: 0, stopsCreated: 0 };
  tx(() => {
    const t = now();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const uuid = normUuid(cell(r, 'uuid'));
      const name = cell(r, 'name');
      if (!uuid || !name) { summary.errors.push(`Row ${i + 1}: missing id or name`); summary.skipped++; continue; }
      let busId = null;
      let stopId = null;
      const busNo = cell(r, 'bus');
      if (busNo) {
        let bus = get('SELECT id FROM buses WHERE number = ?', busNo);
        if (!bus) {
          bus = { id: run('INSERT INTO buses(number,name,route,active,created_at) VALUES(?,?,?,1,?)', busNo, `Bus ${busNo}`, '', t).lastInsertRowid };
          summary.busesCreated++;
        }
        busId = bus.id;
        const stopName = cell(r, 'stop');
        if (stopName) {
          let stop = get('SELECT id FROM stops WHERE bus_id = ? AND name = ?', busId, stopName);
          if (!stop) {
            const seq = (get('SELECT COALESCE(MAX(seq),0) AS m FROM stops WHERE bus_id = ?', busId).m || 0) + 1;
            stop = { id: run('INSERT INTO stops(bus_id,name,seq) VALUES(?,?,?)', busId, stopName, seq).lastInsertRowid };
            summary.stopsCreated++;
          }
          stopId = stop.id;
        }
      }
      const existing = get('SELECT id FROM students WHERE uuid = ?', uuid);
      const vals = [name, cell(r, 'course').slice(0, 80), cell(r, 'year').slice(0, 20), cell(r, 'specialization').slice(0, 80), busId, stopId, cell(r, 'phone').slice(0, 20)];
      if (existing) {
        run('UPDATE students SET name=?, course=?, year=?, specialization=?, bus_id=?, stop_id=?, phone=?, active=1, updated_at=? WHERE id = ?', ...vals, t, existing.id);
        summary.updated++;
      } else {
        run('INSERT INTO students(uuid,name,course,year,specialization,bus_id,stop_id,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)', uuid, ...vals, t, t);
        summary.inserted++;
      }
    }
  });
  audit(req, 'student.import', 'student', null, `${summary.inserted} new, ${summary.updated} updated, ${summary.skipped} skipped`);
  res.json(summary);
});

router.get('/students/export.csv', (req, res) => {
  const rows = all(
    `SELECT s.uuid, s.name, s.course, s.year, s.specialization, b.number AS bus, st.name AS stop, s.phone, s.active
       FROM students s LEFT JOIN buses b ON b.id = s.bus_id LEFT JOIN stops st ON st.id = s.stop_id ORDER BY b.number, s.name`,
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="students-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(rows, ['uuid', 'name', 'course', 'year', 'specialization', 'bus', 'stop', 'phone', 'active']));
});

// ------------------------------------------------------------------ buses & stops
router.get('/buses', (req, res) => {
  const buses = all(
    `SELECT b.*, (SELECT COUNT(*) FROM students s WHERE s.bus_id = b.id AND s.active = 1) AS students,
            (SELECT COUNT(*) FROM trips t WHERE t.bus_id = b.id AND t.status = 'active') AS live
       FROM buses b ORDER BY b.active DESC, b.number`,
  );
  const stops = all('SELECT * FROM stops ORDER BY bus_id, seq, name');
  const incharges = all("SELECT id, name, bus_id FROM users WHERE role = 'incharge' AND active = 1");
  res.json({ buses: buses.map((b) => ({ ...b, stops: stops.filter((s) => s.bus_id === b.id), incharges: incharges.filter((u) => u.bus_id === b.id) })) });
});

const busSchema = z.object({ number: str(20, 1), name: str(60, 1), route: str(200).default(''), active: z.boolean().optional().default(true) });

router.post('/buses', (req, res) => {
  const d = validate(busSchema, req.body);
  if (get('SELECT id FROM buses WHERE number = ?', d.number)) throw new HttpError(409, 'Bus number already exists');
  const id = run('INSERT INTO buses(number,name,route,active,created_at) VALUES(?,?,?,?,?)', d.number, d.name, d.route, d.active, now()).lastInsertRowid;
  audit(req, 'bus.create', 'bus', id, d.number);
  res.status(201).json({ id });
});

router.put('/buses/:id', (req, res) => {
  const id = intParam(req.params.id);
  if (!get('SELECT id FROM buses WHERE id = ?', id)) throw new HttpError(404, 'Bus not found');
  const d = validate(busSchema, req.body);
  if (get('SELECT id FROM buses WHERE number = ? AND id <> ?', d.number, id)) throw new HttpError(409, 'Bus number already exists');
  run('UPDATE buses SET number=?, name=?, route=?, active=? WHERE id = ?', d.number, d.name, d.route, d.active, id);
  audit(req, 'bus.update', 'bus', id, d.number);
  res.json({ ok: true });
});

router.delete('/buses/:id', (req, res) => {
  const id = intParam(req.params.id);
  const b = get('SELECT number FROM buses WHERE id = ?', id);
  if (!b) throw new HttpError(404, 'Bus not found');
  if (get('SELECT 1 FROM trips WHERE bus_id = ? LIMIT 1', id)) {
    run('UPDATE buses SET active = 0 WHERE id = ?', id);
    audit(req, 'bus.deactivate', 'bus', id, b.number);
    return res.json({ ok: true, deactivated: true });
  }
  run('DELETE FROM buses WHERE id = ?', id);
  audit(req, 'bus.delete', 'bus', id, b.number);
  res.json({ ok: true, deleted: true });
});

router.post('/buses/:id/stops', (req, res) => {
  const busId = intParam(req.params.id, 'bus');
  if (!get('SELECT id FROM buses WHERE id = ?', busId)) throw new HttpError(404, 'Bus not found');
  const { name } = validate(z.object({ name: str(80, 1) }), req.body);
  if (get('SELECT id FROM stops WHERE bus_id = ? AND name = ?', busId, name)) throw new HttpError(409, 'Stop already exists on this bus');
  const seq = (get('SELECT COALESCE(MAX(seq),0) AS m FROM stops WHERE bus_id = ?', busId).m || 0) + 1;
  const id = run('INSERT INTO stops(bus_id,name,seq) VALUES(?,?,?)', busId, name, seq).lastInsertRowid;
  audit(req, 'stop.create', 'stop', id, name);
  res.status(201).json({ id, seq });
});

router.put('/stops/:id', (req, res) => {
  const id = intParam(req.params.id);
  const stop = get('SELECT * FROM stops WHERE id = ?', id);
  if (!stop) throw new HttpError(404, 'Stop not found');
  const d = validate(z.object({ name: str(80, 1), seq: z.coerce.number().int().min(0).max(999).optional() }), req.body);
  if (get('SELECT id FROM stops WHERE bus_id = ? AND name = ? AND id <> ?', stop.bus_id, d.name, id)) throw new HttpError(409, 'Stop already exists on this bus');
  run('UPDATE stops SET name = ?, seq = ? WHERE id = ?', d.name, d.seq ?? stop.seq, id);
  res.json({ ok: true });
});

router.delete('/stops/:id', (req, res) => {
  const id = intParam(req.params.id);
  const stop = get('SELECT name FROM stops WHERE id = ?', id);
  if (!stop) throw new HttpError(404, 'Stop not found');
  run('DELETE FROM stops WHERE id = ?', id);
  audit(req, 'stop.delete', 'stop', id, stop.name);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ users (incharges & admins)
const userSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-z0-9._-]+$/i, 'Only letters, numbers, dot, dash, underscore'),
  name: str(80, 2),
  role: z.enum(['admin', 'incharge']),
  bus_id: idOrNull.optional().default(null),
  active: z.boolean().optional().default(true),
  password: z.string().max(128).optional(),
});

router.get('/users', (req, res) => {
  res.json({
    items: all(
      `SELECT u.id, u.username, u.name, u.role, u.bus_id, u.active, u.must_change_password, u.locked_until, u.created_at, b.number AS bus_number,
              (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u LEFT JOIN buses b ON b.id = u.bus_id ORDER BY u.role, u.name COLLATE NOCASE`,
    ),
  });
});

router.post('/users', (req, res) => {
  const d = validate(userSchema, req.body);
  if (get('SELECT id FROM users WHERE username = ?', d.username)) throw new HttpError(409, 'Username already taken');
  if (d.bus_id != null && !get('SELECT id FROM buses WHERE id = ?', d.bus_id)) throw new HttpError(400, 'Bus not found');
  const password = d.password || generatePassword(12);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const t = now();
  const id = run(
    'INSERT INTO users(username,name,role,password_hash,bus_id,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)',
    d.username, d.name, d.role, hashPassword(password), d.role === 'admin' ? null : d.bus_id, d.active, t, t,
  ).lastInsertRowid;
  audit(req, 'user.create', 'user', id, `${d.username} (${d.role})`);
  res.status(201).json({ id, password });
});

router.put('/users/:id', (req, res) => {
  const id = intParam(req.params.id);
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const d = validate(userSchema.omit({ password: true }), req.body);
  if (get('SELECT id FROM users WHERE username = ? AND id <> ?', d.username, id)) throw new HttpError(409, 'Username already taken');
  if (id === req.user.id && (d.role !== 'admin' || !d.active)) throw new HttpError(400, 'You cannot demote or deactivate yourself');
  if (d.bus_id != null && !get('SELECT id FROM buses WHERE id = ?', d.bus_id)) throw new HttpError(400, 'Bus not found');
  run('UPDATE users SET username=?, name=?, role=?, bus_id=?, active=?, updated_at=? WHERE id = ?', d.username, d.name, d.role, d.role === 'admin' ? null : d.bus_id, d.active, now(), id);
  if (!d.active) run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, 'user.update', 'user', id, `${d.username} (${d.role})${d.active ? '' : ' deactivated'}`);
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', (req, res) => {
  const id = intParam(req.params.id);
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const password = generatePassword(12);
  run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password), now(), id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, 'user.password.reset', 'user', id, u.username);
  res.json({ password });
});

router.delete('/users/:id', (req, res) => {
  const id = intParam(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot delete yourself');
  const u = get('SELECT username FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const referenced = get('SELECT 1 FROM trips WHERE incharge_id = ? OR ended_by = ? LIMIT 1', id, id) || get('SELECT 1 FROM checkins WHERE marked_by = ? LIMIT 1', id);
  if (referenced) {
    run('UPDATE users SET active = 0, updated_at = ? WHERE id = ?', now(), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(req, 'user.deactivate', 'user', id, u.username);
    return res.json({ ok: true, deactivated: true });
  }
  run('DELETE FROM users WHERE id = ?', id);
  audit(req, 'user.delete', 'user', id, u.username);
  res.json({ ok: true, deleted: true });
});

// ------------------------------------------------------------------ trips
router.get('/trips', (req, res) => {
  const { start, end } = dayRange(String(req.query.date || ''));
  const busId = req.query.bus ? intParam(req.query.bus, 'bus') : null;
  res.json({ items: listTrips({ start, end, busId, limit: 200 }), start, end });
});

router.get('/trips/:id', (req, res) => {
  const s = tripSummary(intParam(req.params.id, 'trip'));
  if (!s) throw new HttpError(404, 'Trip not found');
  res.json(s);
});

router.post('/trips/:id/end', (req, res) => {
  const id = intParam(req.params.id, 'trip');
  const trip = endTrip(id, req.user.id);
  audit(req, 'trip.end', 'trip', id, `by admin, bus ${trip.bus_number}`);
  res.json({ trip });
});

router.get('/trips/:id/export.csv', (req, res) => {
  const s = tripSummary(intParam(req.params.id, 'trip'));
  if (!s) throw new HttpError(404, 'Trip not found');
  const rows = s.checkins.map((c) => ({ ...c, boarded_at: fmtLocal(c.created_at) }));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="trip-${s.trip.id}-bus-${s.trip.bus_number}.csv"`);
  res.send(toCsv(rows, ['uuid', 'name', 'course', 'year', 'specialization', 'stop', 'boarded_at', 'method', 'flags', 'note']));
});

router.get('/flags', (req, res) => {
  const { start, end } = dayRange(String(req.query.date || ''));
  const items = all(
    `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, c.note, c.ip, s.uuid, s.name, s.course, s.year, b.number AS bus_number, t.direction, m.name AS marked_by_name
       FROM checkins c JOIN students s ON s.id = c.student_id JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id LEFT JOIN users m ON m.id = c.marked_by
      WHERE c.flags <> '' AND c.created_at >= ? AND c.created_at < ? ORDER BY c.created_at DESC LIMIT 300`,
    start, end,
  );
  res.json({ items });
});

// ------------------------------------------------------------------ audit log
router.get('/audit', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const total = get('SELECT COUNT(*) AS c FROM audit_log').c;
  const items = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, (page - 1) * limit);
  res.json({ items, total, page, limit });
});

// ------------------------------------------------------------------ settings
router.get('/settings', (req, res) => {
  res.json({
    base_url: getSetting('base_url'),
    effectiveBaseUrl: baseUrl(),
    lanIp: lanIp(),
    port: config.port,
    qrRotateSec: config.qrRotateSec,
    checkinMinutes: config.checkinTtlMs / 60_000,
    maxDevicesPerStudent: config.maxDevicesPerStudent,
    envBaseUrl: config.baseUrl,
  });
});

router.put('/settings', (req, res) => {
  const { base_url } = validate(
    z.object({
      base_url: z.string().trim().max(200).refine((v) => v === '' || /^https?:\/\/[^\s/?#]+$/i.test(v), 'Use the form http://192.168.1.5:3000 or https://bus.college.edu (no path)'),
    }),
    req.body,
  );
  setSetting('base_url', base_url.replace(/\/+$/, ''));
  audit(req, 'settings.update', 'settings', 'base_url', base_url || '(auto)');
  res.json({ ok: true, effectiveBaseUrl: baseUrl() });
});

export default router;
