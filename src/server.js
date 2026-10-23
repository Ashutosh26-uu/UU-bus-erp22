import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { config, lanIp } from './config.js';
import { migrate, bootstrapAdmin, cleanup, closeDb, get } from './db.js';
import { HttpError } from './http.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { subscribe, closeAll } from './services/events.js';
import { baseUrl } from './services/qr.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import inchargeRoutes from './routes/incharge.js';
import checkinRoutes from './routes/checkin.js';

// ------------------------------------------------------------------ boot
const schemaVersion = migrate();
const firstAdmin = bootstrapAdmin();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const isHttps = baseUrl().startsWith('https://');
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        ...(isHttps ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    hsts: isHttps ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// static assets first: no session lookup or body parsing for css/js/icons
const PUBLIC = path.join(config.root, 'public');
app.use(express.static(PUBLIC, { index: false, maxAge: config.isProd ? '1d' : 0, etag: true }));

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));
app.use(loadSession);

// ------------------------------------------------------------------ API
app.use('/api', apiLimiter, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/health', (req, res) => res.json({ ok: true, schema: schemaVersion, time: Date.now() }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/incharge', inchargeRoutes);
app.use('/api/checkin', checkinRoutes);
app.get('/api/events', requireAuth('admin', 'incharge'), (req, res) => subscribe(req, res, req.user));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------------------------------------------------------ pages
const VIEWS = path.join(config.root, 'views');

const page = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(VIEWS, file));
};
const requirePage = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
  if (!roles.includes(req.user.role)) return res.redirect('/');
  next();
};

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.redirect(req.user.home);
});
app.get('/login', (req, res, next) => (req.user ? res.redirect('/') : next()), page('login.html'));
app.get('/admin', requirePage('admin'), page('admin.html'));
// Portal picker (admins, unassigned incharges). An incharge with a bus goes straight to their own portal.
app.get('/incharge', requirePage('incharge', 'admin'), (req, res, next) => {
  if (req.user.role === 'incharge' && req.user.bus_number) return res.redirect(req.user.home);
  next();
}, page('incharge.html'));
// One portal per bus: /bus/12 is Bus 12's screen. Only its incharge (or an admin) may open it.
app.get('/bus/:number', requirePage('incharge', 'admin'), (req, res, next) => {
  const bus = get('SELECT id, number FROM buses WHERE number = ? AND active = 1', String(req.params.number).slice(0, 20));
  if (!bus) { res.status(404); return page('404.html')(req, res); }
  if (req.user.role !== 'admin' && req.user.bus_id != null && req.user.bus_id !== bus.id) return res.redirect(req.user.home);
  next();
}, page('incharge.html'));
app.get('/checkin', page('checkin.html'));
app.get('/checkin/:bus', page('checkin.html'));
app.use((req, res) => { res.status(404); page('404.html')(req, res); });

// ------------------------------------------------------------------ errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.status === 400) return res.status(400).json({ error: 'Bad request' });
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// ------------------------------------------------------------------ start
const server = app.listen(config.port, config.host, () => {
  const lines = [
    '',
    '  UU Bus ERP is running',
    `  Local:     http://localhost:${config.port}`,
    `  Network:   http://${lanIp()}:${config.port}`,
    `  QR links:  ${baseUrl()}  (change in Admin > Settings or BASE_URL)`,
    `  Database:  ${config.dbPath}  (schema v${schemaVersion})`,
  ];
  if (firstAdmin) {
    lines.push('', '  FIRST RUN: admin account created', `  username: ${firstAdmin.username}`, `  password: ${firstAdmin.password}`, `  (also saved to ${firstAdmin.file} - delete it after first login)`);
  }
  console.log(lines.join('\n') + '\n');
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

const housekeeping = setInterval(() => { try { cleanup(); } catch (e) { console.error('cleanup failed', e); } }, 10 * 60_000);
housekeeping.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down gracefully...`);
  closeAll();
  server.close(() => { closeDb(); process.exit(0); });
  setTimeout(() => { closeDb(); process.exit(0); }, 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e); });
process.on('unhandledRejection', (e) => { console.error('Unhandled rejection:', e); });
