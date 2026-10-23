import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword, generatePassword } from './security.js';

export const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
`);

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export const run = (sql, ...params) => prep(sql).run(...norm(params));
export const get = (sql, ...params) => prep(sql).get(...norm(params));
export const all = (sql, ...params) => prep(sql).all(...norm(params));

/** Run fn inside an IMMEDIATE transaction (write lock acquired up-front). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export const now = () => Date.now();

// ------------------------------------------------------------------ schema
const MIGRATIONS = [
  `
  CREATE TABLE buses (
    id INTEGER PRIMARY KEY,
    number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    route TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE stops (
    id INTEGER PRIMARY KEY,
    bus_id INTEGER NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bus_id, name COLLATE NOCASE)
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','incharge')),
    password_hash TEXT NOT NULL,
    bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    course TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    specialization TEXT NOT NULL DEFAULT '',
    bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
    stop_id INTEGER REFERENCES stops(id) ON DELETE SET NULL,
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX students_bus ON students(bus_id);
  CREATE INDEX students_name ON students(name COLLATE NOCASE);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    ip TEXT, ua TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE trips (
    id INTEGER PRIMARY KEY,
    bus_id INTEGER NOT NULL REFERENCES buses(id),
    incharge_id INTEGER NOT NULL REFERENCES users(id),
    direction TEXT NOT NULL CHECK(direction IN ('to_college','from_college')),
    secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by INTEGER REFERENCES users(id),
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX trips_one_active_per_bus ON trips(bus_id) WHERE status = 'active';
  CREATE INDEX trips_started ON trips(started_at);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    ua TEXT,
    bound_at INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX devices_student ON devices(student_id);
  CREATE TABLE checkin_sessions (
    id TEXT PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    ip TEXT, ua TEXT,
    lookups INTEGER NOT NULL DEFAULT 0,
    student_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX checkin_sessions_exp ON checkin_sessions(expires_at);
  CREATE TABLE checkins (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    device_id TEXT,
    ip TEXT,
    method TEXT NOT NULL DEFAULT 'qr' CHECK(method IN ('qr','manual')),
    flags TEXT NOT NULL DEFAULT '',
    marked_by INTEGER REFERENCES users(id),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(trip_id, student_id)
  );
  CREATE UNIQUE INDEX checkins_one_device_per_trip ON checkins(trip_id, device_id) WHERE device_id IS NOT NULL;
  CREATE INDEX checkins_student ON checkins(student_id);
  CREATE INDEX checkins_created ON checkins(created_at);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '',
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_created ON audit_log(created_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = get('SELECT version FROM schema_version');
  let version = row ? row.version : 0;
  if (!row) run('INSERT INTO schema_version(version) VALUES (0)');
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(() => {
      db.exec(MIGRATIONS[i]);
      run('UPDATE schema_version SET version = ?', i + 1);
    });
    version = i + 1;
  }
  return version;
}

export const getSetting = (key, fallback = '') => get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
export const setSetting = (key, value) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

/** Create the first admin if no users exist. Writes the one-time password to data/initial-admin.txt. */
export function bootstrapAdmin() {
  const count = get('SELECT COUNT(*) AS c FROM users').c;
  if (count > 0) return null;
  const password = process.env.ADMIN_PASSWORD || generatePassword(16);
  const t = now();
  run(
    'INSERT INTO users(username,name,role,password_hash,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)',
    'admin', 'Administrator', 'admin', hashPassword(password), t, t,
  );
  const file = path.join(config.dataDir, 'initial-admin.txt');
  fs.writeFileSync(
    file,
    `UU Bus ERP first admin login\n\nusername: admin\npassword: ${password}\n\nYou must change this password on first login. Delete this file afterwards.\n`,
    { mode: 0o600 },
  );
  return { username: 'admin', password, file };
}

/** Housekeeping: drop expired sessions and stale check-in sessions. */
export function cleanup() {
  const t = now();
  run('DELETE FROM sessions WHERE expires_at < ?', t);
  run('DELETE FROM checkin_sessions WHERE expires_at < ?', t - 3_600_000);
}

export function closeDb() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
}
