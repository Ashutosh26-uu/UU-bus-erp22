import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, batch, batchChunks, now, getSetting, setSetting, dbKind } from '../db.js';
import { config, lanIp } from '../config.js';
import { HttpError, validate, intParam } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { hashPassword, generatePassword, passwordProblem, normUuid } from '../security.js';
import { audit } from '../services/audit.js';
import { parseCsv, toCsv, mapHeaders } from '../services/csv.js';
import { tripSummary, listTrips, activeTrips, endTrip } from '../services/trips.js';
import { clientCount } from '../services/events.js';
import { baseUrl, qrMode, setQrMode } from '../services/qr.js';
import { seedFleet, FLEET } from '../services/fleet.js';
import { addDemoStudents, removeDemoStudents } from '../services/demo.js';

const router = Router();
router.use(requireAuth('admin'));

// ------------------------------------------------------------------ helpers
const idOrNull = z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable());
const str = (max, min = 0) => z.string().trim().min(min).max(max);
const IST_OFFSET_MS = 330 * 60_000; // the college runs on India time, whatever timezone the server is in

/** [start, end) of a calendar day in India time. dateStr = YYYY-MM-DD, default today. */
function dayRange(dateStr) {
  let y; let m; let d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [y, m, d] = dateStr.split('-').map(Number);
  } else {
    const ist = new Date(Date.now() + IST_OFFSET_MS);
    y = ist.getUTCFullYear(); m = ist.getUTCMonth() + 1; d = ist.getUTCDate();
  }
  const start = Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
  return { start, end: start + 86_400_000 };
}

async function ensureStopOnBus(stopId, busId) {
  if (stopId == null) return null;
  if (busId == null) throw new HttpError(400, 'Pick a bus before picking a stop');
  const stop = await get('SELECT id FROM stops WHERE id = ? AND bus_id = ?', stopId, busId);
  if (!stop) throw new HttpError(400, 'That stop does not belong to the selected bus');
  return stopId;
}

const fmtLocal = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '');
const count = async (sql, ...p) => (await get(sql, ...p)).c;

// ------------------------------------------------------------------ dashboard
router.get('/dashboard', async (req, res) => {
  const { start, end } = dayRange();
  const [todayBoarded, todayFlagged, todayTrips, students, buses, incharges, live, recent] = await Promise.all([
    count('SELECT COUNT(*) AS c FROM checkins WHERE created_at >= ? AND created_at < ?', start, end),
    count("SELECT COUNT(*) AS c FROM checkins WHERE created_at >= ? AND created_at < ? AND flags <> ''", start, end),
    count('SELECT COUNT(*) AS c FROM trips WHERE started_at >= ? AND started_at < ?', start, end),
    count('SELECT COUNT(*) AS c FROM students WHERE active = 1'),
    count('SELECT COUNT(*) AS c FROM buses WHERE active = 1'),
    count("SELECT COUNT(*) AS c FROM users WHERE role = 'incharge' AND active = 1"),
    activeTrips(),
    all(
      `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, s.uuid, s.name, s.course, s.year, st.name AS stop, b.number AS bus_number, t.direction
         FROM checkins c JOIN students s ON s.id = c.student_id JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id
         LEFT JOIN stops st ON st.id = s.stop_id
        WHERE c.created_at >= ? ORDER BY c.created_at DESC LIMIT 40`,
      start,
    ),
  ]);
  const stats = { todayBoarded, todayFlagged, todayTrips, students, buses, incharges, liveScreens: clientCount() };
  res.json({ stats, activeTrips: live, recent, serverTime: Date.now() });
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

router.get('/students', async (req, res) => {
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
  const [total, items] = await Promise.all([
    count(`SELECT COUNT(*) AS c FROM students s ${w}`, ...params),
    all(
      `SELECT s.*, st.name AS stop_name, b.number AS bus_number FROM students s
         LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id
         ${w} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...params, limit, (page - 1) * limit,
    ),
  ]);
  res.json({ items, total, page, limit });
});

router.post('/students', async (req, res) => {
  const d = validate(studentSchema, req.body);
  await ensureStopOnBus(d.stop_id, d.bus_id);
  if (await get('SELECT id FROM students WHERE uuid = ?', d.uuid)) throw new HttpError(409, 'A student with that ID already exists');
  const t = now();
  const id = (await run(
    'INSERT INTO students(uuid,name,course,year,specialization,bus_id,stop_id,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    d.uuid, d.name, d.course, d.year, d.specialization, d.bus_id, d.stop_id, d.phone, d.active, t, t,
  )).lastInsertRowid;
  await audit(req, 'student.create', 'student', id, `${d.uuid} ${d.name}`);
  res.status(201).json({ id });
});

router.put('/students/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!(await get('SELECT id FROM students WHERE id = ?', id))) throw new HttpError(404, 'Student not found');
  const d = validate(studentSchema, req.body);
  await ensureStopOnBus(d.stop_id, d.bus_id);
  if (await get('SELECT id FROM students WHERE uuid = ? AND id <> ?', d.uuid, id)) throw new HttpError(409, 'Another student already has that ID');
  await run(
    'UPDATE students SET uuid=?, name=?, course=?, year=?, specialization=?, bus_id=?, stop_id=?, phone=?, active=?, updated_at=? WHERE id = ?',
    d.uuid, d.name, d.course, d.year, d.specialization, d.bus_id, d.stop_id, d.phone, d.active, now(), id,
  );
  await audit(req, 'student.update', 'student', id, `${d.uuid} ${d.name}`);
  res.json({ ok: true });
});

router.delete('/students/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const s = await get('SELECT uuid, name FROM students WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'Student not found');
  if (await get('SELECT 1 AS x FROM checkins WHERE student_id = ? LIMIT 1', id)) {
    await run('UPDATE students SET active = 0, updated_at = ? WHERE id = ?', now(), id);
    await audit(req, 'student.deactivate', 'student', id, `${s.uuid} ${s.name} (has boarding history, kept)`);
    return res.json({ ok: true, deactivated: true });
  }
  await batch([
    ['UPDATE devices SET student_id = NULL, bound_at = NULL WHERE student_id = ?', id],
    ['DELETE FROM students WHERE id = ?', id],
  ]);
  await audit(req, 'student.delete', 'student', id, `${s.uuid} ${s.name}`);
  res.json({ ok: true, deleted: true });
});

router.get('/students/:id/history', async (req, res) => {
  const id = intParam(req.params.id);
  const [items, devices] = await Promise.all([
    all(
      `SELECT c.id, c.created_at, c.method, c.flags, c.note, t.direction, b.number AS bus_number
         FROM checkins c JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id
        WHERE c.student_id = ? ORDER BY c.created_at DESC LIMIT 60`,
      id,
    ),
    all('SELECT id, ua, bound_at, first_seen, last_seen FROM devices WHERE student_id = ? ORDER BY last_seen DESC', id),
  ]);
  res.json({ items, devices: devices.map((d) => ({ ...d, id: d.id.slice(0, 8) + '…' })) });
});

router.post('/students/:id/devices/reset', async (req, res) => {
  const id = intParam(req.params.id);
  const r = await run('UPDATE devices SET student_id = NULL, bound_at = NULL WHERE student_id = ?', id);
  await audit(req, 'student.devices.reset', 'student', id, `${r.changes} device(s) unlinked`);
  res.json({ ok: true, unlinked: r.changes });
});

router.post('/students/import', async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Send CSV text');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one student');
  if (rows.length > 20_001) throw new HttpError(413, 'Import at most 20,000 students per file');
  const idx = mapHeaders(rows[0]);
  if (idx.uuid == null || idx.name == null) throw new HttpError(400, 'CSV header must include "uuid" (or id/enrollment) and "name" columns');
  const cell = (r, k) => (idx[k] == null ? '' : String(r[idx[k]] ?? '').trim());
  const summary = { inserted: 0, updated: 0, skipped: 0, errors: [], busesCreated: 0, stopsCreated: 0 };

  // Read what exists once, then write everything as set-based statements in atomic chunks:
  // a few round trips for thousands of rows, even against a hosted database.
  const [busRows, stopRows, uuidRows] = await Promise.all([
    all('SELECT number FROM buses'),
    all('SELECT b.number, s.name FROM stops s JOIN buses b ON b.id = s.bus_id'),
    all('SELECT uuid FROM students'),
  ]);
  const knownBuses = new Set(busRows.map((b) => b.number.toLowerCase()));
  const knownStops = new Set(stopRows.map((s) => `${s.number.toLowerCase()}|${s.name.toLowerCase()}`));
  const knownUuids = new Set(uuidRows.map((s) => s.uuid.toUpperCase()));
  const ts = now();
  const busStmts = [];
  const stopStmts = [];
  const studentStmts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const uuid = normUuid(cell(r, 'uuid')).slice(0, 40);
    const name = cell(r, 'name').slice(0, 80);
    if (!uuid || !name) { summary.errors.push(`Row ${i + 1}: missing id or name`); summary.skipped++; continue; }
    const busNo = cell(r, 'bus').slice(0, 20);
    const stopName = busNo ? cell(r, 'stop').slice(0, 80) : '';
    if (busNo && !knownBuses.has(busNo.toLowerCase())) {
      knownBuses.add(busNo.toLowerCase());
      busStmts.push(['INSERT OR IGNORE INTO buses(number, name, route, active, created_at) VALUES(?, ?, \'\', 1, ?)', busNo, `Bus ${busNo}`, ts]);
      summary.busesCreated++;
    }
    const sk = `${busNo.toLowerCase()}|${stopName.toLowerCase()}`;
    if (stopName && !knownStops.has(sk)) {
      knownStops.add(sk);
      stopStmts.push([
        `INSERT OR IGNORE INTO stops(bus_id, name, seq)
         SELECT b.id, ?, COALESCE((SELECT MAX(seq) FROM stops WHERE bus_id = b.id), 0) + 1 FROM buses b WHERE b.number = ?`,
        stopName, busNo,
      ]);
      summary.stopsCreated++;
    }
    if (knownUuids.has(uuid)) summary.updated++;
    else { knownUuids.add(uuid); summary.inserted++; }
    studentStmts.push([
      `INSERT INTO students(uuid, name, course, year, specialization, bus_id, stop_id, phone, active, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?,
         (SELECT id FROM buses WHERE number = ?),
         (SELECT s.id FROM stops s JOIN buses b ON b.id = s.bus_id WHERE b.number = ? AND s.name = ? COLLATE NOCASE),
         ?, 1, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, course = excluded.course, year = excluded.year,
         specialization = excluded.specialization, bus_id = excluded.bus_id, stop_id = excluded.stop_id,
         phone = excluded.phone, active = 1, updated_at = excluded.updated_at`,
      uuid, name, cell(r, 'course').slice(0, 80), cell(r, 'year').slice(0, 20), cell(r, 'specialization').slice(0, 80),
      busNo, busNo, stopName, cell(r, 'phone').slice(0, 20), ts, ts,
    ]);
  }
  await batchChunks([...busStmts, ...stopStmts]);
  await batchChunks(studentStmts);
  await audit(req, 'student.import', 'student', null, `${summary.inserted} new, ${summary.updated} updated, ${summary.skipped} skipped`);
  res.json(summary);
});

/** Dummy students (IDs DEMO-<bus>-<n>) for trying the system out; repeatable, removable. */
router.post('/demo-students', async (req, res) => {
  const { perBus } = validate(z.object({ perBus: z.coerce.number().int().min(1).max(50).default(6) }), req.body);
  const r = await addDemoStudents(perBus);
  if (!r.buses) throw new HttpError(409, 'Create the buses first (Buses & stops → Create 19-bus fleet).');
  await audit(req, 'student.demo.add', 'student', null, `${r.inserted} demo students added (${r.perBus} per bus, ${r.buses} buses)`);
  res.json(r);
});

router.delete('/demo-students', async (req, res) => {
  const r = await removeDemoStudents();
  await audit(req, 'student.demo.remove', 'student', null, `${r.removed} demo students removed`);
  res.json(r);
});

router.get('/students/export.csv', async (req, res) => {
  const rows = await all(
    `SELECT s.uuid, s.name, s.course, s.year, s.specialization, b.number AS bus, st.name AS stop, s.phone, s.active
       FROM students s LEFT JOIN buses b ON b.id = s.bus_id LEFT JOIN stops st ON st.id = s.stop_id
      ORDER BY CAST(b.number AS INTEGER), b.number, s.name`,
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="students-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(rows, ['uuid', 'name', 'course', 'year', 'specialization', 'bus', 'stop', 'phone', 'active']));
});

// ------------------------------------------------------------------ buses & stops
router.get('/buses', async (req, res) => {
  const [buses, stops, incharges] = await Promise.all([
    all(
      `SELECT b.*, (SELECT COUNT(*) FROM students s WHERE s.bus_id = b.id AND s.active = 1) AS students,
              (SELECT COUNT(*) FROM trips t WHERE t.bus_id = b.id AND t.status = 'active') AS live
         FROM buses b ORDER BY b.active DESC, CAST(b.number AS INTEGER), b.number`,
    ),
    all('SELECT * FROM stops ORDER BY bus_id, seq, name'),
    all("SELECT id, name, username, bus_id FROM users WHERE role = 'incharge' AND active = 1 ORDER BY name"),
  ]);
  res.json({ buses: buses.map((b) => ({ ...b, stops: stops.filter((s) => s.bus_id === b.id), incharges: incharges.filter((u) => u.bus_id === b.id) })) });
});

/**
 * Create the standard 19-bus fleet (buses, stops, one incharge per bus) on the server, so hosted
 * deployments need no local scripts. Only missing pieces are added. New incharge passwords are
 * returned once and never stored in plain text.
 */
router.post('/fleet', async (req, res) => {
  const created = await seedFleet();
  await audit(req, 'fleet.seed', 'bus', null, `${created.buses} buses, ${created.stops} stops, ${created.incharges.length} incharge accounts created`);
  res.set('Cache-Control', 'no-store');
  res.json({ fleetSize: FLEET.length, buses: created.buses, stops: created.stops, incharges: created.incharges });
});

const busSchema = z.object({ number: str(20, 1), name: str(60, 1), route: str(200).default(''), active: z.boolean().optional().default(true) });

router.post('/buses', async (req, res) => {
  const d = validate(busSchema, req.body);
  if (await get('SELECT id FROM buses WHERE number = ?', d.number)) throw new HttpError(409, 'Bus number already exists');
  const id = (await run('INSERT INTO buses(number,name,route,active,created_at) VALUES(?,?,?,?,?)', d.number, d.name, d.route, d.active, now())).lastInsertRowid;
  await audit(req, 'bus.create', 'bus', id, d.number);
  res.status(201).json({ id });
});

router.put('/buses/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!(await get('SELECT id FROM buses WHERE id = ?', id))) throw new HttpError(404, 'Bus not found');
  const d = validate(busSchema, req.body);
  if (await get('SELECT id FROM buses WHERE number = ? AND id <> ?', d.number, id)) throw new HttpError(409, 'Bus number already exists');
  await run('UPDATE buses SET number=?, name=?, route=?, active=? WHERE id = ?', d.number, d.name, d.route, d.active, id);
  await audit(req, 'bus.update', 'bus', id, d.number);
  res.json({ ok: true });
});

router.delete('/buses/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const b = await get('SELECT number FROM buses WHERE id = ?', id);
  if (!b) throw new HttpError(404, 'Bus not found');
  if (await get('SELECT 1 AS x FROM trips WHERE bus_id = ? LIMIT 1', id)) {
    await run('UPDATE buses SET active = 0 WHERE id = ?', id);
    await audit(req, 'bus.deactivate', 'bus', id, b.number);
    return res.json({ ok: true, deactivated: true });
  }
  // explicit clean-up: correct whether or not the database enforces foreign keys
  await batch([
    ['UPDATE students SET bus_id = NULL, stop_id = NULL WHERE bus_id = ?', id],
    ['UPDATE users SET bus_id = NULL WHERE bus_id = ?', id],
    ['DELETE FROM stops WHERE bus_id = ?', id],
    ['DELETE FROM buses WHERE id = ?', id],
  ]);
  await audit(req, 'bus.delete', 'bus', id, b.number);
  res.json({ ok: true, deleted: true });
});

router.post('/buses/:id/stops', async (req, res) => {
  const busId = intParam(req.params.id, 'bus');
  if (!(await get('SELECT id FROM buses WHERE id = ?', busId))) throw new HttpError(404, 'Bus not found');
  const { name } = validate(z.object({ name: str(80, 1) }), req.body);
  if (await get('SELECT id FROM stops WHERE bus_id = ? AND name = ?', busId, name)) throw new HttpError(409, 'Stop already exists on this bus');
  const seq = ((await get('SELECT COALESCE(MAX(seq),0) AS m FROM stops WHERE bus_id = ?', busId)).m || 0) + 1;
  const id = (await run('INSERT INTO stops(bus_id,name,seq) VALUES(?,?,?)', busId, name, seq)).lastInsertRowid;
  await audit(req, 'stop.create', 'stop', id, name);
  res.status(201).json({ id, seq });
});

router.put('/stops/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const stop = await get('SELECT * FROM stops WHERE id = ?', id);
  if (!stop) throw new HttpError(404, 'Stop not found');
  const d = validate(z.object({ name: str(80, 1), seq: z.coerce.number().int().min(0).max(999).optional() }), req.body);
  if (await get('SELECT id FROM stops WHERE bus_id = ? AND name = ? AND id <> ?', stop.bus_id, d.name, id)) throw new HttpError(409, 'Stop already exists on this bus');
  await run('UPDATE stops SET name = ?, seq = ? WHERE id = ?', d.name, d.seq ?? stop.seq, id);
  res.json({ ok: true });
});

router.delete('/stops/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const stop = await get('SELECT name FROM stops WHERE id = ?', id);
  if (!stop) throw new HttpError(404, 'Stop not found');
  await batch([
    ['UPDATE students SET stop_id = NULL WHERE stop_id = ?', id],
    ['DELETE FROM stops WHERE id = ?', id],
  ]);
  await audit(req, 'stop.delete', 'stop', id, stop.name);
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

router.get('/users', async (req, res) => {
  res.json({
    items: await all(
      `SELECT u.id, u.username, u.name, u.role, u.bus_id, u.active, u.must_change_password, u.locked_until, u.created_at, b.number AS bus_number,
              (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u LEFT JOIN buses b ON b.id = u.bus_id ORDER BY u.role, CAST(b.number AS INTEGER), b.number, u.name COLLATE NOCASE`,
    ),
  });
});

router.post('/users', async (req, res) => {
  const d = validate(userSchema, req.body);
  if (await get('SELECT id FROM users WHERE username = ?', d.username)) throw new HttpError(409, 'Username already taken');
  if (d.bus_id != null && !(await get('SELECT id FROM buses WHERE id = ?', d.bus_id))) throw new HttpError(400, 'Bus not found');
  const password = d.password || generatePassword(12);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const t = now();
  const id = (await run(
    'INSERT INTO users(username,name,role,password_hash,bus_id,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)',
    d.username, d.name, d.role, hashPassword(password), d.role === 'admin' ? null : d.bus_id, d.active, t, t,
  )).lastInsertRowid;
  await audit(req, 'user.create', 'user', id, `${d.username} (${d.role})`);
  res.status(201).json({ id, password });
});

router.put('/users/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const u = await get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const d = validate(userSchema.omit({ password: true }), req.body);
  if (await get('SELECT id FROM users WHERE username = ? AND id <> ?', d.username, id)) throw new HttpError(409, 'Username already taken');
  if (id === req.user.id && (d.role !== 'admin' || !d.active)) throw new HttpError(400, 'You cannot demote or deactivate yourself');
  if (d.bus_id != null && !(await get('SELECT id FROM buses WHERE id = ?', d.bus_id))) throw new HttpError(400, 'Bus not found');
  await run('UPDATE users SET username=?, name=?, role=?, bus_id=?, active=?, updated_at=? WHERE id = ?', d.username, d.name, d.role, d.role === 'admin' ? null : d.bus_id, d.active, now(), id);
  if (!d.active) await run('DELETE FROM sessions WHERE user_id = ?', id);
  await audit(req, 'user.update', 'user', id, `${d.username} (${d.role})${d.active ? '' : ' deactivated'}`);
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const id = intParam(req.params.id);
  const u = await get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const password = generatePassword(12);
  await run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password), now(), id);
  await run('DELETE FROM sessions WHERE user_id = ?', id);
  await audit(req, 'user.password.reset', 'user', id, u.username);
  res.json({ password });
});

router.delete('/users/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot delete yourself');
  const u = await get('SELECT username FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  const referenced = (await get('SELECT 1 AS x FROM trips WHERE incharge_id = ? OR ended_by = ? LIMIT 1', id, id))
    || (await get('SELECT 1 AS x FROM checkins WHERE marked_by = ? LIMIT 1', id));
  if (referenced) {
    await run('UPDATE users SET active = 0, updated_at = ? WHERE id = ?', now(), id);
    await run('DELETE FROM sessions WHERE user_id = ?', id);
    await audit(req, 'user.deactivate', 'user', id, u.username);
    return res.json({ ok: true, deactivated: true });
  }
  await batch([
    ['DELETE FROM sessions WHERE user_id = ?', id],
    ['DELETE FROM users WHERE id = ?', id],
  ]);
  await audit(req, 'user.delete', 'user', id, u.username);
  res.json({ ok: true, deleted: true });
});

// ------------------------------------------------------------------ trips
router.get('/trips', async (req, res) => {
  const { start, end } = dayRange(String(req.query.date || ''));
  const busId = req.query.bus ? intParam(req.query.bus, 'bus') : null;
  res.json({ items: await listTrips({ start, end, busId, limit: 200 }), start, end });
});

router.get('/trips/:id', async (req, res) => {
  const s = await tripSummary(intParam(req.params.id, 'trip'));
  if (!s) throw new HttpError(404, 'Trip not found');
  res.json(s);
});

router.post('/trips/:id/end', async (req, res) => {
  const id = intParam(req.params.id, 'trip');
  const trip = await endTrip(id, req.user.id);
  await audit(req, 'trip.end', 'trip', id, `by admin, bus ${trip.bus_number}`);
  res.json({ trip });
});

router.get('/trips/:id/export.csv', async (req, res) => {
  const s = await tripSummary(intParam(req.params.id, 'trip'));
  if (!s) throw new HttpError(404, 'Trip not found');
  const rows = s.checkins.map((c) => ({ ...c, boarded_at: fmtLocal(c.created_at) }));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="trip-${s.trip.id}-bus-${s.trip.bus_number}.csv"`);
  res.send(toCsv(rows, ['uuid', 'name', 'course', 'year', 'specialization', 'stop', 'boarded_at', 'method', 'flags', 'note']));
});

router.get('/flags', async (req, res) => {
  const { start, end } = dayRange(String(req.query.date || ''));
  const items = await all(
    `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, c.note, c.ip, s.uuid, s.name, s.course, s.year, b.number AS bus_number, t.direction, m.name AS marked_by_name
       FROM checkins c JOIN students s ON s.id = c.student_id JOIN trips t ON t.id = c.trip_id JOIN buses b ON b.id = t.bus_id LEFT JOIN users m ON m.id = c.marked_by
      WHERE c.flags <> '' AND c.created_at >= ? AND c.created_at < ? ORDER BY c.created_at DESC LIMIT 300`,
    start, end,
  );
  res.json({ items });
});

// ------------------------------------------------------------------ audit log
router.get('/audit', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const [total, items] = await Promise.all([
    count('SELECT COUNT(*) AS c FROM audit_log'),
    all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', limit, (page - 1) * limit),
  ]);
  res.json({ items, total, page, limit });
});

// ------------------------------------------------------------------ settings
router.get('/settings', async (req, res) => {
  res.json({
    base_url: await getSetting('base_url'),
    effectiveBaseUrl: await baseUrl(req),
    serverless: config.serverless,
    database: dbKind(),
    liveMode: config.liveMode,
    lanIp: config.serverless ? null : lanIp(),
    port: config.port,
    qrMode: await qrMode(),
    qrRotateSec: config.qrRotateSec,
    checkinMinutes: config.checkinTtlMs / 60_000,
    maxDevicesPerStudent: config.maxDevicesPerStudent,
    envBaseUrl: config.baseUrl,
  });
});

/** Partial update: send only what changes (base_url and/or qr_mode). */
router.put('/settings', async (req, res) => {
  const { base_url, qr_mode } = validate(
    z.object({
      base_url: z.string().trim().max(200).refine((v) => v === '' || /^https?:\/\/[^\s/?#]+$/i.test(v), 'Use the form http://192.168.1.5:3000 or https://bus.college.edu (no path)').optional(),
      qr_mode: z.enum(['day', 'rotating']).optional(),
    }),
    req.body,
  );
  if (base_url != null) {
    await setSetting('base_url', base_url.replace(/\/+$/, ''));
    await audit(req, 'settings.update', 'settings', 'base_url', base_url || '(auto)');
  }
  if (qr_mode) {
    await setQrMode(qr_mode);
    await audit(req, 'settings.update', 'settings', 'qr_mode', qr_mode === 'day' ? 'QR valid for the whole day' : `QR rotates every ${config.qrRotateSec}s`);
  }
  res.json({ ok: true, effectiveBaseUrl: await baseUrl(req), qrMode: await qrMode() });
});

export default router;
