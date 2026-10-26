import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ready, cleanup, get } from './db.js';
import { HttpError, intParam } from './http.js';
import { loadSession, requireAuth } from './middleware/auth.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { subscribe, pollEvents } from './services/events.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import inchargeRoutes from './routes/incharge.js';
import checkinRoutes from './routes/checkin.js';

/*
 * The Express application, shared by:
 *  - src/server.js  (long-running local / VPS server)
 *  - api/index.js   (Vercel serverless function)
 */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

const isHttps = config.serverless || config.cookieSecure;
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

// static assets first: no session lookup or body parsing for css/js/icons (on Vercel the CDN serves them)
const PUBLIC = path.join(config.root, 'public');
// Serverless packagers place bundled files differently; find the HTML views wherever they landed.
const VIEWS = [config.root, process.cwd(), process.env.LAMBDA_TASK_ROOT]
  .filter(Boolean)
  .map((base) => path.join(base, 'views'))
  .find((dir) => fs.existsSync(path.join(dir, 'login.html'))) || path.join(config.root, 'views');
app.use(express.static(PUBLIC, { index: false, maxAge: config.isProd ? '1d' : 0, etag: true }));

// ------------------------------------------------------------------ setup gate
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function setupPage(res, title, items) {
  res.status(503).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup needed · UU Bus ERP</title><link rel="stylesheet" href="/css/app.css"></head><body><main class="auth"><div class="card pad-lg stack"><div class="status-icon warn">🛠️</div><h1 class="center">${escapeHtml(title)}</h1><ul class="small">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul><p class="xs muted">See the "Deploy on Vercel" section of the README. Redeploy after changing environment variables.</p></div></main></body></html>`);
}

let lastCleanup = 0;
app.use(async (req, res, next) => {
  if (config.problems.length) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Server is not configured yet', problems: config.problems });
    return setupPage(res, 'Finish the server setup', config.problems);
  }
  try {
    await ready();
  } catch (e) {
    console.error('Database not reachable:', e);
    const msg = 'Cannot reach the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.';
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: msg });
    return setupPage(res, 'Database unavailable', [msg]);
  }
  // opportunistic housekeeping (serverless has no background timers)
  if (Date.now() - lastCleanup > 10 * 60_000) {
    lastCleanup = Date.now();
    cleanup().catch((e) => console.error('cleanup failed', e));
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: config.serverless ? '4mb' : '10mb' }));
app.use(loadSession);

// ------------------------------------------------------------------ API
app.use('/api', apiLimiter, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/health', async (req, res) => {
  const users = (await get('SELECT COUNT(*) AS c FROM users')).c;
  res.json({ ok: true, live: config.liveMode, serverless: config.serverless, hasUsers: users > 0, time: Date.now() });
});
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/incharge', inchargeRoutes);
app.use('/api/checkin', checkinRoutes);
app.get('/api/events', requireAuth('admin', 'incharge'), (req, res) => {
  if (config.liveMode !== 'sse') throw new HttpError(409, 'Live updates use polling on this server', { code: 'USE_POLL' });
  subscribe(req, res, req.user);
});
app.get('/api/events/poll', requireAuth('admin', 'incharge'), async (req, res) => {
  const raw = req.query.after ?? '0';
  const after = raw === '0' || raw === '' ? 0 : intParam(raw, 'cursor');
  res.json(await pollEvents(req.user, after));
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------------------------------------------------------ pages
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
app.get('/bus/:number', requirePage('incharge', 'admin'), async (req, res, next) => {
  const bus = await get('SELECT id, number FROM buses WHERE number = ? AND active = 1', String(req.params.number).slice(0, 20));
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

export default app;
