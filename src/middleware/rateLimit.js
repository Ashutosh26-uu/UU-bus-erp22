import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { clientIp } from '../http.js';

/**
 * Counters in the database, so every serverless instance shares them (memory counters would reset
 * on each cold start and differ per instance).
 */
class DbStore {
  constructor(name) {
    this.prefix = `${name}:`;
    this.localKeys = false;
  }

  init(options) { this.windowMs = options.windowMs; }

  async increment(key) {
    const k = this.prefix + key;
    const t = Date.now();
    const reset = t + this.windowMs;
    const row = await get(
      `INSERT INTO rate_limits(key, hits, reset_at) VALUES(?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      k, reset, t, t, reset,
    );
    return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
  }

  async decrement(key) { await run('UPDATE rate_limits SET hits = MAX(hits - 1, 0) WHERE key = ?', this.prefix + key); }

  async resetKey(key) { await run('DELETE FROM rate_limits WHERE key = ?', this.prefix + key); }
}

/**
 * IP based throttles. Campus Wi-Fi puts hundreds of phones behind one NAT address, so the student
 * limits are deliberately generous; the real brute-force protection for check-ins is per
 * check-in session (max lookups) and the rotating QR token itself.
 */
const make = (name, windowMs, limit, message, shared = true) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // same real-IP logic as the audit log; IPv6 clients are grouped by /56 so they cannot rotate addresses
    keyGenerator: (req) => ipKeyGenerator(clientIp(req) || 'unknown'),
    ...(shared && config.rateLimitStore === 'db' ? { store: new DbStore(name) } : {}),
    handler: (req, res) => res.status(429).json({ error: message, code: 'RATE_LIMITED' }),
  });

// The general flood guard stays in memory (it runs on every request; the platform has its own DDoS shield).
export const apiLimiter = make('api', 60_000, 900, 'Too many requests, slow down a little.', false);
export const loginLimiter = make('login', 15 * 60_000, 25, 'Too many login attempts from this network. Try again in 15 minutes.');
export const scanLimiter = make('scan', 60_000, 240, 'Too many scans from this network. Wait a minute and try again.');
export const lookupLimiter = make('lookup', 60_000, 240, 'Too many attempts from this network. Wait a minute and try again.');
