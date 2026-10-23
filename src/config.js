import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (Node >= 21.7 has process.loadEnvFile)
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env, that is fine */ }

const env = process.env;
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrCreateSecret() {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
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

export const config = Object.freeze({
  root: ROOT,
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'bus-erp.sqlite'),
  port: PORT,
  host: env.HOST || '0.0.0.0',
  baseUrl: BASE_URL,
  isProd: env.NODE_ENV === 'production',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  sessionSecret: loadOrCreateSecret(),
  sessionTtlMs: (Number(env.SESSION_HOURS) || 12) * 3_600_000,
  qrRotateSec: Math.max(10, Number(env.QR_ROTATE_SECONDS) || 20),
  qrGraceSlots: Math.max(0, Number(env.QR_GRACE_SLOTS ?? 1)),
  checkinTtlMs: (Number(env.CHECKIN_MINUTES) || 5) * 60_000,
  maxDevicesPerStudent: Math.max(1, Number(env.MAX_DEVICES_PER_STUDENT) || 2),
  deviceWindowDays: 30,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : BASE_URL.startsWith('https://'),
});

/** URL phones should open. Settings table override > env BASE_URL > LAN auto-detect. */
export function publicBaseUrl(settingValue) {
  const v = (settingValue || '').trim().replace(/\/+$/, '');
  if (v) return v;
  if (config.baseUrl) return config.baseUrl;
  return `http://${lanIp()}:${config.port}`;
}
