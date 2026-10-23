/**
 * Consistent online backup of the local SQLite database (safe while the server runs).
 * Usage: npm run backup   -> data/backups/bus-erp-YYYYMMDD-HHMMSS.sqlite
 * Turso databases are backed up by Turso (point-in-time restore); for a local copy use
 * `turso db export <name>` or `turso db shell <name> .dump > backup.sql`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { execRaw, closeDb, dbKind } from '../src/db.js';

if (dbKind() !== 'sqlite') {
  console.log('This project uses a Turso database. Turso keeps point-in-time backups; for a local copy run:\n  turso db export <database-name>');
  process.exit(0);
}
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1-$2');
const file = path.join(dir, `bus-erp-${stamp}.sqlite`);
await execRaw(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
await closeDb();
console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
