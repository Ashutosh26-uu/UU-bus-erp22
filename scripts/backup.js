/**
 * Consistent online backup of the SQLite database (safe while the server runs).
 * Usage: npm run backup   -> data/backups/bus-erp-YYYYMMDD-HHMMSS.sqlite
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { db, closeDb } from '../src/db.js';

const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1-$2');
const file = path.join(dir, `bus-erp-${stamp}.sqlite`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
closeDb();
console.log(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
