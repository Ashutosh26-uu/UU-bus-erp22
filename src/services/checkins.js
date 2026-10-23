import { get, run, now, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { nameMatches, normUuid } from '../security.js';
import { broadcast, tripVisibleTo } from './events.js';
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
export function lookupStudent(uuid, name) {
  const s = studentByUuid(uuid);
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
 */
export function confirmCheckin({ sessionId, trip, student, deviceId, ip, ua }) {
  const result = tx(() => {
    const t = now();
    const live = get('SELECT status FROM trips WHERE id = ?', trip.id);
    if (!live || live.status !== 'active') throw new HttpError(410, 'This trip has ended. Ask the bus incharge.', { code: 'TRIP_ENDED' });

    const existing = get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id);
    if (existing) throw new HttpError(409, 'You have already boarded this trip.', { code: 'ALREADY', at: existing.created_at });

    const devUsed = get('SELECT student_id FROM checkins WHERE trip_id = ? AND device_id = ?', trip.id, deviceId);
    if (devUsed) throw new HttpError(403, 'This phone was already used to board this trip. One phone, one student.', { code: 'DEVICE_USED' });

    const flags = [];
    const dev = get('SELECT * FROM devices WHERE id = ?', deviceId);
    if (dev?.student_id && dev.student_id !== student.id) {
      throw new HttpError(403, 'This phone is linked to a different student. Use your own phone, or ask the incharge to mark you manually.', { code: 'DEVICE_BOUND' });
    }
    if (!dev?.student_id) {
      const since = t - config.deviceWindowDays * 86_400_000;
      const others = get('SELECT COUNT(*) AS c FROM devices WHERE student_id = ? AND last_seen > ?', student.id, since).c;
      if (others >= config.maxDevicesPerStudent) {
        throw new HttpError(403, `You already used ${others} different phones recently. Ask the admin to reset your devices.`, { code: 'TOO_MANY_DEVICES' });
      }
      if (others > 0) flags.push('new_device');
      if (dev) run('UPDATE devices SET student_id = ?, bound_at = ?, last_seen = ?, ua = ? WHERE id = ?', student.id, t, t, ua, deviceId);
      else run('INSERT INTO devices(id,student_id,ua,bound_at,first_seen,last_seen) VALUES(?,?,?,?,?,?)', deviceId, student.id, ua, t, t, t);
    } else {
      run('UPDATE devices SET last_seen = ?, ua = ? WHERE id = ?', t, ua, deviceId);
    }
    if (student.bus_id !== trip.bus_id) flags.push('wrong_bus');

    const r = run(
      'INSERT INTO checkins(trip_id,student_id,device_id,ip,method,flags,created_at) VALUES(?,?,?,?,?,?,?)',
      trip.id, student.id, deviceId, ip, 'qr', flags.join(','), t,
    );
    run('UPDATE checkin_sessions SET consumed_at = ? WHERE id = ?', t, sessionId);
    return { id: r.lastInsertRowid, flags, at: t };
  });
  emitCheckin(result.id);
  return result;
}

/** Staff-marked boarding (phone dead, etc). Always flagged 'manual' and audited by the caller. */
export function manualCheckin({ trip, student, byUser, note = '' }) {
  const result = tx(() => {
    const t = now();
    const live = get('SELECT status FROM trips WHERE id = ?', trip.id);
    if (!live || live.status !== 'active') throw new HttpError(410, 'Trip is not running');
    const existing = get('SELECT created_at FROM checkins WHERE trip_id = ? AND student_id = ?', trip.id, student.id);
    if (existing) throw new HttpError(409, `${student.name} already boarded this trip`, { at: existing.created_at });
    const flags = ['manual'];
    if (student.bus_id !== trip.bus_id) flags.push('wrong_bus');
    const r = run(
      'INSERT INTO checkins(trip_id,student_id,device_id,ip,method,flags,marked_by,note,created_at) VALUES(?,?,NULL,NULL,?,?,?,?,?)',
      trip.id, student.id, 'manual', flags.join(','), byUser.id, note.slice(0, 200), t,
    );
    return { id: r.lastInsertRowid, flags, at: t };
  });
  emitCheckin(result.id);
  return result;
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

export function emitCheckin(id) {
  const c = loadCheckin(id);
  if (!c) return;
  const trip = { id: c.trip_id, bus_id: c.bus_id, incharge_id: c.incharge_id, direction: c.direction, bus_number: c.bus_number };
  const checkin = {
    id: c.id, trip_id: c.trip_id, created_at: c.created_at, method: c.method, flags: c.flags, note: c.note,
    student_id: c.student_id, uuid: c.uuid, name: c.name, course: c.course, year: c.year,
    specialization: c.specialization, stop: c.stop, marked_by_name: c.marked_by_name,
  };
  broadcast('checkin', { checkin, trip, counts: tripCounts(c.trip_id, c.bus_id) }, tripVisibleTo(trip));
}
