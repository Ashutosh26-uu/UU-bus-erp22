import { $, api, esc, theme, fmtTime, initials, directionLabel, directionIcon, formHandler, ICONS, icon } from './common.js';

/*
 * Student boarding page (opened by scanning the bus QR code).
 *  1. the QR is checked                    2. the student types full name + student ID
 *  3. if that student is registered on THIS bus their record is shown, otherwise "invalid"
 *  4. the student checks it and taps Verify; the bus admin sees the name turn green straight away
 */
const view = $('#view');
const banner = $('#banner');
theme.button($('#themeBtn'));

const DEVICE_KEY = 'uu_dev';
const LAST_KEY = 'uu_last';
let expiresAt = 0;
let timer = null;
let trip = null;

// Device token mirror: cookie + localStorage, so neither alone can be cleared to "become a new phone".
try { const d = localStorage.getItem(DEVICE_KEY); if (d) api.extraHeaders['X-Device-Token'] = d; } catch { /* ignore */ }
const rememberDevice = (tok) => { if (!tok) return; api.extraHeaders['X-Device-Token'] = tok; try { localStorage.setItem(DEVICE_KEY, tok); } catch { /* ignore */ } };

// [icon, title, explanation, tone]
const ERRORS = {
  QR_EXPIRED: ['clock', 'This QR code isn\'t valid', 'It has expired or was replaced. Scan the QR code inside your bus again.', 'danger'],
  NO_TRIP: ['bus', 'The trip hasn\'t started', 'Your bus admin hasn\'t started today\'s trip yet. Scan again once they have.', 'warn'],
  SESSION_EXPIRED: ['clock', 'Time ran out', 'Scan the QR code again and finish within a few minutes.', 'warn'],
  NO_SESSION: ['camera', 'Scan your bus QR code', 'Open your phone camera and point it at the QR code inside your bus.', ''],
  TRIP_ENDED: ['ban', 'This trip has ended', 'If you are on the bus, ask your bus admin to mark you.', 'danger'],
  NOT_ON_BUS: ['ban', 'Invalid', 'You are not registered on this bus. Board the bus you are registered on, or speak to the transport office.', 'danger'],
  DEVICE_USED: ['phoneOff', 'Phone already used', 'This phone has already been used to board someone on this trip. Every student uses their own phone.', 'danger'],
  DEVICE_BOUND: ['lock', 'This phone belongs to another student', 'Use your own phone, or ask your bus admin to mark you.', 'danger'],
  TOO_MANY_DEVICES: ['lock', 'Too many phones', 'You have used several phones recently. Ask the transport office to reset your phones.', 'warn'],
  LOOKUPS_EXHAUSTED: ['ban', 'Too many tries', 'Scan the QR code again and check your name and ID with your bus admin.', 'danger'],
  NETWORK: ['wifiOff', 'No internet connection', 'Check your mobile data or Wi-Fi and try again.', 'warn'],
  RATE_LIMITED: ['clock', 'Please wait a moment', 'Too many requests from this network. Try again in a minute.', 'warn'],
  GENERIC: ['alert', 'Something went wrong', 'Scan the QR code again. If it keeps happening, tell your bus admin.', 'danger'],
};

start();

async function start() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  // /checkin/<bus number>: each bus has its own link; the server checks the code belongs to that bus
  const pathBus = (() => { const m = location.pathname.match(/^\/checkin\/([^/]+)/); return m ? decodeURIComponent(m[1]) : null; })();
  if (token) history.replaceState({}, '', pathBus ? `/checkin/${encodeURIComponent(pathBus)}` : '/checkin');
  renderLoading(token ? 'Checking the QR code' : 'Loading');
  try {
    let s;
    if (token) {
      s = await api.post('/api/checkin/session', pathBus ? { token, bus: pathBus } : { token });
    } else {
      s = await api.get('/api/checkin/session');
      rememberDevice(s.device);
      if (!s.active) return renderError(s.reason === 'TRIP_ENDED' ? 'TRIP_ENDED' : 'NO_SESSION');
    }
    rememberDevice(s.device);
    trip = s.trip;
    expiresAt = s.expiresAt;
    showBanner();
    startTimer();
    if (s.student && s.boardedAt) return renderSuccess({ student: s.student, boardedAt: s.boardedAt, already: true });
    if (s.student) return renderConfirm(s.student);
    renderForm();
  } catch (e) {
    renderError(e.code, e.message);
  }
}

function showBanner() {
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div><div class="xs">Bus</div><div class="num">${esc(trip.bus_number)}</div></div>
    <div class="grow">
      <div class="bold">${esc(trip.bus_name || '')}</div>
      <div class="sub">${esc(trip.bus_route || '')}</div>
    </div>
    <span class="pill">${directionIcon(trip.direction)} ${directionLabel(trip.direction)}</span>`;
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    const left = expiresAt - Date.now();
    const t = $('#timer');
    if (t) {
      const s = Math.max(0, Math.floor(left / 1000));
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    if (left <= 0) { clearInterval(timer); if (!$('#successCard')) renderError('SESSION_EXPIRED'); }
  }, 500);
}

const timerPill = () => `<span class="pill warn timer" title="Time left to finish">${icon('clock')} <span id="timer">-</span></span>`;

function renderLoading(msg) {
  view.innerHTML = `<div class="card step center pad-lg"><div class="spinner lg" role="status"></div><p class="muted mt">${esc(msg)}</p></div>`;
}

function renderForm(prefill) {
  let last = prefill;
  if (!last) { try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { last = null; } }
  view.innerHTML = `
    <div class="card step pad-lg">
      <div class="row between mb">
        <div><h2>Enter your details</h2><p class="muted small">Exactly as on your university ID card.</p></div>
        ${timerPill()}
      </div>
      <form id="idForm" class="stack" autocomplete="off">
        <div class="field">
          <label for="name">Full name</label>
          <input class="input lg" id="name" name="name" autocomplete="name" autocapitalize="words" placeholder="As on your ID card" value="${esc(last?.name || '')}" required minlength="2" maxlength="80">
        </div>
        <div class="field">
          <label for="uuid">Student ID (UUID)</label>
          <input class="input lg mono" id="uuid" name="uuid" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="e.g. UU2023CS0142" value="${esc(last?.uuid || '')}" required minlength="2" maxlength="40">
        </div>
        <div class="error-text" data-error hidden></div>
        <button class="btn primary lg block" type="submit">Find my record</button>
        ${last?.uuid ? '<button class="btn ghost block" type="button" id="clearLast">Not you? Clear these details</button>' : ''}
      </form>
    </div>`;
  const form = $('#idForm');
  $('#uuid').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  $('#clearLast')?.addEventListener('click', () => { try { localStorage.removeItem(LAST_KEY); } catch { /* ignore */ } renderForm({}); });
  if (last?.uuid) setTimeout(() => $('button[type=submit]', form)?.focus(), 50); else setTimeout(() => $('#name').focus(), 50);
  formHandler(form, $('button[type=submit]', form), async (v) => {
    let r;
    try {
      r = await api.post('/api/checkin/lookup', { uuid: v.uuid.trim(), name: v.name.trim() });
    } catch (e) {
      // problems that end this check-in get the full-screen message; a wrong name/ID stays inline
      if (['SESSION_EXPIRED', 'LOOKUPS_EXHAUSTED', 'TRIP_ENDED', 'RATE_LIMITED', 'ALREADY'].includes(e.code)) { renderError(e.code, e.message); return; }
      throw e;
    }
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ name: v.name.trim(), uuid: r.student.uuid })); } catch { /* ignore */ }
    if (r.boardedAt) return renderSuccess({ student: r.student, boardedAt: r.boardedAt, already: true });
    renderConfirm(r.student);
  });
}

function renderConfirm(s) {
  view.innerHTML = `
    <div class="card step pad-lg">
      <div class="row between mb">
        <div><h2>Check your details</h2><p class="muted small">Registered on Bus ${esc(trip.bus_number)}</p></div>
        ${timerPill()}
      </div>
      <div class="row mb">
        <div class="avatar lg">${esc(initials(s.name))}</div>
        <div class="grow"><div class="bold" id="studentName">${esc(s.name)}</div><div class="mono small muted">${esc(s.uuid)}</div></div>
      </div>
      <div class="detail-grid">
        <div><div class="k">Course</div><div class="v">${esc(s.course || '-')}</div></div>
        <div><div class="k">Year</div><div class="v">${esc(s.year || '-')}</div></div>
        ${s.specialization ? `<div class="span"><div class="k">Specialization</div><div class="v">${esc(s.specialization)}</div></div>` : ''}
        <div class="span"><div class="k">Your stop</div><div class="v">${icon('pin')} ${esc(s.stop || '-')}</div></div>
      </div>
      <div class="error-text mt" id="confirmErr" hidden></div>
      <div class="stack mt">
        <button class="btn primary lg block" id="doneBtn">${ICONS.check}<span>These are my details, verify</span></button>
        <button class="btn ghost block" id="notMe">This isn't me</button>
      </div>
    </div>`;
  $('#notMe').addEventListener('click', () => renderForm({}));
  const btn = $('#doneBtn');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    const err = $('#confirmErr'); err.hidden = true;
    try {
      const r = await api.post('/api/checkin/confirm');
      renderSuccess({ student: r.student, boardedAt: r.boardedAt });
    } catch (e) {
      if (e.code === 'ALREADY') return renderSuccess({ student: s, boardedAt: e.data.at, already: true });
      if (e.code && ERRORS[e.code]) return renderError(e.code, e.message);
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.removeAttribute('aria-busy');
    }
  });
  setTimeout(() => btn.focus(), 50);
}

function renderSuccess({ student, boardedAt, already = false }) {
  clearInterval(timer);
  try { navigator.vibrate?.([60, 40, 60]); } catch { /* ignore */ }
  view.innerHTML = `
    <div class="ticket step" id="successCard">
      <div class="top">
        <svg class="checkmark" viewBox="0 0 86 86" aria-hidden="true"><circle cx="43" cy="43" r="40"/><path d="M26 44l11 11 23-25"/></svg>
        <h2>${already ? 'You were already verified' : 'Verified'}</h2>
        <p class="muted small mt">${already ? 'Your boarding on this trip was recorded earlier.' : 'Your bus admin can see you on the list now. Have a safe journey.'}</p>
      </div>
      <div class="cut"></div>
      <div class="bottom">
        <div class="detail-grid">
          <div class="span"><div class="k">Student</div><div class="v">${esc(student.name)} <span class="muted mono small">${esc(student.uuid)}</span></div></div>
          <div><div class="k">Bus</div><div class="v">Bus ${esc(trip.bus_number)}</div></div>
          <div><div class="k">Trip</div><div class="v">${directionIcon(trip.direction)} ${directionLabel(trip.direction)}</div></div>
          <div><div class="k">Stop</div><div class="v">${esc(student.stop || '-')}</div></div>
          <div><div class="k">Time</div><div class="v">${fmtTime(boardedAt)}</div></div>
        </div>
        <p class="xs faint mt center">You can close this page.</p>
      </div>
    </div>`;
}

function renderError(code, message) {
  clearInterval(timer);
  const [iconName, title, text, tone] = ERRORS[code] || ERRORS.GENERIC;
  view.innerHTML = `
    <div class="card step pad-lg center">
      <div class="status-icon ${tone}">${ICONS[iconName] || ICONS.alert}</div>
      <h2>${esc(title)}</h2>
      <p class="muted mt">${esc(code === 'NOT_ON_BUS' && message ? message : text)}</p>
      ${message && !ERRORS[code] ? `<p class="small faint mt">${esc(message)}</p>` : ''}
      ${code === 'SESSION_EXPIRED' || code === 'QR_EXPIRED' || code === 'LOOKUPS_EXHAUSTED' ? '<p class="small mt">Tip: hold the camera on the code until the page opens.</p>' : ''}
    </div>`;
}
