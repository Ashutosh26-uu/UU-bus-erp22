import { get, run, batch, now } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { nameMatches, normUuid } from '../security.js';
import { broadcast, tripScope } from './events.js';
import { tripCounts } from './trips.js';

const STUDENT_SQL = `SELECT s.*, st.name AS stop_name, b.number AS bus_number, b.name AS bus_name
  FROM students s LEFT JOIN stops st ON st.id = s.stop_id LEFT JOIN buses b ON b.id = s.bus_id`;

export const studentByUuid = (uuid) => get(`${STUDENT_SQL} WHERE s.uuid = ? AND s.active = 1`, normUuid(uuid));
export const studentById = (id) => get(`${STUDENT_SQL} WHERE s.id = ?`, id);

/** What a student is allowed to see about themselves on the check-in screen. */
export function publicStudent(s, trip) {
  return {
    id: s.id,
    uuid: s.uuid,
    name: s.name,
    course: s.course,
    year: s.year,
    specialization: s.specialization,
    stop: s.stop_name || '',
    bus: s.bus_number ? { number: s.bus_number, name: s.bus_name } : null,
    ownBus: trip ? s.bus_id === trip.bus_id : null,
  };
}

/** Find a student by UUID + name. Returns null on any mismatch (no hint which part was wrong). */
export async function lookupStudent(uuid, name) {
  const s = await studentByUuid(uuid);
  if (!s || !nameMatches(name, s.name)) return null;
  return s;
}

/**
 * Atomic QR check-in with every anti-proxy rule:
 *  - trip must still be running
 *  - one check-in per student per trip
 *  - one phone per trip (a phone cannot board two students)
 *  - a phone is bound to the first student who uses it; another student on that phone is refused
 *  - a student may use at most N phones in 30 days (then admin must reset)
 *  - boarding another bus is allowed but flagged
 * Reads first, then ONE atomic write batch. The batch re-checks the critical rules in SQL (trip still
 * running, phone owned by this student) and unique indexes stop double boarding, so two phones racing
 * each other can never both win, and the database write lock is held for milliseconds.
 */
export async function confirmCheckin({ sessionId, trip, student, deviceId, ip, ua }) {
  const ts = now();
  const [live, existing, devUsed, dev] = await Promise.all([
    get('SELECT status FROM trips WHERE id = ?', trip.id),
    get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id),
    get('SELECT student_id FROM checkins WHERE trip_id = ? AND device_id = ?', trip.id, deviceId),
    get('SELECT student_id FROM devices WHERE id = ?', deviceId),
  ]);
  if (!live || live.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
  if (existing) throw new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY', at: existing.created_at });
  if (devUsed) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
  if (dev?.student_id && dev.student_id !== student.id) throw deviceBound();

  const flags = [];
  if (!dev?.student_id) {
    const since = ts - config.deviceWindowDays * 86_400_000;
    const others = (await get('SELECT COUNT(*) AS c FROM devices WHERE student_id = ? AND last_seen > ?', student.id, since)).c;
    if (others >= config.maxDevicesPerStudent) {
      throw new HttpError(403, `You already used ${others} different phones recently. Ask the admin to reset your devices.`, { code: 'TOO_MANY_DEVICES' });
    }
    if (others > 0) flags.push('new_device');
  }
  if (student.bus_id !== trip.bus_id) flags.push('wrong_bus');

  let results;
  try {
    results = await batch([
      // bind the phone to this student unless someone already owns it (COALESCE keeps the first owner)
      [`INSERT INTO devices(id, student_id, ua, bound_at, first_seen, last_seen) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET student_id = COALESCE(devices.student_id, excluded.student_id),
          bound_at = COALESCE(devices.bound_at, excluded.bound_at), last_seen = excluded.last_seen, ua = excluded.ua`,
      deviceId, student.id, ua, ts, ts, ts],
      // board only if the trip is still running and this phone belongs to this student
      [`INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, created_at)
        SELECT ?, ?, ?, ?, 'qr', ?, ?
         WHERE (SELECT status FROM trips WHERE id = ?) = 'active'
           AND (SELECT student_id FROM devices WHERE id = ?) = ?`,
      trip.id, student.id, deviceId, ip, flags.join(','), ts, trip.id, deviceId, student.id],
      ['UPDATE checkin_sessions SET consumed_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM checkins WHERE trip_id = ? AND student_id = ?)', ts, sessionId, trip.id, student.id],
    ]);
  } catch (e) { rethrowUnique(e); }
  if (!results[1].changes) {
    // a rule changed between our reads and the write; tell the student which one
    const [t2, d2] = await Promise.all([get('SELECT status FROM trips WHERE id = ?', trip.id), get('SELECT student_id FROM devices WHERE id = ?', deviceId)]);
    if (t2?.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });
    if (d2?.student_id !== student.id) throw deviceBound();
    throw new HttpError(409, 'Could not record the boarding. Scan the QR again.', { code: 'RETRY' });
  }
  const result = { id: results[1].lastInsertRowid, flags, at: ts };
  await emitCheckin(result.id);
  return result;
}

const deviceBound = () =>
  new HttpError(403, 'This phone is linked to a different student. Use your own phone, or ask the incharge to mark you manually.', { code: 'DEVICE_BOUND' });

/** Staff-marked boarding (phone dead, etc). Always flagged 'manual' and audited by the caller. */
export async function manualCheckin({ trip, student, byUser, note = '' }) {
  const ts = now();
  const existing = await get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id);
  if (existing) throw new HttpError(409, `${student.name} already boarded this trip`, { at: existing.created_at });
  const flags = ['manual'];
  if (student.bus_id !== trip.bus_id) flags.push('wrong_bus');
  let r;
  try {
    r = await run(
      `INSERT INTO checkins(trip_id, student_id, device_id, ip, method, flags, marked_by, note, created_at)
       SELECT ?, ?, NULL, NULL, 'manual', ?, ?, ?, ? WHERE (SELECT status FROM trips WHERE id = ?) = 'active'`,
      trip.id, student.id, flags.join(','), byUser.id, note.slice(0, 200), ts, trip.id,
    );
  } catch (e) {
    if (/UNIQUE/i.test(e?.message || '')) throw new HttpError(409, `${student.name} already boarded this trip`, { at: ts });
    throw e;
  }
  if (!r.changes) throw new HttpError(410, 'Trip is not running');
  const result = { id: r.lastInsertRowid, flags, at: ts };
  await emitCheckin(result.id);
  return result;
}

/** Two phones racing the same student/device hit a UNIQUE index; report it like the normal check. */
function rethrowUnique(e) {
  if (/UNIQUE/i.test(e?.message || '')) {
    if (/device_id/i.test(e.message)) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });
    throw new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY', at: Date.now() });
  }
  throw e;
}

export function loadCheckin(id) {
  return get(
    `SELECT c.id, c.trip_id, c.created_at, c.method, c.flags, c.note,
            s.id AS student_id, s.uuid, s.name, s.course, s.year, s.specialization, st.name AS stop,
            t.bus_id, t.incharge_id, t.direction, b.number AS bus_number, m.name AS marked_by_name
       FROM checkins c
       JOIN students s ON s.id = c.student_id
       JOIN trips t ON t.id = c.trip_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN stops st ON st.id = s.stop_id
       LEFT JOIN users m ON m.id = c.marked_by
      WHERE c.id = ?`,
    id,
  );
}

export async function emitCheckin(id) {
  const c = await loadCheckin(id);
  if (!c) return;
  const trip = { id: c.trip_id, bus_id: c.bus_id, incharge_id: c.incharge_id, direction: c.direction, bus_number: c.bus_number };
  const checkin = {
    id: c.id, trip_id: c.trip_id, created_at: c.created_at, method: c.method, flags: c.flags, note: c.note,
    student_id: c.student_id, uuid: c.uuid, name: c.name, course: c.course, year: c.year,
    specialization: c.specialization, stop: c.stop, marked_by_name: c.marked_by_name,
  };
  await broadcast('checkin', { checkin, trip, counts: await tripCounts(c.trip_id, c.bus_id) }, tripScope(trip));
}
