import {
  $, $$, api, esc, toast, modal, confirmDialog, formHandler, theme, liveEvents, fmtTime, initials,
  directionLabel, directionIcon, flagPills, requireStaff, logout, passwordChangeForm, copyText, debounce, ICONS, icon,
} from './common.js';

/*
 * Bus portal.
 *  /bus/<number>  one bus: its QR, live count and the full student roster.
 *                 Bus admins run it; the super admin can too; operations admins only watch.
 *  /incharge      list of all bus portals (super admin, operations admin, unassigned bus admins).
 */
const view = $('#view');
const scopedNumber = (() => { const m = location.pathname.match(/^\/bus\/([^/]+)/); return m ? decodeURIComponent(m[1]) : null; })();

let user = null;
let readOnly = false;
let state = { buses: [], activeTrips: [], rotateSec: 20, baseUrl: '', qrMode: 'day' };
let bus = null;       // the bus of this portal
let trip = null;      // the trip on screen
let summary = null;   // { trip, counts, checkins, notBoarded }
let rosterFilter = 'all';
let rosterQuery = '';
let lastVerifiedId = null;
let qrTimer = null;
let raf = null;
let nextRotateAt = 0;
let wakeLock = null;
let soundOn = true;
let audioCtx = null;
let gridRefresh = null;
let renderedMode = null;
let validUntil = 0;

init();

async function init() {
  user = await requireStaff(['incharge', 'admin', 'operator']);
  if (!user) return;
  readOnly = !!user.readOnly;
  $('#userName').textContent = `${user.name} · ${user.roleLabel}`;
  theme.button($('#themeBtn'));
  $('#logoutBtn').innerHTML = `${ICONS.logout}<span>Sign out</span>`;
  $('#logoutBtn').addEventListener('click', logout);
  // bus admins and operations admins cannot change their own password (the super admin sets it)
  if (user.canChangePassword) {
    $('#pwBtn').classList.remove('hidden');
    $('#pwBtn').addEventListener('click', () => passwordChangeForm());
  }
  liveEvents({ checkin: onCheckinEvent, trip: onTripEvent }, (ok) => {
    const b = $('#liveBadge');
    b.className = `pill ${ok ? 'live' : 'offline'}`;
    b.textContent = ok ? 'Live' : 'Reconnecting';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('kiosk')) setKiosk(false); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('kiosk')) setKiosk(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && trip && !readOnly) { refreshQr(); requestWakeLock(); } });
  await loadState();
}

const notice = (iconName, tone, title, text, action = '') =>
  `<div class="card pad-lg center"><div class="status-icon ${tone}">${ICONS[iconName]}</div><h2>${esc(title)}</h2><p class="muted mt">${text}</p>${action}</div>`;

async function loadState() {
  try {
    const s = await api.get(`/api/incharge/state${scopedNumber ? `?bus=${encodeURIComponent(scopedNumber)}` : ''}`);
    state = { buses: s.buses, activeTrips: s.activeTrips, rotateSec: s.qr.rotateSec, baseUrl: s.qr.baseUrl, qrMode: s.qr.mode || 'rotating' };
    bus = s.scopedBus;
    paintHeader();
    if (!bus) {
      if (user.role === 'incharge' && user.bus_number) { location.replace(user.home); return; }
      return renderGrid();
    }
    const running = s.activeTrips.find((t) => t.bus_id === bus.id);
    if (running) return openTrip(running.id);
    renderStart();
  } catch (e) {
    if (e.code === 'WRONG_BUS_PORTAL') {
      view.innerHTML = notice('lock', 'warn', 'Not your bus', esc(e.message), `<a class="btn primary mt" href="${esc(user.home)}">Open my bus</a>`);
      return;
    }
    if (e.status === 404) {
      view.innerHTML = notice('bus', 'warn', 'Bus not found', esc(e.message), '<a class="btn mt" href="/incharge">All buses</a>');
      return;
    }
    view.innerHTML = `<div class="card"><div class="empty"><div class="big">${ICONS.alert}</div>${esc(e.message)}<div class="mt"><button class="btn" id="retry">Try again</button></div></div></div>`;
    $('#retry').addEventListener('click', loadState);
  }
}

function paintHeader() {
  const badge = $('#busBadge');
  if (bus) {
    badge.textContent = `Bus ${bus.number} · ${bus.name}`;
    badge.classList.remove('hidden');
    document.title = `Bus ${bus.number} · United University`;
  } else badge.classList.add('hidden');
  $('#allBuses').classList.toggle('hidden', !(bus && (user.role !== 'incharge' || user.bus_id == null)));
}

// ------------------------------------------------------------------ list of bus portals
async function renderGrid() {
  stopQr();
  trip = null; summary = null;
  setKiosk(false);
  const r = await api.get('/api/incharge/buses');
  const live = r.buses.filter((b) => b.trip).length;
  view.innerHTML = `
    <div class="row between wrap">
      <div><h2>Buses</h2><p class="muted small">${readOnly ? 'Open any bus to watch its boarding live.' : 'Each bus has its own portal, QR code and bus admin.'}</p></div>
      <div class="row"><span class="pill">${r.buses.length} buses</span><span class="pill ${live ? 'live' : ''}">${live} running</span></div>
    </div>
    <div class="grid auto">${r.buses.length ? r.buses.map((b) => `
      <a class="card stack portal-card" href="/bus/${encodeURIComponent(b.number)}">
        <div class="row between">
          <div class="row grow"><div class="avatar bus">${esc(b.number)}</div><div class="grow"><div class="bold truncate">${esc(b.name)}</div><div class="xs muted truncate" title="${esc(b.route || '')}">${esc(b.route || '')}</div></div></div>
          ${b.trip ? '<span class="pill live">Running</span>' : '<span class="pill">Idle</span>'}
        </div>
        <div class="row wrap xs muted">
          <span>${icon('user')} ${esc(b.incharge_name || 'No bus admin yet')}</span>
          <span>${icon('users')} ${b.students} students</span>
        </div>
        ${b.trip ? `<div class="small"><b>${b.trip.boarded}</b> of ${b.students} verified · ${directionIcon(b.trip.direction)} ${directionLabel(b.trip.direction)}</div>` : ''}
      </a>`).join('') : `<div class="card"><div class="empty"><div class="big">${ICONS.bus}</div>No buses yet. The super admin can add them under Buses &amp; stops.</div></div>`}
    </div>`;
}

// ------------------------------------------------------------------ bus with no running trip
function renderStart() {
  stopQr();
  trip = null; summary = null;
  setKiosk(false);
  const defaultDir = new Date().getHours() < 13 ? 'to_college' : 'from_college';
  const portalUrl = `${location.origin}/bus/${encodeURIComponent(bus.number)}`;
  const left = readOnly
    ? `<div class="card pad-lg stack">
        <div class="row between"><div><h2>Bus ${esc(bus.number)}</h2><p class="muted small">${esc(bus.name)}${bus.route ? ` · ${esc(bus.route)}` : ''}</p></div><div class="avatar bus lg">${esc(bus.number)}</div></div>
        <div class="empty"><div class="big">${ICONS.clock}</div>No trip is running on this bus right now. This page updates by itself when the bus admin starts one.</div>
      </div>`
    : `<div class="card pad-lg stack">
        <div class="row between"><div><h2>Bus ${esc(bus.number)}</h2><p class="muted small">${esc(bus.name)}${bus.route ? ` · ${esc(bus.route)}` : ''}</p></div><div class="avatar bus lg">${esc(bus.number)}</div></div>
        <form id="startForm" class="stack">
          <input type="hidden" name="bus_id" value="${bus.id}">
          <div class="field"><label>Trip</label>
            <div class="choice">
              <label><input type="radio" name="direction" value="to_college" ${defaultDir === 'to_college' ? 'checked' : ''}><span class="big">${ICONS.school}</span><span class="bold">To college</span><span class="xs muted">Morning pickup</span></label>
              <label><input type="radio" name="direction" value="from_college" ${defaultDir === 'from_college' ? 'checked' : ''}><span class="big">${ICONS.home}</span><span class="bold">From college</span><span class="xs muted">Evening drop</span></label>
            </div>
          </div>
          <div class="error-text" data-error hidden></div>
          <button class="btn primary lg block" type="submit">Start trip and show QR code</button>
        </form>
      </div>`;
  view.innerHTML = `
    <div class="grid cols-2">
      ${left}
      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>About this bus</h3></div>
          <div class="feed">
            <div class="feed-item"><div class="meta"><span class="name">Bus admin</span><span class="sub">${esc(bus.incharges?.length ? bus.incharges.join(', ') : 'Not assigned yet')}</span></div></div>
            <div class="feed-item"><div class="meta"><span class="name">Students registered</span><span class="sub">${bus.students}</span></div></div>
            <div class="feed-item"><div class="meta"><span class="name">Stops</span><span class="sub">${esc(bus.stops?.length ? bus.stops.join(', ') : 'None yet')}</span></div></div>
            <div class="feed-item"><div class="meta"><span class="name">Portal link</span><span class="sub mono">${esc(portalUrl)}</span></div><button class="btn sm ghost" id="copyPortal" title="Copy link">${ICONS.copy}</button></div>
          </div>
        </div>
        ${readOnly ? '' : `<div class="card soft">
          <h3>Boarding, step by step</h3>
          <ol class="small muted mt">
            <li>Start the trip and keep this screen where students can see it.</li>
            <li>Each student scans the QR with their own phone, types their name and student ID, checks the details and taps Verify.</li>
            <li>Only students registered on Bus ${esc(bus.number)} are accepted. Their names turn green on your list as they verify.</li>
            <li>End the trip once everyone is on board.</li>
          </ol>
          <p class="xs faint mt">${state.qrMode === 'day'
            ? 'The QR code stays the same for the whole day, so you can print it. If a photo of it is shared, use New QR code and the old one stops working.'
            : `The QR code changes every ${state.rotateSec} seconds and only works from this screen.`}</p>
        </div>`}
      </div>
    </div>`;
  $('#copyPortal').addEventListener('click', () => copyText(portalUrl));
  const form = $('#startForm');
  if (form) {
    formHandler(form, $('button[type=submit]', form), async (v) => {
      unlockAudio();
      const r = await api.post('/api/incharge/trips', { bus_id: Number(v.bus_id), direction: v.direction });
      toast(`Trip started on Bus ${r.trip.bus_number}`, 'success');
      await openTrip(r.trip.id);
    });
  }
}

// ------------------------------------------------------------------ running trip
async function openTrip(id) {
  try {
    summary = await api.get(`/api/incharge/trips/${id}`);
  } catch (e) { toast(e.message, 'error'); return bus ? renderStart() : renderGrid(); }
  trip = summary.trip;
  if (trip.status !== 'active') { toast('That trip has already ended', 'warn'); return loadState(); }
  renderLive();
  if (readOnly) return;
  await refreshQr();
  startRing();
  requestWakeLock();
}

function qrPanel() {
  const t = trip;
  const day = state.qrMode === 'day';
  renderedMode = state.qrMode;
  const link = `${esc(state.baseUrl.replace(/^https?:\/\//, ''))}/checkin/${esc(t.bus_number)}`;
  return `
      <div class="card qr-panel">
        <div class="row between">
          <div class="row"><span class="bold">Bus ${esc(t.bus_number)}</span><span class="pill accent">${directionIcon(t.direction)} ${directionLabel(t.direction)}</span></div>
          ${day ? '<span class="pill success" title="This code works for the whole day">Valid today</span>' : '<span class="pill outline" title="Seconds until the code changes"><span id="ringText">-</span>s</span>'}
        </div>
        <div class="qr-stage">
          <svg class="qr-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="48"/><circle class="bar" id="ringBar" cx="50" cy="50" r="48"/></svg>
          <div class="qr-paper" id="qrPaper"><div class="spinner lg"></div></div>
          <div class="qr-overlay hidden" id="qrOverlay">Reconnecting</div>
        </div>
        <div><div class="bold">Scan with your phone camera to board Bus ${esc(t.bus_number)}</div><div class="qr-caption" id="qrCaption">${day ? 'Same code all day' : `New code every ${state.rotateSec} seconds`} · ${link}</div></div>
        <div class="row wrap">
          <button class="btn sm" id="kioskBtn">${ICONS.expand}<span>Full screen</span></button>
          ${day ? `<button class="btn sm hide-kiosk" id="printBtn">${ICONS.printer}<span>Print</span></button><button class="btn sm ghost hide-kiosk" id="newQrBtn" title="Old codes for this bus stop working immediately">${ICONS.refresh}<span>New QR code</span></button>` : ''}
          <button class="btn sm ghost" id="soundBtn" title="Sound when a student verifies" aria-label="Sound on or off">${soundOn ? ICONS.bell : ICONS.bellOff}</button>
        </div>
      </div>`;
}

function renderLive() {
  const t = trip;
  const watchPanel = `
      <div class="card stack">
        <div class="row between"><div><h2>Bus ${esc(t.bus_number)}</h2><p class="muted small">${directionIcon(t.direction)} ${directionLabel(t.direction)} · started ${fmtTime(t.started_at)} by ${esc(t.incharge_name)}</p></div><div class="avatar bus lg">${esc(t.bus_number)}</div></div>
        <p class="small muted">${icon('eyeView')} You are watching this bus. The QR code is shown on the bus admin's screen.</p>
      </div>`;
  view.innerHTML = `
    <div class="live-grid">
      ${readOnly ? watchPanel : qrPanel()}
      <div class="stack">
        <div class="card">
          <div class="count-hero"><span class="n" id="countN">0</span><span class="of">of <span id="countExp">0</span> students verified</span></div>
          <div class="progress lg mt"><i id="countBar"></i></div>
          <div class="row between wrap mt small muted"><span id="flagCount"></span><span>Started ${fmtTime(t.started_at)} · ${esc(t.incharge_name)}</span></div>
          ${readOnly ? '' : `<div class="row wrap mt hide-kiosk">
            <button class="btn w" id="manualBtn">${ICONS.edit}<span>Mark a student manually</span></button>
            <button class="btn danger w" id="endBtn">${ICONS.stop}<span>End trip</span></button>
          </div>`}
        </div>
        <div class="card">
          <div class="card-title">
            <h3>Students on Bus ${esc(t.bus_number)}</h3>
            <div class="tabs" id="rosterTabs"></div>
          </div>
          <input class="input hide-kiosk" id="rosterSearch" placeholder="Find a student by name, ID or stop" autocomplete="off" value="${esc(rosterQuery)}">
          <div class="roster-list mt" id="roster"></div>
        </div>
      </div>
    </div>`;
  $('#kioskBtn')?.addEventListener('click', () => setKiosk(!document.body.classList.contains('kiosk')));
  $('#soundBtn')?.addEventListener('click', (e) => { soundOn = !soundOn; e.currentTarget.innerHTML = soundOn ? ICONS.bell : ICONS.bellOff; unlockAudio(); });
  $('#printBtn')?.addEventListener('click', () => window.print());
  $('#newQrBtn')?.addEventListener('click', newQrCode);
  $('#manualBtn')?.addEventListener('click', openManual);
  $('#endBtn')?.addEventListener('click', endTrip);
  $('#rosterSearch').addEventListener('input', debounce((e) => { rosterQuery = e.target.value.trim().toLowerCase(); paintRoster(); }, 150));
  paintCounts();
  paintRoster();
}

function paintCounts(bump = false) {
  const c = summary.counts;
  const n = $('#countN');
  if (!n) return;
  n.textContent = c.boarded;
  $('#countExp').textContent = c.expected;
  $('#countBar').style.width = `${c.expected ? Math.min(100, (c.boarded / c.expected) * 100) : 0}%`;
  $('#flagCount').innerHTML = c.flagged ? `<span class="pill warn">${c.flagged} to review</span>` : '';
  if (bump) { n.classList.remove('bump'); void n.offsetWidth; n.classList.add('bump'); }
}

/** Every student registered on the bus: verified ones (latest first) then the rest by stop. */
function rosterRows() {
  const done = summary.checkins.map((c) => ({ id: c.student_id, name: c.name, uuid: c.uuid, course: c.course, year: c.year, stop: c.stop, at: c.created_at, method: c.method, flags: c.flags, checkinId: c.id }));
  const pending = summary.notBoarded.map((s) => ({ id: s.id, name: s.name, uuid: s.uuid, course: s.course, year: s.year, stop: s.stop }));
  return { done, pending };
}

function paintRoster() {
  const box = $('#roster');
  if (!box) return;
  const { done, pending } = rosterRows();
  const tabs = [['all', `All ${done.length + pending.length}`], ['done', `Verified ${done.length}`], ['pending', `Not yet ${pending.length}`]];
  $('#rosterTabs').innerHTML = tabs.map(([k, label]) => `<button data-f="${k}" class="${rosterFilter === k ? 'active' : ''}">${label}</button>`).join('');
  $$('#rosterTabs button').forEach((b) => b.addEventListener('click', () => { rosterFilter = b.dataset.f; paintRoster(); }));
  let rows = rosterFilter === 'done' ? done : rosterFilter === 'pending' ? pending : [...done, ...pending];
  if (rosterQuery) rows = rows.filter((r) => `${r.name} ${r.uuid} ${r.stop || ''}`.toLowerCase().includes(rosterQuery));
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${rosterQuery ? 'No student matches that search.' : rosterFilter === 'done' ? 'Nobody has verified yet.' : rosterFilter === 'pending' ? 'Everyone registered on this bus has verified.' : 'No students are registered on this bus yet.'}</div>`;
    return;
  }
  box.innerHTML = rows.map((r) => {
    const isDone = !!r.at;
    const status = isDone
      ? `<span class="pill success" title="${r.method === 'manual' ? 'Marked by staff' : 'Verified by QR'}">${icon('checkCircle')} ${fmtTime(r.at)}${r.method === 'manual' ? ' · manual' : ''}</span>`
      : '<span class="pill">Not yet</span>';
    return `
      <div class="roster-row ${isDone ? 'done' : ''} ${r.checkinId && r.checkinId === lastVerifiedId ? 'new' : ''}">
        <div class="avatar">${isDone ? ICONS.check : esc(initials(r.name))}</div>
        <div class="who"><div class="name truncate">${esc(r.name)} <span class="faint xs mono">${esc(r.uuid)}</span></div>
          <div class="sub truncate">${esc([r.course, r.year].filter(Boolean).join(', '))}${r.stop ? ` · ${icon('pin')} ${esc(r.stop)}` : ''} ${flagPills(r.flags)}</div></div>
        ${status}
      </div>`;
  }).join('');
}

// ------------------------------------------------------------------ QR code
async function refreshQr() {
  if (!trip || readOnly) return;
  clearTimeout(qrTimer);
  const paper = $('#qrPaper');
  const overlay = $('#qrOverlay');
  try {
    const q = await api.get(`/api/incharge/trips/${trip.id}/qr`);
    if (!trip || !paper) return;
    state.rotateSec = q.rotateSec;
    if (q.mode && q.mode !== renderedMode) {
      // the super admin switched the QR setting: redraw for the new mode
      state.qrMode = q.mode;
      renderLive();
      return refreshQr();
    }
    paper.innerHTML = q.svg;
    paper.classList.remove('stale');
    overlay.classList.add('hidden');
    validUntil = q.validUntil || 0;
    nextRotateAt = Date.now() + q.secondsLeft * 1000;
    qrTimer = setTimeout(refreshQr, q.secondsLeft * 1000 + 120);
  } catch (e) {
    if (e.status === 410 || e.code === 'TRIP_ENDED') return onTripEnded();
    if (e.status === 403 || e.status === 404) { toast(e.message, 'error'); return loadState(); }
    paper?.classList.add('stale');
    if (overlay) { overlay.textContent = e.code === 'NETWORK' ? 'Reconnecting' : e.message; overlay.classList.remove('hidden'); }
    qrTimer = setTimeout(refreshQr, 2000);
  }
}

function startRing() {
  cancelAnimationFrame(raf);
  const C = 2 * Math.PI * 48;
  const tick = () => {
    if (!trip) return;
    const bar = $('#ringBar');
    if (bar) {
      const left = Math.max(0, nextRotateAt - Date.now());
      // whole-day code: the ring shows how much of today is left
      const frac = renderedMode === 'day'
        ? Math.max(0, Math.min(1, (validUntil - Date.now()) / 86_400_000))
        : state.rotateSec ? left / (state.rotateSec * 1000) : 0;
      bar.setAttribute('stroke-dasharray', String(C));
      bar.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
      const t = $('#ringText');
      if (t) t.textContent = Math.ceil(left / 1000);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stopQr() {
  clearTimeout(qrTimer);
  cancelAnimationFrame(raf);
  qrTimer = null;
  raf = null;
}

// ------------------------------------------------------------------ live events
function onCheckinEvent(d) {
  if (!trip) {
    if (!bus) { clearTimeout(gridRefresh); gridRefresh = setTimeout(renderGrid, 400); }
    return;
  }
  if (d.trip.id !== trip.id) return;
  if (summary.checkins.some((c) => c.id === d.checkin.id)) return;
  summary.checkins.unshift(d.checkin);
  summary.counts = d.counts;
  summary.notBoarded = summary.notBoarded.filter((s) => s.id !== d.checkin.student_id);
  lastVerifiedId = d.checkin.id;
  paintCounts(true);
  paintRoster();
  toast(`${d.checkin.name} verified${d.checkin.stop ? ` (${d.checkin.stop})` : ''}`, 'success', 2500);
  if (d.checkin.flags && d.checkin.flags !== 'manual') toast(`${d.checkin.name}: ${d.checkin.flags.replace(/_/g, ' ').replace(/,/g, ', ')}`, 'warn', 4500);
  beep();
}

function onTripEvent(d) {
  if (trip && d.trip.id === trip.id && d.type === 'ended') return onTripEnded(d.trip);
  if (trip) return;
  if (bus) { if (d.trip.bus_id === bus.id) loadState(); return; }
  clearTimeout(gridRefresh);
  gridRefresh = setTimeout(renderGrid, 300);
}

function onTripEnded(t) {
  if (!trip) return;
  const boarded = t?.counts?.boarded ?? summary?.counts?.boarded ?? 0;
  toast(`Trip on Bus ${trip.bus_number} ended. ${boarded} verified.`, 'success', 5000);
  stopQr();
  trip = null;
  loadState();
}

async function endTrip() {
  const c = summary.counts;
  const ok = await confirmDialog(`End the trip on Bus ${trip.bus_number}? ${c.boarded} of ${c.expected} students have verified. The QR code stops working straight away.`, { title: 'End trip', okText: 'End trip', danger: true });
  if (!ok) return;
  try {
    const id = trip.id;
    stopQr();
    const r = await api.post(`/api/incharge/trips/${id}/end`);
    trip = null;
    toast(`Trip ended. ${r.trip.counts.boarded} verified.`, 'success');
    loadState();
  } catch (e) { toast(e.message, 'error'); if (trip) refreshQr(); }
}

async function newQrCode() {
  const ok = await confirmDialog(`Make a new QR code for Bus ${trip.bus_number}? The current one stops working straight away, including printed copies and photos of it. Students who already verified are not affected.`, { title: 'New QR code', okText: 'Make new code' });
  if (!ok) return;
  try {
    await api.post(`/api/incharge/trips/${trip.id}/new-qr`);
    toast('New QR code is showing. Reprint it if you use a paper copy.', 'success');
    refreshQr();
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ manual check-in
function openManual() {
  const m = modal({
    title: `Mark a student manually · Bus ${trip.bus_number}`,
    body: `
      <p class="muted small">Only for a student who can't scan (flat battery, no data). It is saved as marked by you.</p>
      <div class="field"><label>Find the student</label><input class="input" id="mSearch" placeholder="Name or student ID" autocomplete="off"></div>
      <div id="mResults"></div>
      <form id="mForm" class="stack hidden">
        <div class="feed-item" id="mPicked"></div>
        <div class="field"><label>Reason (optional)</label><input class="input" name="note" maxlength="200" placeholder="e.g. phone battery dead"></div>
        <div class="error-text" data-error hidden></div>
        <button class="btn primary block" type="submit">Mark as verified</button>
      </form>`,
  });
  const search = $('#mSearch', m.root);
  const results = $('#mResults', m.root);
  const form = $('#mForm', m.root);
  let picked = null;
  const doSearch = debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    try {
      const r = await api.get(`/api/incharge/students/search?q=${encodeURIComponent(q)}&bus=${trip.bus_id}`);
      results.innerHTML = r.items.length ? `<div class="feed">${r.items.map((s) => `
        <button class="feed-item" data-uuid="${esc(s.uuid)}" data-name="${esc(s.name)}">
          <div class="avatar">${esc(initials(s.name))}</div>
          <div class="meta"><span class="name">${esc(s.name)}</span><span class="sub"><span class="mono">${esc(s.uuid)}</span>${s.stop ? ` · ${esc(s.stop)}` : ''}</span></div>
        </button>`).join('')}</div>` : `<div class="empty small">No student on Bus ${esc(trip.bus_number)} matches that.</div>`;
      $$('[data-uuid]', results).forEach((b) => b.addEventListener('click', () => {
        picked = { uuid: b.dataset.uuid, name: b.dataset.name };
        $('#mPicked', m.root).innerHTML = `<div class="avatar">${esc(initials(picked.name))}</div><div class="meta"><span class="name">${esc(picked.name)}</span><span class="sub mono">${esc(picked.uuid)}</span></div>`;
        form.classList.remove('hidden');
        results.innerHTML = '';
        search.value = '';
      }));
    } catch (e) { results.innerHTML = `<div class="error-text">${esc(e.message)}</div>`; }
  }, 220);
  search.addEventListener('input', doSearch);
  formHandler(form, $('button[type=submit]', form), async (v) => {
    if (!picked) throw new Error('Pick a student first');
    await api.post(`/api/incharge/trips/${trip.id}/manual`, { uuid: picked.uuid, note: v.note });
    toast(`${picked.name} marked as verified`, 'success');
    m.close();
  });
}

// ------------------------------------------------------------------ full screen, screen wake, sound
function setKiosk(on) {
  document.body.classList.toggle('kiosk', on);
  const btn = $('#kioskBtn');
  if (btn) btn.innerHTML = `${ICONS.expand}<span>${on ? 'Exit full screen' : 'Full screen'}</span>`;
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch { /* ignore */ }
}

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator) || document.hidden) return;
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or denied */ }
}

function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch { /* ignore */ }
}
function beep() {
  if (!soundOn || !audioCtx || readOnly) return;
  try {
    const t0 = audioCtx.currentTime;
    [[880, 0], [1320, 0.09]].forEach(([f, dt]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.18);
    });
  } catch { /* ignore */ }
}
