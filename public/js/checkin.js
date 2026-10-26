import { $, api, esc, theme, fmtTime, initials, directionLabel, directionIcon, formHandler, ICONS } from './common.js';

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

const ERRORS = {
  QR_EXPIRED: ['⏱️', 'QR code not valid', 'This QR code has expired or was replaced. Scan the QR shown on your bus right now.', 'danger'],
  NO_TRIP: ['🚌', 'Trip not started yet', 'This bus has no trip running right now. Ask the incharge to start the trip, then scan the QR again.', 'warn'],
  SESSION_EXPIRED: ['⏱️', 'Time is up', 'Your check-in window closed. Scan the QR again and finish within a few minutes.', 'warn'],
  NO_SESSION: ['📷', 'Scan the bus QR', 'Open your phone camera and scan the QR code on the bus screen to board.', ''],
  TRIP_ENDED: ['🛑', 'Trip has ended', 'The incharge closed this trip. If you are on the bus, ask them to mark you manually.', 'danger'],
  DEVICE_USED: ['📵', 'Phone already used', 'This phone has already boarded a student on this trip. Every student must use their own phone.', 'danger'],
  DEVICE_BOUND: ['🔒', 'Phone linked to someone else', 'This phone is linked to a different student. Use your own phone, or ask the incharge to mark you manually.', 'danger'],
  TOO_MANY_DEVICES: ['🔒', 'Too many phones', 'You have used several different phones recently. Ask the admin to reset your devices.', 'warn'],
  LOOKUPS_EXHAUSTED: ['🚫', 'Too many attempts', 'Scan the QR again and check your ID and name with the incharge.', 'danger'],
  NETWORK: ['📡', 'No connection', 'Check mobile data or Wi-Fi, then try again.', 'warn'],
  RATE_LIMITED: ['🐢', 'Slow down', 'Too many requests from this network. Wait a minute and try again.', 'warn'],
  GENERIC: ['⚠️', 'Something went wrong', 'Please scan the QR again. If it keeps failing, tell the incharge.', 'danger'],
};

boot();

async function boot() {
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  // /checkin/<bus number> — each bus has its own link; the server double-checks the token belongs to that bus
  const pathBus = (() => { const m = location.pathname.match(/^\/checkin\/([^/]+)/); return m ? decodeURIComponent(m[1]) : null; })();
  if (token) history.replaceState({}, '', pathBus ? `/checkin/${encodeURIComponent(pathBus)}` : '/checkin');
  renderLoading(token ? 'Checking the QR code…' : 'Loading…');
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
    if (s.student) return renderConfirm(s.student, s.boardedAt);
    renderForm();
  } catch (e) {
    renderError(e.code, e.message);
  }
}

function showBanner() {
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div><div class="xs">BUS</div><div class="num">${esc(trip.bus_number)}</div></div>
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

function renderLoading(msg) {
  view.innerHTML = `<div class="card step center pad-lg"><div class="spinner lg" role="status"></div><p class="muted mt">${esc(msg)}</p></div>`;
}

function renderForm(prefill) {
  let last = prefill;
  if (!last) { try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { last = null; } }
  view.innerHTML = `
    <div class="card step pad-lg">
      <div class="row between mb">
        <div><h2>Who are you?</h2><p class="muted small">Enter the details exactly as on your ID card.</p></div>
        <span class="pill warn timer" title="Time left to finish">⏱ <span id="timer">—</span></span>
      </div>
      <form id="idForm" class="stack" autocomplete="off">
        <div class="field">
          <label for="name">Full name</label>
          <input class="input lg" id="name" name="name" autocomplete="name" autocapitalize="words" placeholder="e.g. Aditi Sharma" value="${esc(last?.name || '')}" required minlength="2" maxlength="80">
        </div>
        <div class="field">
          <label for="uuid">Student ID / UUID</label>
          <input class="input lg mono" id="uuid" name="uuid" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="e.g. UU2023CS0142" value="${esc(last?.uuid || '')}" required minlength="2" maxlength="40">
        </div>
        <div class="error-text" data-error hidden></div>
        <button class="btn primary lg block" type="submit">Continue ${ICONS.check}</button>
        ${last?.uuid ? '<button class="btn ghost block" type="button" id="clearLast">Not you? Clear saved details</button>' : ''}
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
      // Errors that end the whole check-in go to the full-screen state; others stay inline.
      if (['SESSION_EXPIRED', 'LOOKUPS_EXHAUSTED', 'TRIP_ENDED', 'RATE_LIMITED', 'ALREADY'].includes(e.code)) { renderError(e.code, e.message); return; }
      throw e;
    }
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ name: v.name.trim(), uuid: r.student.uuid })); } catch { /* ignore */ }
    if (r.boardedAt) return renderSuccess({ student: r.student, boardedAt: r.boardedAt, already: true });
    renderConfirm(r.student);
  });
}

function renderConfirm(s) {
  const other = s.ownBus === false && !!s.bus;
  view.innerHTML = `
    <div class="card step pad-lg">
      <div class="row between mb">
        <h2>Is this you?</h2>
        <span class="pill warn timer">⏱ <span id="timer">—</span></span>
      </div>
      <div class="row mb">
        <div class="avatar lg">${esc(initials(s.name))}</div>
        <div class="grow"><div class="bold" id="studentName">${esc(s.name)}</div><div class="mono small muted">${esc(s.uuid)}</div></div>
      </div>
      <div class="detail-grid">
        <div><div class="k">Course</div><div class="v">${esc(s.course || '—')}</div></div>
        <div><div class="k">Year</div><div class="v">${esc(s.year || '—')}</div></div>
        ${s.specialization ? `<div class="span"><div class="k">Specialization</div><div class="v">${esc(s.specialization)}</div></div>` : ''}
        <div><div class="k">Your stop</div><div class="v">📍 ${esc(s.stop || '—')}</div></div>
        <div><div class="k">Your bus</div><div class="v">${s.bus ? `Bus ${esc(s.bus.number)}` : '—'}</div></div>
      </div>
      ${other ? `<div class="card soft mt small"><b>Heads up:</b> you are assigned to ${s.bus ? `Bus ${esc(s.bus.number)}` : 'another bus'} but boarding <b>Bus ${esc(trip.bus_number)}</b>. You can continue; the incharge will see a note.</div>` : ''}
      <div class="error-text mt" id="confirmErr" hidden></div>
      <div class="stack mt">
        <button class="btn primary lg block" id="doneBtn">Yes, that's me — Done ${ICONS.check}</button>
        <button class="btn ghost block" id="notMe">Not me</button>
      </div>
    </div>`;
  $('#notMe').addEventListener('click', () => renderForm({}));
  const btn = $('#doneBtn');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    const err = $('#confirmErr'); err.hidden = true;
    try {
      const r = await api.post('/api/checkin/confirm');
      renderSuccess({ student: r.student, boardedAt: r.boardedAt, flags: r.flags });
    } catch (e) {
      if (e.code === 'ALREADY') return renderSuccess({ student: s, boardedAt: e.data.at, already: true });
      if (e.code && ERRORS[e.code]) return renderError(e.code, e.message);
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.removeAttribute('aria-busy');
    }
  });
  setTimeout(() => btn.focus(), 50);
}

function renderSuccess({ student, boardedAt, flags = [], already = false }) {
  clearInterval(timer);
  try { navigator.vibrate?.([60, 40, 60]); } catch { /* ignore */ }
  view.innerHTML = `
    <div class="ticket step" id="successCard">
      <div class="top">
        <svg class="checkmark" viewBox="0 0 86 86" aria-hidden="true"><circle cx="43" cy="43" r="40"/><path d="M26 44l11 11 23-25"/></svg>
        <h2>${already ? 'Already on board' : "You're on board!"}</h2>
        <p class="muted small mt">${already ? 'This boarding was already recorded.' : 'The incharge can see you now. Have a safe ride.'}</p>
      </div>
      <div class="cut"></div>
      <div class="bottom">
        <div class="detail-grid">
          <div class="span"><div class="k">Passenger</div><div class="v">${esc(student.name)} <span class="muted mono small">${esc(student.uuid)}</span></div></div>
          <div><div class="k">Bus</div><div class="v">Bus ${esc(trip.bus_number)}</div></div>
          <div><div class="k">Direction</div><div class="v">${directionIcon(trip.direction)} ${directionLabel(trip.direction)}</div></div>
          <div><div class="k">Stop</div><div class="v">📍 ${esc(student.stop || '—')}</div></div>
          <div><div class="k">Boarded at</div><div class="v">${fmtTime(boardedAt)}</div></div>
        </div>
        ${flags.includes('wrong_bus') ? '<p class="small muted mt">Noted: this is not your assigned bus.</p>' : ''}
        <p class="xs faint mt center">You can close this page.</p>
      </div>
    </div>`;
}

function renderError(code, message) {
  clearInterval(timer);
  const [icon, title, text, tone] = ERRORS[code] || ERRORS.GENERIC;
  view.innerHTML = `
    <div class="card step pad-lg center">
      <div class="status-icon ${tone}">${icon}</div>
      <h2>${esc(title)}</h2>
      <p class="muted mt">${esc(text)}</p>
      ${message && !ERRORS[code] ? `<p class="small faint mt">${esc(message)}</p>` : ''}
      ${code === 'SESSION_EXPIRED' || code === 'QR_EXPIRED' || code === 'LOOKUPS_EXHAUSTED' ? '<p class="small mt"><b>Tip:</b> keep the camera on the screen until the page opens.</p>' : ''}
    </div>`;
}

