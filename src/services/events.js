import { config } from '../config.js';
import { run, get, all, now } from '../db.js';

/*
 * Live events, two transports:
 *  - 'sse'  (single server): pushed instantly over one Server-Sent Events connection per screen.
 *  - 'poll' (serverless):    written to the events table; screens poll /api/events/poll every few
 *                            seconds. Works across any number of stateless function instances.
 * Visibility is the same in both: admins see everything, others only their bus / their trips.
 */
const clients = new Set();
let seq = 0;

export const tripScope = (trip) => ({ bus_id: trip.bus_id, incharge_id: trip.incharge_id });
const visible = (user, scope) =>
  !scope || user.role === 'admin' || user.role === 'operator' || user.id === scope.incharge_id || (user.bus_id != null && user.bus_id === scope.bus_id);

export function subscribe(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2500\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now(), role: user.role })}\n\n`);
  const client = { res, user };
  clients.add(client);
  const bye = () => clients.delete(client);
  req.on('close', bye);
  req.on('error', bye);
}

/** scope = { bus_id, incharge_id } limits who receives it; null = every signed-in screen. */
export async function broadcast(event, data, scope = null) {
  if (config.liveMode === 'poll') {
    await run(
      'INSERT INTO events(type,bus_id,incharge_id,payload,created_at) VALUES(?,?,?,?,?)',
      event, scope?.bus_id ?? null, scope?.incharge_id ?? null, JSON.stringify(data), now(),
    );
    return;
  }
  const payload = `event: ${event}\nid: ${++seq}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (!visible(c.user, scope)) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

/**
 * Events after `after` that this user may see. after = 0 just returns the current cursor.
 * The cursor always advances to the newest id read, so filtered-out events are never rescanned.
 */
export async function pollEvents(user, after) {
  const maxId = (await get('SELECT COALESCE(MAX(id), 0) AS id FROM events')).id;
  if (!after || after >= maxId) return { events: [], cursor: maxId };
  const LIMIT = 200;
  const rows = user.role === 'admin' || user.role === 'operator'
    ? await all('SELECT id, type, payload FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?', after, maxId, LIMIT)
    : await all(
      `SELECT id, type, payload FROM events
        WHERE id > ? AND id <= ? AND (bus_id IS NULL AND incharge_id IS NULL OR bus_id = ? OR incharge_id = ?)
        ORDER BY id LIMIT ?`,
      after, maxId, user.bus_id ?? -1, user.id, LIMIT,
    );
  const cursor = rows.length === LIMIT ? rows[rows.length - 1].id : maxId;
  return { events: rows.map((r) => ({ id: r.id, type: r.type, data: JSON.parse(r.payload) })), cursor };
}

export function closeAll() {
  for (const c of clients) { try { c.res.end(); } catch { /* ignore */ } }
  clients.clear();
}

export const clientCount = () => clients.size;

if (config.liveMode === 'sse') setInterval(() => { broadcast('ping', { t: Date.now() }).catch(() => {}); }, 25_000).unref();
