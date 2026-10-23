/*
 * Long-running server for a laptop, college server or VPS: `npm start`.
 * (On Vercel the same app runs as a serverless function from api/index.js.)
 */
import { config, lanIp } from './config.js';
import { ready, cleanup, closeDb, dbKind } from './db.js';
import { closeAll } from './services/events.js';
import { baseUrl } from './services/qr.js';
import app from './app.js';

if (config.problems.length) {
  console.error(`Configuration problems:\n - ${config.problems.join('\n - ')}`);
  process.exit(1);
}

const { version, firstAdmin } = await ready();
const qrBase = await baseUrl();

const server = app.listen(config.port, config.host, () => {
  const where = dbKind() === 'sqlite' ? `${config.dbPath}` : `${dbKind()} ${config.dbUrl.replace(/\?.*$/, '')}`;
  const lines = [
    '',
    '  UU Bus ERP is running',
    `  Local:     http://localhost:${config.port}`,
    `  Network:   http://${lanIp()}:${config.port}`,
    `  QR links:  ${qrBase}  (change in Admin > Settings or BASE_URL)`,
    `  Database:  ${where}  (schema v${version})`,
    `  Live:      ${config.liveMode === 'sse' ? 'instant push (SSE)' : 'polling'}`,
  ];
  if (firstAdmin) {
    lines.push('', '  FIRST RUN: admin account created', `  username: ${firstAdmin.username}`, `  password: ${firstAdmin.password}`);
    if (firstAdmin.file) lines.push(`  (also saved to ${firstAdmin.file} - delete it after first login)`);
  }
  console.log(lines.join('\n') + '\n');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

const housekeeping = setInterval(() => { cleanup().catch((e) => console.error('cleanup failed', e)); }, 10 * 60_000);
housekeeping.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down gracefully...`);
  closeAll();
  server.close(() => { closeDb().finally(() => process.exit(0)); });
  setTimeout(() => { closeDb().finally(() => process.exit(0)); }, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e); });
process.on('unhandledRejection', (e) => { console.error('Unhandled rejection:', e); });
