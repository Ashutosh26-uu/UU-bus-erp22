import { rateLimit } from 'express-rate-limit';

/**
 * IP based throttles. Campus Wi-Fi puts hundreds of phones behind one NAT address, so the student
 * limits are deliberately generous; the real brute-force protection for check-ins is per
 * check-in session (max lookups) and the rotating QR token itself.
 */
const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message, code: 'RATE_LIMITED' }),
  });

export const apiLimiter = make(60_000, 900, 'Too many requests, slow down a little.');
export const loginLimiter = make(15 * 60_000, 25, 'Too many login attempts from this network. Try again in 15 minutes.');
export const scanLimiter = make(60_000, 240, 'Too many scans from this network. Wait a minute and try again.');
export const lookupLimiter = make(60_000, 240, 'Too many attempts from this network. Wait a minute and try again.');
