import fs from 'node:fs';
import { createClient as createWebClient } from '@libsql/client/web';
import { config, credentialsFile } from './config.js';
import { hashPassword, generatePassword, passwordProblem } from './security.js';

/*
 * One async database API, two drivers:
 *   - local:  node:sqlite file in data/ (single server, zero setup)
 *   - libsql: Turso / libSQL over HTTPS (serverless, e.g. Vercel). Same SQL dialect as SQLite.
 * Writes that must succeed or fail together go through batch(): one atomic round trip, so the
 * database write lock is held for milliseconds even over the network (no interactive transactions).
 */

const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
/** batch item: 'SQL' or ['SQL', ...params] */
const stmtOf = (item) => (typeof item === 'string' ? { sql: item, args: [] } : { sql: item[0], args: norm(item.slice(1)) });

// ------------------------------------------------------------------ node:sqlite driver
async function nodeDriver(file) {
  const spec = 'node:sqlite';
  const { DatabaseSync } = await import(spec);
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const runOne = (sql, args) => { const r = prep(sql).run(...args); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; };
  // node:sqlite is synchronous: every call (and every batch) completes before any other request runs.
  return {
    kind: 'sqlite',
    run: async (sql, p) => runOne(sql, norm(p)),
    get: async (sql, p) => prep(sql).get(...norm(p)),
    all: async (sql, p) => prep(sql).all(...norm(p)),
    exec: async (sql) => db.exec(sql),
    batch: async (items) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = items.map((it) => { const s = stmtOf(it); return runOne(s.sql, s.args); });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    },
    close: async () => {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

// ------------------------------------------------------------------ libSQL / Turso driver
async function libsqlDriver(url, authToken) {
  let createClient = createWebClient;
  if (url.startsWith('file:')) {
    // local libSQL file (testing only); the native client is never bundled for serverless
    const spec = '@libsql/client';
    ({ createClient } = await import(spec));
  }
  const client = createClient({ url, authToken: authToken || undefined, intMode: 'number' });
  const rowsOf = (rs) => rs.rows.map((r) => {
    const o = {};
    rs.columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
  const resOf = (rs) => ({ changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) });
  const exe = (sql, p) => client.execute({ sql, args: norm(p) });
  return {
    kind: 'libsql',
    run: async (sql, p) => resOf(await exe(sql, p)),
    get: async (sql, p) => rowsOf(await exe(sql, p))[0],
    all: async (sql, p) => rowsOf(await exe(sql, p)),
    exec: (sql) => client.executeMultiple(sql),
    batch: async (items) => (await client.batch(items.map(stmtOf), 'write')).map(resOf),
    close: async () => { try { client.close(); } catch { /* ignore */ } },
  };
}

let driverPromise = null;
function driver() {
  if (!driverPromise) {
    driverPromise = (config.dbUrl ? libsqlDriver(config.dbUrl, config.dbAuthToken) : nodeDriver(config.dbPath))
      .catch((e) => { driverPromise = null; throw e; });
  }
  return driverPromise;
}

export const dbKind = () => (config.dbUrl ? (config.dbUrl.startsWith('file:') ? 'libsql-file' : 'turso') : 'sqlite');
export const run = async (sql, ...params) => (await driver()).run(sql, params);
export const get = async (sql, ...params) => (await driver()).get(sql, params);
export const all = async (sql, ...params) => (await driver()).all(sql, params);
/** Atomic list of writes in one round trip: all succeed or none. Items: 'SQL' or ['SQL', ...params]. */
export const batch = async (items) => (items.length ? (await driver()).batch(items) : []);
/** Big write lists in atomic chunks (keeps each request to the hosted database small). */
export async function batchChunks(items, size = 400) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await batch(items.slice(i, i + size))));
  return out;
}
export const execRaw = async (sql) => (await driver()).exec(sql);
export const now = () => Date.now();

// ------------------------------------------------------------------ schema
// Every statement is idempotent (IF NOT EXISTS) so concurrent serverless cold starts cannot collide.
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS buses (
    id INTEGER PRIMARY KEY,
    number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    route TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stops (
    id INTEGER PRIMARY KEY,
    bus_id INTEGER NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(bus_id, name COLLATE NOCASE)
  );
  CREATE TABLE IF NOT EXISTS users (
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
  CREATE TABLE IF NOT EXISTS students (
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
  CREATE INDEX IF NOT EXISTS students_bus ON students(bus_id);
  CREATE INDEX IF NOT EXISTS students_name ON students(name COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    ip TEXT, ua TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS trips (
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
  CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_per_bus ON trips(bus_id) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS trips_started ON trips(started_at);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    ua TEXT,
    bound_at INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS devices_student ON devices(student_id);
  CREATE TABLE IF NOT EXISTS checkin_sessions (
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
  CREATE INDEX IF NOT EXISTS checkin_sessions_exp ON checkin_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS checkins (
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
  CREATE UNIQUE INDEX IF NOT EXISTS checkins_one_device_per_trip ON checkins(trip_id, device_id) WHERE device_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS checkins_student ON checkins(student_id);
  CREATE INDEX IF NOT EXISTS checkins_created ON checkins(created_at);
  CREATE TABLE IF NOT EXISTS audit_log (
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
  CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v2: shared live-event log (serverless polling) and shared rate-limit counters
  `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    bus_id INTEGER,
    incharge_id INTEGER,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  );
  `,
  // v3: new 'operator' role (operations admin, read-only). SQLite cannot alter a CHECK constraint,
  // so the users table is rebuilt with every row, id and session intact. Bus admins and operators
  // can no longer change their own password, so their "must change" flag is cleared.
  // Runs as one script with its own transaction (foreign keys paused so the swap cannot cascade).
  {
    version: 3,
    script: `
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS users_v3 (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','operator','incharge')),
        password_hash TEXT NOT NULL,
        bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users_v3 (id, username, name, role, password_hash, bus_id, active, must_change_password, failed_logins, locked_until, created_at, updated_at)
        SELECT id, username, name, role, password_hash, bus_id, active,
               CASE WHEN role = 'admin' THEN must_change_password ELSE 0 END,
               failed_logins, locked_until, created_at, updated_at
          FROM users;
      DROP TABLE users;
      ALTER TABLE users_v3 RENAME TO users;
      UPDATE schema_version SET version = 3 WHERE version < 3;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `,
  },
  // v4: encrypted copy of passwords the super admin issues to bus and operations admins, so the
  // super admin can look them up later (super admins' own passwords are never stored this way).
  {
    version: 4,
    script: `
      ALTER TABLE users ADD COLUMN password_view TEXT;
      UPDATE schema_version SET version = 4 WHERE version < 4;
    `,
    // another serverless instance may have added the column a moment earlier
    alreadyDone: /duplicate column name/i,
  },
];
const splitSql = (sql) => sql.split(/;\s*\n/).map((s) => s.trim().replace(/;$/, '')).filter(Boolean);

export async function migrate() {
  const d = await driver();
  await d.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)', []);
  await d.run('INSERT INTO schema_version(version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version)', []);
  let version = (await d.get('SELECT MAX(version) AS v FROM schema_version', []))?.v ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (typeof m === 'string') {
      await d.batch([...splitSql(m), `UPDATE schema_version SET version = ${i + 1} WHERE version < ${i + 1}`]);
    } else {
      // table rebuilds: a script with its own transaction and version bump
      try {
        await d.exec(m.script);
      } catch (e) {
        try { await d.exec('ROLLBACK'); } catch { /* nothing open */ }
        try { await d.exec('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
        if (!(m.alreadyDone && m.alreadyDone.test(e?.message || ''))) throw e;
        await d.run(`UPDATE schema_version SET version = ${m.version} WHERE version < ${m.version}`, []);
      }
    }
    version = i + 1;
  }
  return version;
}

export const getSetting = async (key, fallback = '') => (await get('SELECT value FROM settings WHERE key = ?', key))?.value ?? fallback;
export const setSetting = (key, value) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));

/**
 * Create the first admin if no users exist.
 * Local: random password, written to data/initial-admin.txt. Serverless: only from ADMIN_PASSWORD.
 */
export async function bootstrapAdmin({ writeFile = !config.serverless } = {}) {
  const count = (await get('SELECT COUNT(*) AS c FROM users')).c;
  if (count > 0) return null;
  let password = process.env.ADMIN_PASSWORD || '';
  if (password && passwordProblem(password)) {
    console.warn(`ADMIN_PASSWORD ignored: ${passwordProblem(password)}`);
    password = '';
  }
  if (!password) {
    if (config.serverless) return { missing: true };
    password = generatePassword(16);
  }
  const t = now();
  const r = await run(
    'INSERT OR IGNORE INTO users(username,name,role,password_hash,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)',
    'admin', 'Administrator', 'admin', hashPassword(password), t, t,
  );
  if (!r.changes) return null;
  let file = null;
  if (writeFile) {
    file = credentialsFile('initial-admin.txt');
    fs.writeFileSync(
      file,
      `UU Bus ERP first admin login\n\nusername: admin\npassword: ${password}\n\nYou must change this password on first login. Delete this file afterwards.\n`,
      { mode: 0o600 },
    );
  }
  return { username: 'admin', password, file };
}

/** Run migrations (and bootstrap the admin) once per process / serverless instance. */
let readyPromise = null;
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const version = await migrate();
      const firstAdmin = await bootstrapAdmin();
      if (firstAdmin?.missing) console.warn('No admin account yet. Set ADMIN_PASSWORD or run "npm run seed:buses" against this database.');
      return { version, firstAdmin: firstAdmin?.missing ? null : firstAdmin };
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

/** Housekeeping: drop expired sessions, stale check-in sessions, old live events and rate-limit rows. */
export async function cleanup() {
  const t = now();
  await run('DELETE FROM sessions WHERE expires_at < ?', t);
  await run('DELETE FROM checkin_sessions WHERE expires_at < ?', t - 3_600_000);
  await run('DELETE FROM events WHERE created_at < ?', t - 6 * 3_600_000);
  await run('DELETE FROM rate_limits WHERE reset_at < ?', t);
}

export async function closeDb() {
  if (!driverPromise) return;
  try { await (await driverPromise).close(); } catch { /* ignore */ }
  driverPromise = null;
  readyPromise = null;
}
