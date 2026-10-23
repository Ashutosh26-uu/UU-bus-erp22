/**
 * End-to-end security test. Run against a RUNNING server that has the demo data loaded:
 *   npm run seed:demo && npm start          (in one terminal)
 *   ADMIN_PW=<admin password> npm run test:security   (in another)
 * Optional: BASE=http://localhost:3000  INCHARGE_PW=Incharge12pass
 * Simulates different phones with separate cookie jars. Safe to re-run.
 */
import { tokenFor } from '../src/services/qr.js';
import { get } from '../src/db.js';

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_PW = process.env.ADMIN_PW;
const INCHARGE_PW = process.env.INCHARGE_PW || 'Incharge12pass';
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

const S = { aditi: ['UU2023CS0100', 'Aditi Sharma'], rahul: ['UU2023BB0101', 'Rahul Joshi'], priya: ['UU2023BC0102', 'Priya Kohli'], arjun: ['UU2023AG0103', 'Arjun Singh'], tanvi: ['UU2023AG0118', 'Tanvi Singh'] };

// ---------------------------------------------------------------- sign in + reset state
const admin = jar();
let r = await call(admin, 'POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
if (r.status !== 200) { console.error('admin login failed:', r.data); process.exit(2); }
ok(true, 'admin login');
const csrf = { 'X-CSRF-Token': r.data.csrf, Origin: BASE };

const state0 = await call(admin, 'GET', '/api/incharge/state');
for (const t of state0.data.activeTrips.filter((t) => t.bus_number === '12')) await call(admin, 'POST', `/api/incharge/trips/${t.id}/end`, {}, csrf);
const ids = {};
for (const [k, [uuid]] of Object.entries(S)) {
  const s = (await call(admin, 'GET', `/api/admin/students?q=${uuid}`)).data.items.find((x) => x.uuid === uuid);
  if (!s) { console.error(`Demo student ${uuid} missing. Run: npm run seed:demo`); process.exit(2); }
  ids[k] = s.id;
  await call(admin, 'POST', `/api/admin/students/${s.id}/devices/reset`, {}, csrf);
}
const users = (await call(admin, 'GET', '/api/admin/users')).data.items;
const stale = users.find((u) => u.username === 'locktest');
if (stale) await call(admin, 'DELETE', `/api/admin/users/${stale.id}`, undefined, csrf);
const bus12 = (await call(admin, 'GET', '/api/admin/buses')).data.buses.find((b) => b.number === '12');

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
const inch = jar();
r = await call(inch, 'POST', '/api/auth/login', { username: 'incharge12', password: INCHARGE_PW });
ok(r.status === 200 && r.data.user.role === 'incharge', 'incharge login');
const icsrf = { 'X-CSRF-Token': r.data?.csrf, Origin: BASE };
r = await call(inch, 'GET', '/api/admin/dashboard');
ok(r.status === 403, 'incharge cannot open admin API -> 403', r.status);
const otherBus = (await call(admin, 'GET', '/api/admin/buses')).data.buses.find((b) => b.number !== '12');
r = await call(inch, 'POST', '/api/incharge/trips', { bus_id: otherBus.id, direction: 'to_college' }, icsrf);
ok(r.status === 403, 'incharge cannot start a trip for another bus -> 403', r.status);

// ---------------------------------------------------------------- qr tokens
console.log('\n[qr token]');
r = await call(admin, 'POST', '/api/incharge/trips', { bus_id: bus12.id, direction: 'from_college' }, csrf);
let trip = r.data.trip;
ok(r.status === 201, 'start trip 1');
const freshToken = async () => (await call(admin, 'GET', `/api/incharge/trips/${trip.id}/qr`)).data.token;
let tok = await freshToken();
r = await call(jar(), 'POST', '/api/checkin/session', { token: tok.slice(0, -2) + 'zz' });
ok(r.status === 410 && r.data.code === 'QR_EXPIRED', 'tampered token -> 410', r.status);
const rawTrip = get('SELECT * FROM trips WHERE id = ?', trip.id);
r = await call(jar(), 'POST', '/api/checkin/session', { token: tokenFor(rawTrip, Date.now() - 120_000) });
ok(r.status === 410, 'token from 2 minutes ago -> 410 (screenshots defeated)', r.status);
r = await call(jar(), 'POST', '/api/checkin/session', { token: tokenFor(rawTrip, Date.now() + 60_000) });
ok(r.status === 410, 'token from the future -> 410', r.status);

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
r = await call(d1, 'POST', '/api/checkin/lookup', { uuid: S.aditi[0], name: 'Aditi' });
ok(r.status === 404, 'first name only -> no match');
r = await call(d1, 'POST', '/api/checkin/confirm');
ok(r.status === 400 && r.data.code === 'NO_STUDENT', 'confirm before lookup -> 400');
r = await call(d1, 'POST', '/api/checkin/lookup', { uuid: ' uu2023cs0100 ', name: '  aditi   SHARMA ' });
ok(r.status === 200 && r.data.student.name === 'Aditi Sharma' && r.data.student.stop === 'Rajpur Road', 'messy case/spacing matches; details come from DB');

// ---------------------------------------------------------------- anti-proxy
console.log('\n[anti-proxy]');
r = await call(d1, 'POST', '/api/checkin/confirm');
ok(r.status === 200 && r.data.ok && r.data.flags.length === 0, 'phone D1 boards Aditi');
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
ok(r.status === 200 && r.data.flags.includes('wrong_bus'), 'bus-7 student boards bus 12 -> allowed but flagged wrong_bus', JSON.stringify(r.data));
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

console.log('\n[headers]');
const h = await fetch(`${BASE}/login`);
ok(h.headers.get('content-security-policy')?.includes("script-src 'self'"), 'strict CSP present');
ok(h.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'clickjacking protection');
ok(!h.headers.get('x-powered-by'), 'no x-powered-by');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
