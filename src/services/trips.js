import { all, get, run, now } from '../db.js';
import { randomId } from '../security.js';
import { HttpError } from '../http.js';
import { broadcast, tripScope } from './events.js';

const TRIP_COLS = `t.id, t.bus_id, t.incharge_id, t.direction, t.status, t.started_at, t.ended_at, t.note,
  b.number AS bus_number, b.name AS bus_name, b.route AS bus_route, u.name AS incharge_name`;
const TRIP_FROM = 'FROM trips t JOIN buses b ON b.id = t.bus_id JOIN users u ON u.id = t.incharge_id';
const COUNT_COLS = `(SELECT COUNT(*) FROM checkins c WHERE c.trip_id = t.id) AS boarded,
       (SELECT COUNT(*) FROM checkins c WHERE c.trip_id = t.id AND c.flags <> '') AS flagged,
       (SELECT COUNT(*) FROM students s WHERE s.bus_id = t.bus_id AND s.active = 1) AS expected`;

export const getTrip = (id) => get(`SELECT ${TRIP_COLS} ${TRIP_FROM} WHERE t.id = ?`, id);
export const getTripRaw = (id) => get('SELECT * FROM trips WHERE id = ?', id);

export async function tripCounts(tripId, busId) {
  const [boarded, flagged, expected] = await Promise.all([
    get('SELECT COUNT(*) AS c FROM checkins WHERE trip_id = ?', tripId),
    get("SELECT COUNT(*) AS c FROM checkins WHERE trip_id = ? AND flags <> ''", tripId),
    get('SELECT COUNT(*) AS c FROM students WHERE bus_id = ? AND active = 1', busId),
  ]);
  return { boarded: boarded.c, flagged: flagged.c, expected: expected.c };
}

export const withCounts = async (trip) => ({ ...trip, counts: await tripCounts(trip.id, trip.bus_id) });

export async function tripSummary(id, { lists = true } = {}) {
  const trip = await getTrip(id);
  if (!trip) return null;
  if (!lists) return { trip, counts: await tripCounts(trip.id, trip.bus_id) };
  const [counts, checkins, notBoarded] = await Promise.all([
    tripCounts(trip.id, trip.bus_id),
    all(
      `SELECT c.id, c.created_at, c.method, c.flags, c.note, c.ip,
              s.id AS student_id, s.uuid, s.name, s.course, s.year, s.specialization, s.bus_id AS student_bus_id,
              st.name AS stop, m.name AS marked_by_name
         FROM checkins c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN stops st ON st.id = s.stop_id
         LEFT JOIN users m ON m.id = c.marked_by
        WHERE c.trip_id = ?
        ORDER BY c.created_at DESC`,
      id,
    ),
    all(
      `SELECT s.id, s.uuid, s.name, s.course, s.year, st.name AS stop
         FROM students s LEFT JOIN stops st ON st.id = s.stop_id
        WHERE s.bus_id = ? AND s.active = 1
          AND s.id NOT IN (SELECT student_id FROM checkins WHERE trip_id = ?)
        ORDER BY COALESCE(st.seq, 999), s.name COLLATE NOCASE`,
      trip.bus_id, id,
    ),
  ]);
  return { trip, counts, checkins, notBoarded };
}

export function listTrips({ start, end, busId, status, limit = 100 }) {
  const where = ['t.started_at >= ?', 't.started_at < ?'];
  const params = [start, end];
  if (busId) { where.push('t.bus_id = ?'); params.push(busId); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  params.push(limit);
  return all(`SELECT ${TRIP_COLS}, ${COUNT_COLS} ${TRIP_FROM} WHERE ${where.join(' AND ')} ORDER BY t.started_at DESC LIMIT ?`, ...params);
}

export const activeTrips = () => all(`SELECT ${TRIP_COLS}, ${COUNT_COLS} ${TRIP_FROM} WHERE t.status = 'active' ORDER BY t.started_at DESC`);

export async function startTrip({ busId, inchargeId, direction }) {
  const bus = await get('SELECT * FROM buses WHERE id = ? AND active = 1', busId);
  if (!bus) throw new HttpError(404, 'Bus not found or inactive');
  const active = await get('SELECT id FROM trips WHERE bus_id = ? AND status = ?', busId, 'active');
  if (active) throw new HttpError(409, `Bus ${bus.number} already has a running trip`, { tripId: active.id });
  let id;
  try {
    id = (await run(
      'INSERT INTO trips(bus_id,incharge_id,direction,secret,status,started_at) VALUES(?,?,?,?,?,?)',
      busId, inchargeId, direction, randomId(32), 'active', now(),
    )).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, `Bus ${bus.number} already has a running trip`);
    throw e;
  }
  const trip = await withCounts(await getTrip(id));
  await broadcast('trip', { type: 'started', trip }, tripScope(trip));
  return trip;
}

export async function endTrip(id, byUserId) {
  const t = now();
  const r = await run('UPDATE trips SET status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND status = ?', 'ended', t, byUserId, id, 'active');
  if (!r.changes) throw new HttpError(409, 'Trip is not running');
  await run('UPDATE checkin_sessions SET expires_at = ? WHERE trip_id = ? AND consumed_at IS NULL', t, id);
  const trip = await withCounts(await getTrip(id));
  await broadcast('trip', { type: 'ended', trip }, tripScope(trip));
  return trip;
}

/**
 * Can this user see this trip? Operations admins see every trip; their write attempts are refused
 * earlier by the read-only guard on the routes.
 */
export const canAccessTrip = (user, trip) =>
  user.role === 'admin' || user.role === 'operator' || trip.incharge_id === user.id || (user.bus_id != null && user.bus_id === trip.bus_id);
