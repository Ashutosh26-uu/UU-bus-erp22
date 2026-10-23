import {
  $, $$, api, esc, toast, modal, confirmDialog, formHandler, theme, liveEvents, fmtTime, initials,
  directionLabel, directionIcon, flagPills, requireStaff, logout, passwordChangeForm, debounce, ICONS,
} from './common.js';

const view = $('#view');
let user = null;
let state = { buses: [], activeTrips: [], rotateSec: 20, baseUrl: '' };
let trip = null;
let summary = null;
let qrTimer = null;
let raf = null;
let nextRotateAt = 0;
let wakeLock = null;
let soundOn = true;
let audioCtx = null;

init();

async function init() {
  user = await requireStaff(['incharge', 'admin']);
  if (!user) return;
  $('#userName').textContent = user.name;
  theme.button($('#themeBtn'));
  $('#logoutBtn').innerHTML = `${ICONS.logout}<span>Sign out</span>`;
  $('#logoutBtn').addEventListener('click', logout);
  $('#pwBtn').addEventListener('click', () => passwordChangeForm());
  liveEvents({ checkin: onCheckinEvent, trip: onTripEvent }, (ok) => {
    const b = $('#liveBadge');
    b.className = `pill ${ok ? 'live' : 'offline'}`;
    b.textContent = ok ? 'Live' : 'Reconnecting…';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('kiosk')) setKiosk(false); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('kiosk')) setKiosk(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (trip) refreshQr(); requestWakeLock(); } });
  await loadState();
}

async function loadState() {
  try {
    const s = await api.get('/api/incharge/state');
    state = { buses: s.buses, activeTrips: s.activeTrips, rotateSec: s.qr.rotateSec, baseUrl: s.qr.baseUrl };
    const mine = s.activeTrips.find((t) => t.incharge_id === user.id) || (s.activeTrips.length === 1 && user.role !== 'admin' ? s.activeTrips[0] : null);
    if (mine) return openTrip(mine.id);
    renderStart();
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="empty"><div class="big">⚠️</div>${esc(e.message)}<div class="mt"><button class="btn" id="retry">Retry</button></div></div></div>`;
    $('#retry').addEventListener('click', loadState);
  }
}

// ------------------------------------------------------------------ start screen
function renderStart() {
  stopQr();
  trip = null; summary = null;
  setKiosk(false);
  const hour = new Date().getHours();
  const defaultDir = hour < 13 ? 'to_college' : 'from_college';
  const busOpts = state.buses.map((b) => `<option value="${b.id}">Bus ${esc(b.number)} · ${esc(b.name)}${b.route ? ` — ${esc(b.route)}` : ''}</option>`).join('');
  view.innerHTML = `
    <div class="grid cols-2">
      <div class="card pad-lg stack">
        <div><h2>Start a trip</h2><p class="muted small">The QR screen appears the moment you start. Students scan it with their phone camera.</p></div>
        ${state.buses.length ? `
        <form id="startForm" class="stack">
          <div class="field"><label>Bus</label><select class="input lg" name="bus_id" required>${busOpts}</select></div>
          <div class="field"><label>Direction</label>
            <div class="choice">
              <label><input type="radio" name="direction" value="to_college" ${defaultDir === 'to_college' ? 'checked' : ''}><span class="big">🏫</span><span class="bold">To college</span><span class="xs muted">Morning pickup</span></label>
              <label><input type="radio" name="direction" value="from_college" ${defaultDir === 'from_college' ? 'checked' : ''}><span class="big">🏠</span><span class="bold">From college</span><span class="xs muted">Evening drop</span></label>
            </div>
          </div>
          <div class="error-text" data-error hidden></div>
          <button class="btn primary lg block" type="submit">Start trip &amp; show QR</button>
        </form>` : '<div class="empty">No bus is assigned to you yet. Ask the admin.</div>'}
      </div>
      <div class="stack">
        ${state.activeTrips.length ? `
        <div class="card">
          <div class="card-title"><h3>Running trips</h3><span class="pill live">Live</span></div>
          <div class="stack">${state.activeTrips.map((t) => `
            <button class="feed-item as-btn" data-open="${t.id}">
              <div class="avatar">${esc(t.bus_number)}</div>
              <div class="meta"><span class="name">Bus ${esc(t.bus_number)} · ${directionLabel(t.direction)}</span>
              <span class="sub">${esc(t.incharge_name)} · started ${fmtTime(t.started_at)} · ${t.counts.boarded}/${t.counts.expected} boarded</span></div>
              <span class="time">Open →</span>
            </button>`).join('')}
          </div>
        </div>` : ''}
        <div class="card soft">
          <h3>How it works</h3>
          <ol class="small muted mt">
            <li>Start the trip and keep this screen visible on the bus.</li>
            <li>Each student scans the QR with their <b>own</b> phone and confirms their details.</li>
            <li>You see the count and names update live. Flags show anything unusual.</li>
            <li>End the trip when everyone has boarded.</li>
          </ol>
          <p class="xs faint mt">The QR changes every ${state.rotateSec}s and only works from the live screen. Screenshots and forwarded links expire immediately, and each phone can board only one student.</p>
        </div>
      </div>
    </div>`;
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openTrip(Number(b.dataset.open))));
  const form = $('#startForm');
  if (form) {
    formHandler(form, $('button[type=submit]', form), async (v) => {
      unlockAudio();
      const r = await api.post('/api/incharge/trips', { bus_id: Number(v.bus_id), direction: v.direction });
      toast(`Trip started for bus ${r.trip.bus_number}`, 'success');
      await openTrip(r.trip.id);
    });
  }
}

// ------------------------------------------------------------------ live screen
async function openTrip(id) {
  try {
    summary = await api.get(`/api/incharge/trips/${id}`);
  } catch (e) { toast(e.message, 'error'); return renderStart(); }
  trip = summary.trip;
  if (trip.status !== 'active') { toast('That trip has already ended', 'warn'); return loadState(); }
  renderLive();
  await refreshQr();
  startRing();
  requestWakeLock();
}

function renderLive() {
  const t = trip;
  view.innerHTML = `
    <div class="live-grid">
      <div class="card qr-panel">
        <div class="row between" data-full>
          <div class="row"><span class="pill live">Live</span><span class="bold">Bus ${esc(t.bus_number)}</span><span class="pill accent">${directionIcon(t.direction)} ${directionLabel(t.direction)}</span></div>
          <span class="pill outline" title="Seconds until the QR changes">↻ <span id="ringText">—</span>s</span>
        </div>
        <div class="qr-stage">
          <svg class="qr-ring" viewBox="0 0 100 100" aria-hidden="true">
            <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>
            <circle class="track" cx="50" cy="50" r="48"/>
            <circle class="bar" id="ringBar" cx="50" cy="50" r="48"/>
          </svg>
          <div class="qr-paper" id="qrPaper"><div class="spinner lg"></div></div>
          <div class="qr-overlay hidden" id="qrOverlay">Reconnecting…</div>
        </div>
        <div><div class="bold">Scan with your phone camera to board</div><div class="qr-caption">New code every ${state.rotateSec}s · ${esc(state.baseUrl.replace(/^https?:\/\//, ''))}</div></div>
        <div class="row">
          <button class="btn sm" id="kioskBtn">${ICONS.expand}<span>Full screen</span></button>
          <button class="btn sm ghost" id="soundBtn" title="Sound on new boarding">${soundOn ? '🔔' : '🔕'}</button>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="count-hero"><span class="n" id="countN">0</span><span class="of">/ <span id="countExp">0</span> boarded</span></div>
          <div class="progress lg mt"><i id="countBar"></i></div>
          <div class="row between mt small muted"><span id="flagCount"></span><span>Started ${fmtTime(t.started_at)} · ${esc(t.incharge_name)}</span></div>
          <div class="row wrap mt hide-kiosk">
            <button class="btn" id="manualBtn">${ICONS.edit}<span>Manual check-in</span></button>
            <button class="btn danger" id="endBtn">${ICONS.stop}<span>End trip</span></button>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h3>Recently boarded</h3><span class="pill" id="recentCount"></span></div>
          <div class="feed" id="feed"></div>
        </div>
        <div class="card hide-kiosk">
          <div class="card-title"><h3>Not boarded yet</h3><span class="pill warn" id="nbCount"></span></div>
          <div id="nbList" class="small"></div>
        </div>
      </div>
    </div>`;
  $('#kioskBtn').addEventListener('click', () => setKiosk(!document.body.classList.contains('kiosk')));
  $('#soundBtn').addEventListener('click', (e) => { soundOn = !soundOn; e.currentTarget.textContent = soundOn ? '🔔' : '🔕'; unlockAudio(); });
  $('#manualBtn').addEventListener('click', openManual);
  $('#endBtn').addEventListener('click', endTrip);
  paintCounts();
  paintFeed();
  paintNotBoarded();
}

function paintCounts(bump = false) {
  const c = summary.counts;
  const n = $('#countN');
  if (!n) return;
  n.textContent = c.boarded;
  $('#countExp').textContent = c.expected;
  $('#countBar').style.width = `${c.expected ? Math.min(100, (c.boarded / c.expected) * 100) : 0}%`;
  $('#flagCount').innerHTML = c.flagged ? `<span class="pill warn">${c.flagged} flagged</span>` : '<span class="pill success">No flags</span>';
  $('#recentCount').textContent = summary.checkins.length;
  if (bump) { n.classList.remove('bump'); void n.offsetWidth; n.classList.add('bump'); }
}

const feedItem = (c, isNew = false) => `
  <div class="feed-item ${isNew ? 'new' : ''}" data-id="${c.id}">
    <div class="avatar">${esc(initials(c.name))}</div>
    <div class="meta">
      <span class="name">${esc(c.name)} <span class="faint xs mono">${esc(c.uuid)}</span></span>
      <span class="sub">${esc([c.course, c.year].filter(Boolean).join(' · '))}${c.stop ? ` · 📍 ${esc(c.stop)}` : ''} ${flagPills(c.flags)}</span>
    </div>
    <span class="time">${fmtTime(c.created_at)}</span>
  </div>`;

function paintFeed() {
  const feed = $('#feed');
  if (!feed) return;
  const items = summary.checkins.slice(0, 30);
  feed.innerHTML = items.length ? items.map((c) => feedItem(c)).join('') : '<div class="empty"><div class="big">🪪</div>Waiting for the first scan…</div>';
}

function paintNotBoarded() {
  const nb = $('#nbList');
  if (!nb) return;
  $('#nbCount').textContent = summary.notBoarded.length;
  nb.innerHTML = summary.notBoarded.length
    ? `<div class="row wrap">${summary.notBoarded.map((s) => `<span class="pill outline" title="${esc(s.uuid)}${s.stop ? ` · ${esc(s.stop)}` : ''}">${esc(s.name)}</span>`).join('')}</div>`
    : '<div class="empty">Everyone assigned to this bus has boarded 🎉</div>';
}

// ------------------------------------------------------------------ QR rotation
async function refreshQr() {
  if (!trip) return;
  clearTimeout(qrTimer);
  const paper = $('#qrPaper');
  const overlay = $('#qrOverlay');
  try {
    const q = await api.get(`/api/incharge/trips/${trip.id}/qr`);
    if (!trip) return;
    paper.innerHTML = q.svg;
    paper.classList.remove('stale');
    overlay.classList.add('hidden');
    state.rotateSec = q.rotateSec;
    nextRotateAt = Date.now() + q.secondsLeft * 1000;
    qrTimer = setTimeout(refreshQr, q.secondsLeft * 1000 + 120);
  } catch (e) {
    if (e.status === 410 || e.code === 'TRIP_ENDED') return onTripEnded();
    if (e.status === 403 || e.status === 404) { toast(e.message, 'error'); return loadState(); }
    paper?.classList.add('stale');
    if (overlay) { overlay.textContent = e.code === 'NETWORK' ? 'Reconnecting…' : e.message; overlay.classList.remove('hidden'); }
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
      const frac = state.rotateSec ? left / (state.rotateSec * 1000) : 0;
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

// ------------------------------------------------------------------ events
function onCheckinEvent(d) {
  if (!trip || d.trip.id !== trip.id) return;
  if (summary.checkins.some((c) => c.id === d.checkin.id)) return;
  summary.checkins.unshift(d.checkin);
  summary.counts = d.counts;
  summary.notBoarded = summary.notBoarded.filter((s) => s.id !== d.checkin.student_id);
  const feed = $('#feed');
  if (feed) {
    if ($('.empty', feed)) feed.innerHTML = '';
    feed.insertAdjacentHTML('afterbegin', feedItem(d.checkin, true));
    while (feed.children.length > 30) feed.lastElementChild.remove();
  }
  paintCounts(true);
  paintNotBoarded();
  if (d.checkin.flags) toast(`${d.checkin.name}: ${d.checkin.flags.replace(/_/g, ' ').replace(/,/g, ', ')}`, 'warn', 4500);
  beep();
}

function onTripEvent(d) {
  if (trip && d.trip.id === trip.id && d.type === 'ended') return onTripEnded(d.trip);
  if (!trip) loadState();
}

function onTripEnded(t) {
  if (!trip) return;
  const boarded = t?.counts?.boarded ?? summary?.counts?.boarded ?? 0;
  toast(`Trip for bus ${trip.bus_number} ended · ${boarded} boarded`, 'success', 5000);
  stopQr();
  trip = null;
  loadState();
}

async function endTrip() {
  const c = summary.counts;
  const ok = await confirmDialog(`End the trip for bus ${trip.bus_number}? ${c.boarded} of ${c.expected} students have boarded. The QR stops working immediately.`, { title: 'End trip', okText: 'End trip', danger: true });
  if (!ok) return;
  try {
    const id = trip.id;
    stopQr();
    const r = await api.post(`/api/incharge/trips/${id}/end`);
    trip = null;
    toast(`Trip ended · ${r.trip.counts.boarded} boarded`, 'success');
    loadState();
  } catch (e) { toast(e.message, 'error'); if (trip) refreshQr(); }
}

// ------------------------------------------------------------------ manual check-in
function openManual() {
  const m = modal({
    title: 'Manual check-in',
    body: `
      <p class="muted small">Use only when a student cannot scan (dead phone, no data). It is recorded as <b>manual</b> with your name.</p>
      <div class="field"><label>Search student</label><div class="input-wrap"><input class="input" id="mSearch" placeholder="Name or student ID" autocomplete="off"></div></div>
      <div id="mResults" class="stack"></div>
      <form id="mForm" class="stack hidden">
        <div class="feed-item" id="mPicked"></div>
        <div class="field"><label>Reason (optional)</label><input class="input" name="note" maxlength="200" placeholder="e.g. phone battery dead"></div>
        <div class="error-text" data-error hidden></div>
        <button class="btn primary block" type="submit">Mark as boarded</button>
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
      const r = await api.get(`/api/incharge/students/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = r.items.length ? r.items.map((s) => `
        <button class="feed-item as-btn" data-uuid="${esc(s.uuid)}" data-name="${esc(s.name)}" data-stop="${esc(s.stop || '')}">
          <div class="avatar">${esc(initials(s.name))}</div>
          <div class="meta"><span class="name">${esc(s.name)}</span><span class="sub mono">${esc(s.uuid)} · ${s.bus_number ? `Bus ${esc(s.bus_number)}` : 'no bus'}${s.stop ? ` · ${esc(s.stop)}` : ''}</span></div>
        </button>`).join('') : '<div class="empty small">No student found</div>';
      $$('[data-uuid]', results).forEach((b) => b.addEventListener('click', () => {
        picked = { uuid: b.dataset.uuid, name: b.dataset.name, stop: b.dataset.stop };
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
    toast(`${picked.name} marked as boarded`, 'success');
    m.close();
  });
}

// ------------------------------------------------------------------ kiosk, wake lock, sound
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
  if (!soundOn || !audioCtx) return;
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
