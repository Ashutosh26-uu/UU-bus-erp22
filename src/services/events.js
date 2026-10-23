/**
 * Server-Sent Events hub. Admins see everything; incharges only their own bus/trips.
 * Browsers reconnect automatically, so a dropped connection never loses the live view for long.
 */
const clients = new Set();
let seq = 0;

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

/** visibleTo(user) decides who receives the event; omit to send to everyone signed in. */
export function broadcast(event, data, visibleTo) {
  const payload = `event: ${event}\nid: ${++seq}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (visibleTo && !visibleTo(c.user)) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

export const tripVisibleTo = (trip) => (user) =>
  user.role === 'admin' || user.id === trip.incharge_id || (user.bus_id != null && user.bus_id === trip.bus_id);

export function closeAll() {
  for (const c of clients) { try { c.res.end(); } catch { /* ignore */ } }
  clients.clear();
}

export const clientCount = () => clients.size;

setInterval(() => broadcast('ping', { t: Date.now() }), 25_000).unref();
