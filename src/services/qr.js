import QRCode from 'qrcode';
import { config, publicBaseUrl } from '../config.js';
import { hmac, safeEqual } from '../security.js';
import { get, getSetting } from '../db.js';

/**
 * Rotating QR tokens.
 *  token = <tripId>.<slot>.<hmac>
 *  slot  = floor(now / rotateSeconds)  -> a new QR every N seconds
 *  hmac  = HMAC-SHA256(tripSecret || serverSecret, tripId.slot)
 * A screenshot or forwarded link dies within rotateSeconds * (1 + grace). Only the live screen works.
 */
const SIG_LEN = 27;
const slotOf = (ms) => Math.floor(ms / 1000 / config.qrRotateSec);
const sigFor = (trip, payload) => hmac(trip.secret + '|' + config.sessionSecret, payload).slice(0, SIG_LEN);

export function tokenFor(trip, ms = Date.now()) {
  const payload = `${trip.id}.${slotOf(ms)}`;
  return `${payload}.${sigFor(trip, payload)}`;
}

export const baseUrl = () => publicBaseUrl(getSetting('base_url'));
/** Each bus gets its own link: /checkin/<bus number>?t=<token>. The token is still bound to the trip. */
export const checkinUrl = (token, busNumber) =>
  `${baseUrl()}/checkin${busNumber ? `/${encodeURIComponent(busNumber)}` : ''}?t=${encodeURIComponent(token)}`;

export function secondsLeftInSlot(ms = Date.now()) {
  const s = config.qrRotateSec;
  return s - Math.floor((ms / 1000) % s);
}

export function qrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1220ff', light: '#ffffff00' },
  });
}

/** Returns the active trip row (with secret) if the token is valid right now, else null. */
export function verifyToken(token, ms = Date.now()) {
  if (typeof token !== 'string' || token.length > 120) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const tripId = Number(parts[0]);
  const slot = Number(parts[1]);
  if (!Number.isInteger(tripId) || tripId <= 0 || !Number.isInteger(slot)) return null;
  const cur = slotOf(ms);
  if (slot > cur || slot < cur - config.qrGraceSlots) return null;
  const trip = get('SELECT * FROM trips WHERE id = ? AND status = ?', tripId, 'active');
  if (!trip) return null;
  return safeEqual(parts[2], sigFor(trip, `${tripId}.${slot}`)) ? trip : null;
}
