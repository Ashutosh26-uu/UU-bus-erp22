import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

export function setCookie(res, name, value, { maxAgeMs, sameSite = 'Lax', httpOnly = true, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (config.cookieSecure) parts.push('Secure');
  if (maxAgeMs != null) {
    parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    parts.push(`Expires=${new Date(Date.now() + maxAgeMs).toUTCString()}`);
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name, path = '/') {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${secure}`);
}

export const clientIp = (req) => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
export const userAgent = (req) => String(req.headers['user-agent'] || '').slice(0, 300);

/** Validate a zod schema; throws 400 with the first readable issue. */
export function validate(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue.message}`);
  }
  return r.data;
}

export const intParam = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
};
