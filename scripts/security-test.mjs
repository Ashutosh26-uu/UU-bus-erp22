/**
 * End-to-end security test. Run against a RUNNING server that has the demo data loaded:
 *   npm run seed:demo && npm start          (in one terminal)
 *   ADMIN_PW=<admin password> npm run test:security   (in another)
 * Optional: BASE=http://localhost:3000
 * Simulates different phones with separate cookie jars and creates/removes its own temporary
 * incharge account. Uses bus 12 of the seeded fleet. Safe to re-run.
 */
import { tokenFor, dayTokenFor } from '../src/services/qr.js';
import { get } from '../src/db.js';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_PW = process.env.ADMIN_PW;
if (!ADMIN_PW) { console.error('Set ADMIN_PW=<admin password>'); process.exit(2); }

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  PASS ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };

function jar() {
  const c = {};
  return {
    headers() { const s = Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '); return s ? { Cookie: s } : {}; },
    absorb(res) {
      for (const h of res.headers.getSetCookie?.() || []) {
        const [kv] = h.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (/Max-Age=0/i.test(h)) delete c[k]; else c[k] = v;
      }
    },
  };
}
async function call(j, method, path, body, extra = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...j.headers(), ...extra }, body: body ? JSON.stringify(body) : undefined });
  j.absorb(res);
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- sign in + reset state
const admin = jar();
let r = await call(admin, 'POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
if (r.status !== 200) { console.error('admin login failed:', r.data); process.exit(2); }
ok(true, 'admin login');
const csrf = { 'X-CSRF-Token': r.data.csrf, Origin: BASE };
const LIVE = r.data.live;
console.log(`  (server live mode: ${LIVE})`);

const allBuses = (await call(admin, 'GET', '/api/admin/buses')).data.buses.filter((b) => b.active);
const bus12 = allBuses.find((b) => b.number === '12');
const otherBus = allBuses.find((b) => b.number !== '12');
if (!bus12 || !otherBus) { console.error('Need the seeded fleet. Run: npm run seed:demo'); process.exit(2); }
const state0 = await call(admin, 'GET', '/api/incharge/state');
for (const t of state0.data.activeTrips.filter((t) => t.bus_number === '12')) await call(admin, 'POST', `/api/incharge/trips/${t.id}/end`, {}, csrf);

// four students of bus 12 and one from another bus, as [uuid, name]; phones unlinked so the run is repeatable
const pick = async (busId, n) => (await call(admin, 'GET', `/api/admin/students?bus=${busId}&active=1&limit=${n}`)).data.items.slice(0, n);
const on12 = await pick(bus12.id, 4);
const onOther = await pick(otherBus.id, 1);
if (on12.length < 4 || onOther.length < 1) { console.error('Need at least 4 students on bus 12 and 1 on another bus. Run: npm run seed:demo'); process.exit(2); }
const S = { aditi: [on12[0].uuid, on12[0].name], rahul: [on12[1].uuid, on12[1].name], priya: [on12[2].uuid, on12[2].name], arjun: [on12[3].uuid, on12[3].name], tanvi: [onOther[0].uuid, onOther[0].name] };
const ids = { aditi: on12[0].id, rahul: on12[1].id, priya: on12[2].id, arjun: on12[3].id, tanvi: onOther[0].id };
for (const id of Object.values(ids)) await call(admin, 'POST', `/api/admin/students/${id}/devices/reset`, {}, csrf);
const users = (await call(admin, 'GET', '/api/admin/users')).data.items;
for (const u of users.filter((x) => ['locktest', 'testincharge12', 'testinchargex', 'testoperator'].includes(x.username))) await call(admin, 'DELETE', `/api/admin/users/${u.id}`, undefined, csrf);

console.log('\n[fleet]');
ok(allBuses.length >= 19, `fleet has 19 buses (found ${allBuses.length})`);
ok(allBuses.every((b) => b.stops.length > 0), 'every bus has stops');
ok(allBuses.filter((b) => b.incharges.length > 0).length >= 19, 'every bus has its own incharge account');
r = await call(admin, 'POST', '/api/admin/fleet', {}, csrf);
ok(r.status === 200 && r.data.fleetSize === 19 && r.data.buses === 0 && r.data.incharges.length === 0, 'fleet button is idempotent: nothing new on a complete fleet', JSON.stringify(r.data));
r = await call(admin, 'POST', '/api/admin/fleet', {});
ok(r.status === 403 && r.data.code === 'CSRF', 'fleet button needs the CSRF token', r.status);
const h12 = await fetch(`${BASE}/bus/12`, { headers: admin.headers(), redirect: 'manual' });
ok(h12.status === 200, 'admin can open /bus/12 portal page');
const h404 = await fetch(`${BASE}/bus/does-not-exist`, { headers: admin.headers(), redirect: 'manual' });
ok(h404.status === 404, 'unknown bus portal -> 404');
const anon = await fetch(`${BASE}/bus/12`, { redirect: 'manual' });
ok(anon.status === 302 && /\/login/.test(anon.headers.get('location') || ''), 'portal page without login redirects to /login');

// ---------------------------------------------------------------- auth & csrf
console.log('\n[auth & csrf]');
r = await call(jar(), 'GET', '/api/admin/dashboard');
ok(r.status === 401, 'admin API without session -> 401', r.status);
r = await call(admin, 'POST', '/api/admin/buses', { number: 'X', name: 'x' });
ok(r.status === 403 && r.data.code === 'CSRF', 'state change without CSRF header -> 403', r.status);
r = await call(admin, 'POST', '/api/admin/buses', { number: 'X', name: 'x' }, { ...csrf, Origin: 'http://evil.example' });
ok(r.status === 403 && r.data.code === 'ORIGIN', 'cross-origin POST -> 403', r.status);
r = await call(admin, 'POST', '/api/auth/login', { username: 'admin', password: "x' OR 1=1 --" });
ok(r.status === 401, 'injection-style password rejected');
// a throw-away bus admin for bus 12 (bus admins keep the password the super admin gives them)
r = await call(admin, 'POST', '/api/admin/users', { username: 'testincharge12', name: 'Test Incharge 12', role: 'incharge', bus_id: bus12.id, password: 'TempIncharge123' }, csrf);
const testInchargeId = r.data.id;
let inch = jar();
r = await call(inch, 'POST', '/api/auth/login', { username: 'testincharge12', password: 'TempIncharge123' });
ok(r.status === 200 && r.data.user.role === 'incharge' && r.data.user.home === '/bus/12' && !r.data.user.mustChangePassword && !r.data.user.canChangePassword, 'bus admin login lands on /bus/12 with no forced password change');
let icsrf = { 'X-CSRF-Token': r.data?.csrf, Origin: BASE };
r = await call(inch, 'POST', '/api/auth/change-password', { current: 'TempIncharge123', next: 'Incharge12fresh' }, icsrf);
ok(r.status === 403 && r.data.code === 'PASSWORD_BY_ADMIN_ONLY', 'bus admin cannot change their own password -> 403', r.status);
r = await call(admin, 'POST', `/api/admin/users/${testInchargeId}/password`, { password: 'Incharge12fresh' }, csrf);
ok(r.status === 200 && r.data.generated === false, 'super admin sets the bus admin password');
r = await call(inch, 'GET', '/api/incharge/state?bus=12');
ok(r.status === 401, 'setting a password signs the bus admin out everywhere', r.status);
r = await call(inch, 'POST', '/api/auth/login', { username: 'testincharge12', password: 'TempIncharge123' });
ok(r.status === 401, 'old bus admin password no longer works');
inch = jar();
r = await call(inch, 'POST', '/api/auth/login', { username: 'testincharge12', password: 'Incharge12fresh' });
ok(r.status === 200, 'bus admin signs in with the password the super admin set');
icsrf = { 'X-CSRF-Token': r.data?.csrf, Origin: BASE };
r = await call(admin, 'POST', `/api/admin/users/${(await call(admin, 'GET', '/api/admin/users')).data.items.find((x) => x.username === 'admin')?.id}/password`, {}, csrf);
ok(r.status === 400, 'super admin cannot reset their own password from the staff list', r.status);
r = await call(inch, 'GET', '/api/incharge/state?bus=12');
ok(r.status === 200 && r.data.scopedBus?.number === '12' && r.data.buses.length === 1, 'incharge sees only its own bus portal');
r = await call(inch, 'GET', `/api/incharge/state?bus=${encodeURIComponent(otherBus.number)}`);
ok(r.status === 403 && r.data.code === 'WRONG_BUS_PORTAL', 'incharge cannot open another bus portal -> 403', r.status);
r = await call(inch, 'GET', '/api/incharge/buses');
ok(r.status === 200 && r.data.buses.length === 1 && r.data.buses[0].number === '12', 'portal picker shows the incharge only its bus');
const bounce = await fetch(`${BASE}/bus/${encodeURIComponent(otherBus.number)}`, { headers: inch.headers(), redirect: 'manual' });
ok(bounce.status === 302 && bounce.headers.get('location') === '/bus/12', 'another bus portal page bounces the incharge to /bus/12');
r = await call(inch, 'POST', '/api/admin/fleet', {}, icsrf);
ok(r.status === 403, 'incharge cannot create the fleet -> 403', r.status);
r = await call(inch, 'GET', '/api/admin/dashboard');
ok(r.status === 403, 'incharge cannot open admin API -> 403', r.status);
r = await call(inch, 'POST', '/api/incharge/trips', { bus_id: otherBus.id, direction: 'to_college' }, icsrf);
ok(r.status === 403, 'incharge cannot start a trip for another bus -> 403', r.status);

// ---------------------------------------------------------------- qr tokens (rotating mode)
console.log('\n[qr token: rotating]');
const ORIGINAL_QR_MODE = (await call(admin, 'GET', '/api/admin/settings')).data.qrMode;
r = await call(admin, 'PUT', '/api/admin/settings', { qr_mode: 'rotating' }, csrf);
ok(r.status === 200 && r.data.qrMode === 'rotating', 'admin switches QR to rotating');
r = await call(inch, 'PUT', '/api/admin/settings', { qr_mode: 'day' }, icsrf);
ok(r.status === 403, 'incharge cannot change the QR mode -> 403', r.status);
r = await call(admin, 'POST', '/api/incharge/trips', { bus_id: bus12.id, direction: 'from_college' }, csrf);
let trip = r.data.trip;
ok(r.status === 201, 'start trip 1');
const freshToken = async () => (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data.token;
let tok = await freshToken();
r = await call(jar(), 'POST', '/api/checkin/session', { token: tok.slice(0, -2) + 'zz' });
ok(r.status === 410 && r.data.code === 'QR_EXPIRED', 'tampered token -> 410', r.status);
const qrInfo = (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data;
ok(/\/checkin\/12\?t=/.test(qrInfo.url), 'QR link carries the bus number (/checkin/12)', qrInfo.url);
r = await call(jar(), 'POST', '/api/checkin/session', { token: await freshToken(), bus: otherBus.number });
ok(r.status === 410, 'bus 12 token presented on another bus link -> 410', r.status);
r = await call(jar(), 'POST', '/api/checkin/session', { token: await freshToken(), bus: '12' });
ok(r.status === 200, 'bus 12 token on the bus 12 link -> ok', r.status);
const rawTrip = await get('SELECT * FROM trips WHERE id = ?', trip.id);
r = await call(jar(), 'POST', '/api/checkin/session', { token: tokenFor(rawTrip, Date.now() - 120_000) });
ok(r.status === 410, 'token from 2 minutes ago -> 410 (screenshots defeated)', r.status);
r = await call(jar(), 'POST', '/api/checkin/session', { token: tokenFor(rawTrip, Date.now() + 60_000) });
ok(r.status === 410, 'token from the future -> 410', r.status);

// ---------------------------------------------------------------- qr tokens (whole-day mode)
console.log('\n[qr token: whole day]');
r = await call(admin, 'PUT', '/api/admin/settings', { qr_mode: 'day' }, csrf);
ok(r.status === 200 && r.data.qrMode === 'day', 'admin switches QR to whole day');
let q = (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data;
ok(q.mode === 'day' && /\/checkin\/12\?t=d/.test(q.url) && q.validUntil > Date.now() + 1000, 'day QR is a per-bus code valid until midnight', JSON.stringify({ mode: q.mode, url: q.url }));
const dayTok = q.token;
r = await call(jar(), 'POST', '/api/checkin/session', { token: dayTok, bus: '12' });
ok(r.status === 200 && r.data.trip.id === trip.id, "today's QR opens the running trip");
const q2 = (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data;
ok(q2.token === dayTok, 'day QR stays the same between refreshes');
r = await call(jar(), 'POST', '/api/checkin/session', { token: await dayTokenFor(bus12.id, Date.now() - 86_400_000) });
ok(r.status === 410, "yesterday's QR -> 410", r.status);
r = await call(jar(), 'POST', '/api/checkin/session', { token: dayTok.slice(0, -2) + 'zz' });
ok(r.status === 410, 'tampered day QR -> 410', r.status);
r = await call(jar(), 'POST', '/api/checkin/session', { token: await dayTokenFor(otherBus.id) });
ok(r.status === 409 && r.data.code === 'NO_TRIP', 'day QR of a bus with no running trip -> NO_TRIP', r.status);
r = await call(admin, 'POST', `/api/incharge/trips/${trip.id}/new-qr`, {}, csrf);
ok(r.status === 200, 'New QR code');
r = await call(jar(), 'POST', '/api/checkin/session', { token: dayTok });
ok(r.status === 410, 'old day QR stops working after New QR code', r.status);
q = (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data;
r = await call(jar(), 'POST', '/api/checkin/session', { token: q.token });
ok(q.token !== dayTok && r.status === 200, 'the new day QR works');
r = await call(admin, 'PUT', '/api/admin/settings', { qr_mode: 'rotating' }, csrf);
r = await call(jar(), 'POST', '/api/checkin/session', { token: q.token });
ok(r.status === 410, 'switching back to rotating cancels day QRs', r.status);
await call(admin, 'PUT', '/api/admin/settings', { qr_mode: ORIGINAL_QR_MODE }, csrf);

const scan = async (j) => call(j, 'POST', '/api/checkin/session', { token: await freshToken() });
const board = async (j, [uuid, name]) => {
  await scan(j);
  const l = await call(j, 'POST', '/api/checkin/lookup', { uuid, name });
  if (l.status !== 200) return l;
  return call(j, 'POST', '/api/checkin/confirm');
};

// ---------------------------------------------------------------- identity
console.log('\n[identity]');
const d1 = jar();
r = await scan(d1);
ok(r.status === 200 && r.data.trip.bus_number === '12', 'live token -> session');
r = await call(d1, 'POST', '/api/checkin/lookup', { uuid: S.aditi[0], name: 'Someone Else' });
ok(r.status === 404 && r.data.code === 'NO_MATCH', 'right ID + wrong name -> no match', r.status);
r = await call(d1, 'POST', '/api/checkin/lookup', { uuid: S.aditi[0], name: S.aditi[1].split(' ')[0] });
ok(r.status === 404, 'first name only -> no match');
r = await call(d1, 'POST', '/api/checkin/confirm');
ok(r.status === 400 && r.data.code === 'NO_STUDENT', 'confirm before lookup -> 400');
r = await call(d1, 'POST', '/api/checkin/lookup', { uuid: ` ${S.aditi[0].toLowerCase()} `, name: `  ${S.aditi[1].toUpperCase().replace(' ', '   ')} ` });
ok(r.status === 200 && r.data.student.uuid === S.aditi[0] && r.data.student.name === S.aditi[1] && r.data.student.stop, 'messy case/spacing matches; details come from DB');

// ---------------------------------------------------------------- anti-proxy (+ live events)
console.log('\n[anti-proxy & live events]');
// an incharge of another bus, to prove they do not receive bus 12's events
r = await call(admin, 'POST', '/api/admin/users', { username: 'testinchargex', name: 'Test Incharge X', role: 'incharge', bus_id: otherBus.id, password: 'TempInchargeX1' }, csrf);
const otherInchargeId = r.data.id;
const inchX = jar();
r = await call(inchX, 'POST', '/api/auth/login', { username: 'testinchargex', password: 'TempInchargeX1' });
const cursorOf = async (j) => (await call(j, 'GET', '/api/events/poll?after=0')).data?.cursor; // what browsers send first
r = await call(admin, 'GET', '/api/events/poll?after=0');
ok(r.status === 200 && Number.isInteger(r.data.cursor), 'poll: first request (after=0) returns a cursor', r.status);
r = await call(admin, 'GET', '/api/events/poll?after=abc');
ok(r.status === 400, 'poll: garbage cursor rejected', r.status);
const [cA, cI, cX] = [await cursorOf(admin), await cursorOf(inch), await cursorOf(inchX)];
r = await call(d1, 'POST', '/api/checkin/confirm');
ok(r.status === 200 && r.data.ok && r.data.flags.length === 0, 'phone D1 boards Aditi');
if (LIVE === 'poll') {
  const seen = async (j, c) => (await call(j, 'GET', `/api/events/poll?after=${c}`)).data.events.filter((e) => e.type === 'checkin').map((e) => e.data.checkin.uuid);
  ok((await seen(admin, cA)).includes(S.aditi[0]), 'poll: admin receives the boarding event');
  ok((await seen(inch, cI)).includes(S.aditi[0]), 'poll: bus 12 incharge receives the boarding event');
  ok(!(await seen(inchX, cX)).includes(S.aditi[0]), "poll: another bus's incharge does not receive it");
  const again = await call(admin, 'GET', `/api/events/poll?after=${(await call(admin, 'GET', `/api/events/poll?after=${cA}`)).data.cursor}`);
  ok(again.status === 200 && again.data.events.length === 0, 'poll: cursor advances, no duplicates');
} else {
  r = await call(admin, 'GET', '/api/events/poll');
  ok(r.status === 200 && typeof r.data.cursor === 'number', 'poll endpoint answers in SSE mode too');
}
await call(admin, 'DELETE', `/api/admin/users/${otherInchargeId}`, undefined, csrf);
r = await call(d1, 'POST', '/api/checkin/confirm');
ok(r.status === 409 && r.data.code === 'ALREADY', 'pressing Done twice -> already boarded');
r = await board(d1, S.rahul);
ok(r.status === 403 && r.data.code === 'DEVICE_USED', 'phone D1 tries a second student on same trip -> blocked', r.status);
const d2 = jar();
r = await board(d2, S.aditi);
ok(r.status === 409 && r.data.code === 'ALREADY', 'phone D2 tries Aditi again -> already boarded');
r = await board(d2, S.priya);
ok(r.status === 200 && r.data.flags.length === 0, 'phone D2 boards Priya, no flags');
r = await board(jar(), S.tanvi);
ok(r.status === 404 && r.data.code === 'NO_MATCH' && /Invalid/.test(r.data.error), 'student of another bus scanning bus 12 -> invalid', JSON.stringify(r.data));
r = await call(admin, 'POST', `/api/incharge/trips/${trip.id}/manual`, { uuid: S.tanvi[0] }, csrf);
ok(r.status === 409 && r.data.code === 'NOT_ON_BUS', 'manual check-in of another bus student -> refused', r.status);
r = await call(inch, 'GET', `/api/incharge/students/search?q=${encodeURIComponent(S.tanvi[1].split(' ')[0])}&bus=${otherBus.id}`);
ok(r.status === 200 && r.data.items.every((s) => s.bus_number === '12'), 'bus admin search only ever returns students of their own bus');
r = await call(admin, 'POST', `/api/incharge/trips/${trip.id}/end`, {}, csrf);
ok(r.status === 200, 'end trip 1');
r = await call(d1, 'POST', '/api/checkin/lookup', S.aditi.length ? { uuid: S.aditi[0], name: S.aditi[1] } : {});
ok(r.status === 410, 'pending check-in session dies when trip ends');
r = await call(admin, 'POST', '/api/incharge/trips', { bus_id: bus12.id, direction: 'to_college' }, csrf);
trip = r.data.trip;
ok(r.status === 201, 'start trip 2');
r = await board(d1, S.priya);
ok(r.status === 403 && r.data.code === 'DEVICE_BOUND', "D1 (Aditi's phone) tries Priya on a new trip -> blocked", r.status);
r = await board(d1, S.aditi);
ok(r.status === 200 && r.data.flags.length === 0, 'D1 boards Aditi again on the new trip');
r = await board(jar(), S.priya);
ok(r.status === 200 && r.data.flags.includes('new_device'), 'Priya on a 2nd phone -> allowed but flagged new_device', JSON.stringify(r.data));
await call(admin, 'POST', `/api/incharge/trips/${trip.id}/end`, {}, csrf);
r = await call(admin, 'POST', '/api/incharge/trips', { bus_id: bus12.id, direction: 'from_college' }, csrf);
trip = r.data.trip;
r = await board(jar(), S.priya);
ok(r.status === 403 && r.data.code === 'TOO_MANY_DEVICES', 'Priya on a 3rd phone -> blocked until admin reset', r.status);
r = await call(admin, 'POST', `/api/admin/students/${ids.priya}/devices/reset`, {}, csrf);
ok(r.status === 200 && r.data.unlinked === 2, 'admin resets Priya devices');
r = await board(jar(), S.priya);
ok(r.status === 200, 'Priya boards after reset');

// ---------------------------------------------------------------- brute force
console.log('\n[brute force limits]');
const d6 = jar();
await scan(d6);
let last;
for (let i = 0; i < 7; i++) last = await call(d6, 'POST', '/api/checkin/lookup', { uuid: `UU2023CS0${100 + i}`, name: 'Guess Guess' });
ok(last.status === 429 && last.data.code === 'LOOKUPS_EXHAUSTED', 'ID guessing stops after 6 tries per scan', last.status);
r = await call(admin, 'POST', '/api/admin/users', { username: 'locktest', name: 'Lock Test', role: 'incharge', password: 'LockTest12345' }, csrf);
const lockId = r.data.id;
for (let i = 0; i < 5; i++) await call(jar(), 'POST', '/api/auth/login', { username: 'locktest', password: 'wrong-pass-1' });
r = await call(jar(), 'POST', '/api/auth/login', { username: 'locktest', password: 'LockTest12345' });
// 423 = per-account lockout; 429 = the per-network login limiter got there first (repeated runs). Both block.
ok(r.status === 423 || r.status === 429, `account locks after 5 bad passwords, even with the right one next${r.status === 429 ? ' (network limiter hit first)' : ''}`, r.status);
await call(admin, 'DELETE', `/api/admin/users/${lockId}`, undefined, csrf);

// ---------------------------------------------------------------- manual, data, headers
console.log('\n[manual check-in & data]');
r = await call(admin, 'POST', `/api/incharge/trips/${trip.id}/manual`, { uuid: S.arjun[0], note: 'phone dead' }, csrf);
ok(r.status === 201 && r.data.flags.includes('manual'), 'manual check-in flagged manual');
r = await call(admin, 'GET', `/api/admin/trips/${trip.id}`);
ok(r.status === 200 && r.data.counts.boarded === 2 && r.data.checkins.some((c) => c.method === 'manual'), 'trip summary counts 2 boarded (Priya + manual)', JSON.stringify(r.data.counts));
const res = await fetch(`${BASE}/api/admin/trips/${trip.id}/export.csv`, { headers: admin.headers() });
const csv = await res.text();
ok(res.status === 200 && csv.startsWith('uuid,name') && csv.includes(S.priya[0]) && csv.includes('phone dead'), 'CSV export');
r = await call(admin, 'POST', '/api/admin/students/import', { csv: 'uuid,name,course,year,bus,stop\nTEST001,Import Test,BCA,1st,99,New Stop' }, csrf);
ok(r.status === 200 && r.data.inserted + r.data.updated === 1, 'CSV import', JSON.stringify(r.data));
const imported = (await call(admin, 'GET', '/api/admin/students?q=TEST001')).data.items[0];
ok(imported && imported.bus_number === '99' && imported.stop_name === 'New Stop', 'imported student linked to bus/stop');
await call(admin, 'DELETE', `/api/admin/students/${imported.id}`, undefined, csrf);
const b99 = (await call(admin, 'GET', '/api/admin/buses')).data.buses.find((b) => b.number === '99');
if (b99) await call(admin, 'DELETE', `/api/admin/buses/${b99.id}`, undefined, csrf);
r = await call(admin, 'GET', '/api/admin/audit');
ok(r.status === 200 && r.data.items.some((a) => a.action === 'checkin.manual') && r.data.items.some((a) => a.action === 'login.failed'), 'audit log records manual check-in and failed logins');
r = await call(admin, 'POST', `/api/incharge/trips/${trip.id}/end`, {}, csrf);
ok(r.status === 200, 'end trip 3');
console.log('\n[operations admin: view only]');
r = await call(admin, 'POST', '/api/admin/users', { username: 'testoperator', name: 'Test Operator', role: 'operator', password: 'OperatorPass123' }, csrf);
ok(r.status === 201, 'super admin creates an operations admin', JSON.stringify(r.data));
const testOperatorId = r.data.id;
const op = jar();
r = await call(op, 'POST', '/api/auth/login', { username: 'testoperator', password: 'OperatorPass123' });
ok(r.status === 200 && r.data.user.role === 'operator' && r.data.user.readOnly && r.data.user.home === '/admin' && !r.data.user.mustChangePassword, 'operations admin signs in to the console, read-only');
const ocsrf = { 'X-CSRF-Token': r.data?.csrf, Origin: BASE };
for (const p of ['/api/admin/dashboard', '/api/admin/students', '/api/admin/buses', '/api/admin/trips', `/api/admin/trips/${trip.id}`, '/api/admin/flags', '/api/incharge/buses', `/api/incharge/state?bus=${encodeURIComponent(otherBus.number)}`, `/api/incharge/trips/${trip.id}`]) {
  r = await call(op, 'GET', p);
  ok(r.status === 200, `operations admin can view ${p.split('?')[0]}`, r.status);
}
for (const p of ['/api/admin/users', '/api/admin/audit', '/api/admin/settings', '/api/admin/students/export.csv', `/api/incharge/trips/${trip.id}/qr`]) {
  r = await call(op, 'GET', p);
  ok(r.status === 403, `operations admin cannot open ${p}`, r.status);
}
const writes = [
  ['POST', '/api/admin/fleet', {}], ['POST', '/api/admin/demo-students', {}], ['PUT', '/api/admin/settings', { qr_mode: 'rotating' }],
  ['POST', '/api/admin/students', { uuid: 'X1', name: 'Xx Yy' }], ['POST', '/api/incharge/trips', { bus_id: otherBus.id, direction: 'to_college' }],
  ['POST', `/api/incharge/trips/${trip.id}/end`, {}], ['POST', `/api/incharge/trips/${trip.id}/manual`, { uuid: S.rahul[0] }],
  ['POST', `/api/incharge/trips/${trip.id}/new-qr`, {}], ['POST', '/api/auth/change-password', { current: 'OperatorPass123', next: 'OperatorPass456' }],
];
for (const [m, p, body] of writes) {
  r = await call(op, m, p, body, ocsrf);
  ok(r.status === 403, `operations admin cannot ${m} ${p}`, r.status);
}
r = await call(op, 'GET', '/api/events/poll?after=0');
ok(r.status === 200 && Number.isInteger(r.data.cursor), 'operations admin receives live updates');
const opPage = await fetch(`${BASE}/bus/${encodeURIComponent(otherBus.number)}`, { headers: op.headers(), redirect: 'manual' });
ok(opPage.status === 200, 'operations admin can open any bus portal page to watch it', opPage.status);
await call(admin, 'DELETE', `/api/admin/users/${testOperatorId}`, undefined, csrf);

console.log('\n[demo students]');
r = await call(inch, 'POST', '/api/admin/demo-students', { perBus: 2 }, icsrf);
ok(r.status === 403, 'incharge cannot add demo students -> 403', r.status);
r = await call(admin, 'POST', '/api/admin/demo-students', { perBus: 2 }, csrf);
ok(r.status === 200 && r.data.inserted === r.data.buses * 2, 'admin adds 2 demo students per bus', JSON.stringify(r.data));
r = await call(admin, 'POST', '/api/admin/demo-students', { perBus: 2 }, csrf);
ok(r.status === 200 && r.data.inserted === 0, 'adding demo students again is idempotent');
r = await call(admin, 'GET', '/api/admin/students?q=DEMO-12-1');
ok(r.data.items.some((s) => s.uuid === 'DEMO-12-1' && s.bus_number === '12' && s.stop_name), 'demo student DEMO-12-1 is on bus 12 with a stop');
r = await call(admin, 'DELETE', '/api/admin/demo-students', undefined, csrf);
ok(r.status === 200 && r.data.removed >= 2, 'remove demo deletes them', JSON.stringify(r.data));
r = await call(admin, 'GET', '/api/admin/students?q=DEMO-');
ok(r.data.total === 0, 'no demo students left; real students untouched');

await call(admin, 'DELETE', `/api/admin/users/${testInchargeId}`, undefined, csrf);

console.log('\n[headers]');
const h = await fetch(`${BASE}/login`);
ok(h.headers.get('content-security-policy')?.includes("script-src 'self'"), 'strict CSP present');
ok(h.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'clickjacking protection');
ok(!h.headers.get('x-powered-by'), 'no x-powered-by');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
