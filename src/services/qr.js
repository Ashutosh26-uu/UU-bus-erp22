import QRCode from 'qrcode';
import { config, publicBaseUrl } from '../config.js';
import { hmac, safeEqual, randomId } from '../security.js';
import { get, getSetting, setSetting } from '../db.js';

/*
 * Two QR modes (Admin → Settings):
 *
 *  'day'      One QR per bus per calendar day (India time). It works for whichever trip that bus is
 *             running, so it can be shown all day or printed. "New QR code" invalidates it at once.
 *             token = d<busId>.<istDay>.<hmac(serverSecret, busId|day|busNonce)>
 *
 *  'rotating' A new QR every N seconds, bound to one trip. Screenshots and forwarded links die
 *             within N × (1 + grace) seconds. Strongest protection against remote check-ins.
 *             token = <tripId>.<slot>.<hmac(tripSecret|serverSecret, tripId.slot)>
 */
const SIG_LEN = 27;
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export const qrMode = async () => ((await getSetting('qr_mode', config.qrModeDefault)) === 'rotating' ? 'rotating' : 'day');
export const setQrMode = (mode) => setSetting('qr_mode', mode === 'rotating' ? 'rotating' : 'day');

// ------------------------------------------------------------------ rotating (per trip)
const slotOf = (ms) => Math.floor(ms / 1000 / config.qrRotateSec);
const sigFor = (trip, payload) => hmac(trip.secret + '|' + config.sessionSecret, payload).slice(0, SIG_LEN);

export function tokenFor(trip, ms = Date.now()) {
  const payload = `${trip.id}.${slotOf(ms)}`;
  return `${payload}.${sigFor(trip, payload)}`;
}

export function secondsLeftInSlot(ms = Date.now()) {
  const s = config.qrRotateSec;
  return s - Math.floor((ms / 1000) % s);
}

// ------------------------------------------------------------------ whole day (per bus)
export const istDay = (ms = Date.now()) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
/** Epoch ms when the current India-time day ends (the day QR stops working). */
export const endOfIstDay = (ms = Date.now()) => (istDay(ms) + 1) * DAY_MS - IST_OFFSET_MS;
const busNonce = (busId) => getSetting(`qr_nonce:${busId}`, '0');
const daySig = (busId, day, nonce) => hmac(config.sessionSecret, `day|${busId}|${day}|${nonce}`).slice(0, SIG_LEN);

export async function dayTokenFor(busId, ms = Date.now()) {
  const day = istDay(ms);
  return `d${busId}.${day}.${daySig(busId, day, await busNonce(busId))}`;
}

/** "New QR code": every earlier QR of this bus (screens, prints, forwards) stops working. */
export const regenerateDayQr = (busId) => setSetting(`qr_nonce:${busId}`, randomId(9));

// ------------------------------------------------------------------ shared
/** Public address phones open. Pass the request so serverless deployments can fall back to their own origin. */
export const baseUrl = async (req) => publicBaseUrl(await getSetting('base_url'), req);

/** Each bus gets its own link: /checkin/<bus number>?t=<token>. */
export const checkinUrl = async (token, busNumber, req) =>
  `${await baseUrl(req)}/checkin${busNumber ? `/${encodeURIComponent(busNumber)}` : ''}?t=${encodeURIComponent(token)}`;

export function qrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#0b1220ff', light: '#ffffff00' },
  });
}

/**
 * Check a scanned token.
 * Returns { trip } (the running trip, with secret) or { error: 'QR_EXPIRED' | 'NO_TRIP', bus }.
 * Rotating tokens are accepted in both modes (they are strictly stronger); day tokens only in day mode.
 */
export async function verifyToken(token, ms = Date.now()) {
  if (typeof token !== 'string' || token.length > 120) return { error: 'QR_EXPIRED' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'QR_EXPIRED' };

  if (parts[0].startsWith('d')) {
    const busId = Number(parts[0].slice(1));
    const day = Number(parts[1]);
    if (!Number.isInteger(busId) || busId <= 0 || day !== istDay(ms)) return { error: 'QR_EXPIRED' };
    if ((await qrMode()) !== 'day') return { error: 'QR_EXPIRED' };
    if (!safeEqual(parts[2], daySig(busId, day, await busNonce(busId)))) return { error: 'QR_EXPIRED' };
    const bus = await get('SELECT id, number FROM buses WHERE id = ? AND active = 1', busId);
    if (!bus) return { error: 'QR_EXPIRED' };
    const trip = await get("SELECT * FROM trips WHERE bus_id = ? AND status = 'active'", busId);
    return trip ? { trip } : { error: 'NO_TRIP', bus };
  }

  const tripId = Number(parts[0]);
  const slot = Number(parts[1]);
  if (!Number.isInteger(tripId) || tripId <= 0 || !Number.isInteger(slot)) return { error: 'QR_EXPIRED' };
  const cur = slotOf(ms);
  if (slot > cur || slot < cur - config.qrGraceSlots) return { error: 'QR_EXPIRED' };
  const trip = await get('SELECT * FROM trips WHERE id = ? AND status = ?', tripId, 'active');
  if (!trip || !safeEqual(parts[2], sigFor(trip, `${tripId}.${slot}`))) return { error: 'QR_EXPIRED' };
  return { trip };
}
