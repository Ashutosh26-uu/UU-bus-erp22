import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Project root. Works as native ESM, and inside serverless bundles where import.meta may be empty. */
function findRoot() {
  try {
    const url = import.meta?.url;
    if (url) return path.resolve(path.dirname(fileURLToPath(url)), '..');
  } catch { /* fall through */ }
  const candidates = [process.env.LAMBDA_TASK_ROOT, process.cwd()].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'views'))) || candidates[0] || '.';
}
export const ROOT = findRoot();

// Load .env if present (Node >= 21.7 has process.loadEnvFile)
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env, that is fine */ }

const env = process.env;

/**
 * Where we run. 'server' = one long-lived process (npm start). Everything else is stateless
 * serverless functions: no disk that survives, no shared memory, no background timers.
 * The Netlify wrapper sets HOSTING_PLATFORM=netlify before loading the app.
 */
const PLATFORM = env.HOSTING_PLATFORM
  || (env.VERCEL ? 'vercel' : env.NETLIFY ? 'netlify' : env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'server');
const SERVERLESS = PLATFORM !== 'server' || env.SERVERLESS === '1' || env.SERVERLESS === 'true';
const ENV_HELP = PLATFORM === 'netlify'
  ? 'Netlify: Site configuration → Environment variables, then redeploy'
  : PLATFORM === 'vercel'
    ? 'Vercel: Settings → Environment Variables, then redeploy'
    : 'your hosting provider\'s environment variables';
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
if (!SERVERLESS) fs.mkdirSync(DATA_DIR, { recursive: true });

/** Configuration problems that stop the app from working; shown on a setup page instead of crashing. */
const problems = [];

function loadOrCreateSecret() {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  if (SERVERLESS) {
    problems.push(`SESSION_SECRET is missing or shorter than 32 characters. Add a long random value (${ENV_HELP}).`);
    return 'unconfigured-' + crypto.randomBytes(24).toString('base64url');
  }
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 64) return s;
  } catch { /* create below */ }
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

/** Best-guess LAN IPv4 so phones on the same Wi-Fi can open the QR link. */
export function lanIp() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      let score = /^192\.168\./.test(i.address) ? 3 : /^10\./.test(i.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 1 : 0;
      if (/vmware|virtual|vethernet|docker|wsl|hyper-v|loopback|bluetooth/i.test(name)) score -= 10;
      candidates.push({ address: i.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}

function parseTrustProxy(v) {
  if (!v) return false;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return Number.isNaN(Number(v)) ? v : Number(v);
}

const PORT = Number(env.PORT) || 3000;
const BASE_URL = (env.BASE_URL || '').trim().replace(/\/+$/, '');
// Turso connection. Integrations name the variables differently, so accept the common spellings,
// and as a last resort any TURSO_* variable holding a libsql:// / https:// URL or a token.
const turso = Object.entries(env).filter(([k]) => /TURSO/i.test(k));
const DB_URL = (env.TURSO_DATABASE_URL || env.LIBSQL_URL || env.TURSO_DB_URL || env.TURSO_URL
  || turso.find(([, v]) => /^(libsql|https?):\/\//i.test(String(v).trim()))?.[1] || '').trim();
const DB_TOKEN = (env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN || env.TURSO_DB_AUTH_TOKEN || env.TURSO_TOKEN
  || turso.find(([k]) => /TOKEN/i.test(k))?.[1] || '').trim();
if (SERVERLESS && !DB_URL) problems.push(`TURSO_DATABASE_URL is not set. Create a Turso database and add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (${ENV_HELP}).`);
if (PLATFORM === 'vercel' && DB_URL.startsWith('file:')) problems.push('TURSO_DATABASE_URL points to a local file; serverless functions need a hosted database (libsql:// or https:// URL).');

const sessionSecret = loadOrCreateSecret();

export const config = Object.freeze({
  root: ROOT,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'bus-erp.sqlite'),
  dbUrl: DB_URL,
  dbAuthToken: DB_TOKEN,
  platform: PLATFORM,
  serverless: SERVERLESS,
  /** How often screens poll for live events in 'poll' mode (each poll is one function call). */
  pollMs: Math.round(Math.min(30, Math.max(1.5, Number(env.POLL_SECONDS) || 2.5)) * 1000),
  /** 'sse' pushes events over one long connection (single server); 'poll' stores events in the DB (serverless). */
  liveMode: env.LIVE_MODE === 'poll' || env.LIVE_MODE === 'sse' ? env.LIVE_MODE : SERVERLESS ? 'poll' : 'sse',
  /** 'db' keeps login/scan throttles in the database so every serverless instance shares them. */
  rateLimitStore: env.RATE_LIMIT_STORE === 'db' || env.RATE_LIMIT_STORE === 'memory' ? env.RATE_LIMIT_STORE : SERVERLESS ? 'db' : 'memory',
  port: PORT,
  host: env.HOST || '0.0.0.0',
  baseUrl: BASE_URL,
  isProd: env.NODE_ENV === 'production' || SERVERLESS,
  trustProxy: env.TRUST_PROXY ? parseTrustProxy(env.TRUST_PROXY) : SERVERLESS,
  sessionSecret,
  sessionTtlMs: (Number(env.SESSION_HOURS) || 12) * 3_600_000,
  qrRotateSec: Math.max(10, Number(env.QR_ROTATE_SECONDS) || 20),
  qrGraceSlots: Math.max(0, Number(env.QR_GRACE_SLOTS ?? 1)),
  checkinTtlMs: (Number(env.CHECKIN_MINUTES) || 5) * 60_000,
  maxDevicesPerStudent: Math.max(1, Number(env.MAX_DEVICES_PER_STUDENT) || 2),
  deviceWindowDays: 30,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : SERVERLESS || BASE_URL.startsWith('https://'),
  problems: Object.freeze(problems),
});

/** Credentials files written by the seed scripts; Turso and local databases get separate files. */
export const credentialsFile = (name) => path.join(DATA_DIR, DB_URL ? `turso-${name}` : name);

/**
 * URL phones should open (what the QR encodes).
 * Admin setting > BASE_URL env > (serverless) Vercel production domain > request origin > LAN IP.
 */
export function publicBaseUrl(settingValue, req) {
  const clean = (v) => String(v || '').trim().replace(/\/+$/, '');
  if (clean(settingValue)) return clean(settingValue);
  if (config.baseUrl) return config.baseUrl;
  if (SERVERLESS) {
    if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${clean(env.VERCEL_PROJECT_PRODUCTION_URL)}`;
    if (req) return `${req.protocol}://${req.get('host')}`;
  }
  return `http://${lanIp()}:${config.port}`;
}
