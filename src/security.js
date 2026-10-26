import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Dummy verify so login timing is the same whether or not a user exists. */
const DUMMY_HASH = hashPassword('dummy-password-for-timing');
export function burnPasswordCheck(password) { verifyPassword(password, DUMMY_HASH); }

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (key, data) => crypto.createHmac('sha256', key).update(String(data)).digest('base64url');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function sign(value, secret) {
  return `${value}.${hmac(secret, value).slice(0, 32)}`;
}

export function unsign(signed, secret) {
  if (typeof signed !== 'string' || signed.length > 512) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const sig = signed.slice(i + 1);
  return safeEqual(sig, hmac(secret, value).slice(0, 32)) ? value : null;
}

const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** Random password that always passes passwordProblem(): letters and at least one digit, unambiguous characters. */
export function generatePassword(len = 14) {
  for (;;) {
    let out = '';
    for (let i = 0; i < Math.max(10, len); i++) out += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
    if (/[a-z]/i.test(out) && /\d/.test(out)) return out;
  }
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password too long';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

/** Normalise a person's name for comparison: lowercase, strip punctuation, collapse spaces. */
export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lenient-but-meaningful name match: exact normalised match, or every entered word is in the DB name (min 2 words). */
export function nameMatches(entered, actual) {
  const e = normName(entered), a = normName(actual);
  if (!e || !a) return false;
  if (e === a) return true;
  const ew = e.split(' '), aw = new Set(a.split(' '));
  return ew.length >= 2 && ew.every((w) => aw.has(w));
}

export const normUuid = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

/*
 * Reversible copy of passwords the super admin hands out (bus and operations admins), so the super
 * admin can look one up later. AES-256-GCM with a key derived from the server secret; a stolen
 * database alone cannot be read. If the server secret changes, old copies simply stop opening.
 */
const viewKey = (secret) => crypto.createHash('sha256').update(`password-view|${secret}`).digest();

export function sealPassword(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', viewKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), data.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function openPassword(sealed, secret) {
  try {
    const [v, iv, data, tag] = String(sealed || '').split('.');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', viewKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
