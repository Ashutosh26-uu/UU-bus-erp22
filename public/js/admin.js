import {
  $, $$, api, el, esc, toast, modal, confirmDialog, formHandler, formValues, theme, liveEvents,
  fmtTime, fmtDate, fmtDateTime, fmtRel, todayIso, initials, directionLabel, directionIcon, flagPills,
  requireStaff, logout, passwordChangeForm, copyText, debounce, ICONS, icon,
} from './common.js';

const ROLE_OPTIONS = [['incharge', 'Bus admin'], ['operator', 'Operations admin'], ['admin', 'Super admin']];
const roleLabel = (r) => (ROLE_OPTIONS.find(([k]) => k === r) || [r, r])[1];

const content = $('#content');
let user = null;
let current = 'dashboard';
let busCache = null;
let openTripId = null;
let dash = null;

const PAGES = {
  dashboard: { title: 'Dashboard', icon: 'dashboard', render: renderDashboard },
  students: { title: 'Students', icon: 'students', render: renderStudents },
  buses: { title: 'Buses & stops', icon: 'bus', render: renderBuses },
  staff: { title: 'Staff', icon: 'staff', render: renderStaff, superOnly: true },
  trips: { title: 'Trips', icon: 'trips', render: renderTrips },
  flags: { title: 'Flags', icon: 'flag', render: renderFlags },
  audit: { title: 'Audit log', icon: 'audit', render: renderAudit, superOnly: true },
  settings: { title: 'Settings', icon: 'settings', render: renderSettings, superOnly: true },
};
const allowed = (key) => PAGES[key] && (!PAGES[key].superOnly || user?.role === 'admin');

init();

async function init() {
  user = await requireStaff(['admin', 'operator']);
  if (!user) return;
  $('#meName').textContent = user.name;
  $('#meRole').textContent = user.roleLabel;
  $('#meAvatar').textContent = initials(user.name);
  theme.button($('#themeBtn'));
  $('#menuBtn').innerHTML = ICONS.menu;
  $('#logoutBtn').innerHTML = ICONS.logout;
  $('#logoutBtn').addEventListener('click', logout);
  if (user.canChangePassword) {
    $('#pwBtn').classList.remove('hidden');
    $('#pwBtn').addEventListener('click', () => passwordChangeForm());
  }
  $('#menuBtn').addEventListener('click', () => toggleSidebar(true));
  $('#scrim').addEventListener('click', () => toggleSidebar(false));
  $('#nav').innerHTML = Object.entries(PAGES).filter(([k]) => allowed(k)).map(([k, p]) => `<a href="#${k}" data-page="${k}">${ICONS[p.icon]}<span>${p.title}</span>${k === 'dashboard' ? '<span class="count hidden" id="liveCount"></span>' : ''}</a>`).join('');
  liveEvents({ checkin: onCheckin, trip: onTrip }, (ok) => {
    const b = $('#liveBadge');
    b.className = `pill ${ok ? 'live' : 'offline'}`;
    b.textContent = ok ? 'Live' : 'Reconnecting…';
  });
  window.addEventListener('hashchange', route);
  route();
}

function toggleSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').classList.toggle('hidden', !open);
}

async function route() {
  const key = (location.hash || '#dashboard').slice(1).split('/')[0];
  current = allowed(key) ? key : 'dashboard';
  const p = PAGES[current];
  $('#pageTitle').textContent = p.title;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === current));
  toggleSidebar(false);
  content.innerHTML = '<div class="card"><div class="skeleton"></div><div class="skeleton mt"></div><div class="skeleton mt"></div></div>';
  try { await p.render(); } catch (e) { content.innerHTML = `<div class="card"><div class="empty"><div class="big">${ICONS.alert}</div>${esc(e.message)}</div></div>`; }
}

const busesList = async (force = false) => { if (!busCache || force) busCache = (await api.get('/api/admin/buses')).buses; return busCache; };
const busOptions = (buses, selected) => `<option value="">— none —</option>${buses.filter((b) => b.active || b.id === selected).map((b) => `<option value="${b.id}" ${b.id === selected ? 'selected' : ''}>Bus ${esc(b.number)} · ${esc(b.name)}</option>`).join('')}`;
const stopOptions = (bus, selected) => `<option value="">— none —</option>${(bus?.stops || []).map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
const table = (head, rows, empty = 'Nothing here yet') => `<div class="table-wrap"><table class="table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}"><div class="empty">${empty}</div></td></tr>`}</tbody></table></div>`;

// ------------------------------------------------------------------ live events
function onCheckin(d) {
  if (d.checkin.flags) toast(`${d.checkin.name} boarded bus ${d.trip.bus_number} · ${d.checkin.flags.replace(/_/g, ' ').replace(/,/g, ', ')}`, 'warn', 5000);
  if (current === 'dashboard' && dash) {
    bumpTile('todayBoarded', 1);
    if (d.checkin.flags) bumpTile('todayFlagged', 1);
    const card = $(`[data-trip-card="${d.trip.id}"]`);
    if (card) paintTripCard(card, d.counts);
    const feed = $('#dashFeed');
    if (feed) {
      if ($('.empty', feed)) feed.innerHTML = '';
      feed.insertAdjacentHTML('afterbegin', feedRow({ ...d.checkin, bus_number: d.trip.bus_number, direction: d.trip.direction }, true));
      while (feed.children.length > 40) feed.lastElementChild.remove();
    }
  }
  if (openTripId === d.trip.id) refreshTripModal(openTripId);
}
function onTrip(d) {
  toast(`Bus ${d.trip.bus_number}: trip ${d.type} (${directionLabel(d.trip.direction)})`, d.type === 'started' ? 'info' : 'success');
  if (current === 'dashboard') renderDashboard();
  if (openTripId === d.trip.id) refreshTripModal(openTripId);
}
function bumpTile(key, delta) {
  const v = $(`[data-tile="${key}"] .v`);
  if (!v) return;
  v.textContent = Number(v.textContent) + delta;
  v.classList.remove('bump'); void v.offsetWidth; v.classList.add('bump');
}

// ------------------------------------------------------------------ dashboard
const feedRow = (c, isNew = false) => `
  <div class="feed-item ${isNew ? 'new' : ''}">
    <div class="avatar">${esc(initials(c.name))}</div>
    <div class="meta">
      <span class="name">${esc(c.name)} <span class="faint xs mono">${esc(c.uuid)}</span></span>
      <span class="sub">Bus ${esc(c.bus_number)} · ${directionLabel(c.direction)}${c.stop ? ` · ${icon('pin')} ${esc(c.stop)}` : ''} ${flagPills(c.flags)}</span>
    </div>
    <span class="time">${fmtTime(c.created_at)}</span>
  </div>`;

function paintTripCard(card, counts) {
  $('[data-boarded]', card).textContent = counts.boarded;
  $('[data-expected]', card).textContent = counts.expected;
  $('.progress > i', card).style.width = `${counts.expected ? Math.min(100, (counts.boarded / counts.expected) * 100) : 0}%`;
  const f = $('[data-flagged]', card);
  f.textContent = counts.flagged ? `${counts.flagged} flagged` : 'No flags';
  f.className = `pill ${counts.flagged ? 'warn' : 'success'}`;
}

async function renderDashboard() {
  const d = await api.get('/api/admin/dashboard');
  dash = d;
  const lc = $('#liveCount');
  lc.textContent = d.activeTrips.length;
  lc.classList.toggle('hidden', !d.activeTrips.length);
  const tiles = [
    ['todayBoarded', 'Boarded today', d.stats.todayBoarded, `${d.stats.todayTrips} trips today`, 'accent'],
    ['activeTrips', 'Live trips', d.activeTrips.length, 'running right now'],
    ['todayFlagged', 'Flagged today', d.stats.todayFlagged, 'need a look'],
    ['students', 'Students', d.stats.students, `${d.stats.buses} buses · ${d.stats.incharges} bus admins`],
  ];
  content.innerHTML = `
    <div class="grid auto">${tiles.map(([k, label, v, sub, cls]) => `<div class="card stat ${cls || ''}" data-tile="${k}"><span class="k">${label}</span><span class="v">${v}</span><span class="sub">${sub}</span></div>`).join('')}</div>
    <div class="grid cols-2">
      <div class="stack">
        <div class="card-title"><h2>Live trips</h2><span class="pill live">${d.activeTrips.length} running</span></div>
        <div class="stack" id="tripCards">${d.activeTrips.length ? d.activeTrips.map((t) => `
          <div class="card" data-trip-card="${t.id}">
            <div class="row between">
              <div class="row"><div class="avatar bus">${esc(t.bus_number)}</div><div><div class="bold">Bus ${esc(t.bus_number)} · ${directionIcon(t.direction)} ${directionLabel(t.direction)}</div><div class="xs muted">${esc(t.incharge_name)} · started ${fmtTime(t.started_at)}</div></div></div>
              <span class="pill success" data-flagged></span>
            </div>
            <div class="row between mt"><span class="bold"><span data-boarded>0</span> of <span data-expected>0</span> verified</span><span class="row"><a class="btn sm ghost" href="/bus/${encodeURIComponent(t.bus_number)}" target="_blank" rel="noopener">Open bus</a><button class="btn sm" data-open-trip="${t.id}">Details</button><button class="btn sm danger w" data-end-trip="${t.id}">End</button></span></div>
            <div class="progress mt"><i></i></div>
          </div>`).join('') : `<div class="card"><div class="empty"><div class="big">${ICONS.bus}</div>No trip is running. Bus admins start trips from their bus portal.</div></div>`}
        </div>
      </div>
      <div class="stack">
        <div class="card-title"><h2>Live feed</h2><span class="xs muted">today</span></div>
        <div class="card"><div class="feed" id="dashFeed">${d.recent.length ? d.recent.map((c) => feedRow(c)).join('') : `<div class="empty"><div class="big">${ICONS.idcard}</div>No students have verified yet today</div>`}</div></div>
      </div>
    </div>`;
  d.activeTrips.forEach((t) => paintTripCard($(`[data-trip-card="${t.id}"]`), { boarded: t.boarded, expected: t.expected, flagged: t.flagged }));
  $$('[data-open-trip]').forEach((b) => b.addEventListener('click', () => openTripModal(Number(b.dataset.openTrip))));
  $$('[data-end-trip]').forEach((b) => b.addEventListener('click', () => endTripAdmin(Number(b.dataset.endTrip))));
}

async function endTripAdmin(id) {
  if (!(await confirmDialog('End this trip now? The QR stops working immediately.', { title: 'End trip', okText: 'End trip', danger: true }))) return;
  try { await api.post(`/api/admin/trips/${id}/end`); toast('Trip ended', 'success'); } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ students
const studentsState = { q: '', bus: '', page: 1 };
async function renderStudents() {
  const buses = await busesList();
  content.innerHTML = `
    <div class="card">
      <div class="row wrap between">
        <div class="row wrap grow">
          <div class="input-wrap grow"><input class="input" id="sq" placeholder="Search name, ID or course…" value="${esc(studentsState.q)}"></div>
          <select class="input" id="sbus"><option value="">All buses</option><option value="none" ${studentsState.bus === 'none' ? 'selected' : ''}>No bus</option>${buses.map((b) => `<option value="${b.id}" ${String(b.id) === studentsState.bus ? 'selected' : ''}>Bus ${esc(b.number)}</option>`).join('')}</select>
        </div>
        <div class="row wrap">
          <a class="btn w" href="/api/admin/students/export.csv">${ICONS.download}<span>Export</span></a>
          <button class="btn w" id="importBtn">${ICONS.upload}<span>Import CSV</span></button>
          <button class="btn ghost w" id="demoAdd" title="About 6 dummy students per bus, IDs like DEMO-12-1">Add demo students</button>
          <button class="btn ghost w" id="demoRemove" title="Delete every DEMO- student and their boardings">Remove demo</button>
          <button class="btn primary w" id="addStudent">${ICONS.plus}<span>Add student</span></button>
        </div>
      </div>
    </div>
    <div id="studentsTable"></div>
    <div class="row between" id="studentsPager"></div>`;
  $('#sq').addEventListener('input', debounce((e) => { studentsState.q = e.target.value; studentsState.page = 1; loadStudents(); }, 250));
  $('#sbus').addEventListener('change', (e) => { studentsState.bus = e.target.value; studentsState.page = 1; loadStudents(); });
  $('#addStudent').addEventListener('click', () => studentForm());
  $('#importBtn').addEventListener('click', importDialog);
  $('#demoAdd').addEventListener('click', async () => {
    if (!(await confirmDialog('Add about 6 dummy students to every bus? Their IDs start with DEMO- (for example DEMO-12-1) so they never clash with real students, and "Remove demo" deletes them again.', { title: 'Add demo students', okText: 'Add' }))) return;
    try {
      const r = await api.post('/api/admin/demo-students', { perBus: 6 });
      toast(r.inserted ? `${r.inserted} demo students added across ${r.buses} buses. Try ID DEMO-1-1 on a bus 1 check-in.` : 'Demo students already exist', 'success', 6000);
      loadStudents();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#demoRemove').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete every demo student (IDs starting with DEMO-) together with their boardings? Real students are not touched.', { title: 'Remove demo students', okText: 'Remove', danger: true }))) return;
    try { const r = await api.del('/api/admin/demo-students'); toast(`${r.removed} demo students removed`, 'success'); loadStudents(); } catch (e) { toast(e.message, 'error'); }
  });
  $('#studentsTable').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = studentsState.items.find((x) => x.id === Number(b.dataset.id));
    if (!s) return;
    if (b.dataset.act === 'edit') studentForm(s);
    if (b.dataset.act === 'history') studentHistory(s);
    if (b.dataset.act === 'del' && (await confirmDialog(`Delete ${s.name} (${s.uuid})? Students with boarding history are deactivated instead of removed.`, { okText: 'Delete', danger: true }))) {
      try { const res = await api.del(`/api/admin/students/${s.id}`); toast(res.deactivated ? 'Student deactivated (history kept)' : 'Student deleted', 'success'); loadStudents(); } catch (err) { toast(err.message, 'error'); }
    }
  });
  await loadStudents();
}

async function loadStudents() {
  const { q, bus, page } = studentsState;
  const r = await api.get(`/api/admin/students?q=${encodeURIComponent(q)}&bus=${encodeURIComponent(bus)}&page=${page}&limit=50`);
  studentsState.items = r.items;
  const rows = r.items.map((s) => `
    <tr>
      <td class="mono nowrap">${esc(s.uuid)}</td>
      <td><div class="bold">${esc(s.name)}</div>${s.phone ? `<div class="xs muted">${esc(s.phone)}</div>` : ''}</td>
      <td>${esc(s.course || '—')}${s.year ? ` <span class="muted">· ${esc(s.year)}</span>` : ''}${s.specialization ? `<div class="xs muted">${esc(s.specialization)}</div>` : ''}</td>
      <td>${s.bus_number ? `<span class="pill accent">Bus ${esc(s.bus_number)}</span>` : '<span class="faint">—</span>'}</td>
      <td>${esc(s.stop_name || '—')}</td>
      <td>${s.active ? '<span class="pill success">Active</span>' : '<span class="pill">Inactive</span>'}</td>
      <td class="actions">
        <button class="btn icon sm ghost" data-act="history" data-id="${s.id}" title="Boarding history & devices">${ICONS.history}</button>
        <button class="btn icon sm ghost w" data-act="edit" data-id="${s.id}" title="Edit">${ICONS.edit}</button>
        <button class="btn icon sm ghost w" data-act="del" data-id="${s.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>`);
  $('#studentsTable').innerHTML = table(['Student ID', 'Name', 'Course / Year', 'Bus', 'Stop', 'Status', ''], rows, 'No students match. Add one or import a CSV.');
  const pages = Math.max(1, Math.ceil(r.total / r.limit));
  $('#studentsPager').innerHTML = `<span class="small muted">${r.total} student${r.total === 1 ? '' : 's'}</span><span class="row"><button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button><span class="small">Page ${page} of ${pages}</span><button class="btn sm" id="next" ${page >= pages ? 'disabled' : ''}>Next</button></span>`;
  $('#prev').addEventListener('click', () => { studentsState.page--; loadStudents(); });
  $('#next').addEventListener('click', () => { studentsState.page++; loadStudents(); });
}

async function studentForm(s = null) {
  const buses = await busesList();
  const m = modal({
    title: s ? `Edit ${s.name}` : 'Add student',
    body: `
      <form id="stuForm" class="stack" autocomplete="off">
        <div class="grid cols-2">
          <div class="field"><label>Student ID / UUID</label><input class="input mono" name="uuid" value="${esc(s?.uuid || '')}" required maxlength="40" placeholder="UU2023CS0142"></div>
          <div class="field"><label>Full name</label><input class="input" name="name" value="${esc(s?.name || '')}" required maxlength="80"></div>
          <div class="field"><label>Course</label><input class="input" name="course" value="${esc(s?.course || '')}" placeholder="B.Tech" maxlength="80"></div>
          <div class="field"><label>Year</label><input class="input" name="year" value="${esc(s?.year || '')}" placeholder="2nd" maxlength="20"></div>
          <div class="field"><label>Specialization</label><input class="input" name="specialization" value="${esc(s?.specialization || '')}" placeholder="CSE (AI & ML)" maxlength="80"></div>
          <div class="field"><label>Phone</label><input class="input" name="phone" value="${esc(s?.phone || '')}" maxlength="20"></div>
          <div class="field"><label>Bus</label><select class="input" name="bus_id">${busOptions(buses, s?.bus_id)}</select></div>
          <div class="field"><label>Stop</label><select class="input" name="stop_id">${stopOptions(buses.find((b) => b.id === s?.bus_id), s?.stop_id)}</select></div>
        </div>
        <label class="check"><input type="checkbox" name="active" ${s ? (s.active ? 'checked' : '') : 'checked'}> Active (can board)</label>
        <div class="error-text" data-error hidden></div>
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="stuSave">Save</button>',
  });
  const form = $('#stuForm', m.root);
  form.elements.bus_id.addEventListener('change', (e) => { form.elements.stop_id.innerHTML = stopOptions(buses.find((b) => String(b.id) === e.target.value), null); });
  const save = $('#stuSave', m.root);
  save.addEventListener('click', () => form.requestSubmit());
  formHandler(form, save, async (v) => {
    const body = { ...v, bus_id: v.bus_id || null, stop_id: v.stop_id || null };
    if (s) await api.put(`/api/admin/students/${s.id}`, body); else await api.post('/api/admin/students', body);
    toast(s ? 'Student updated' : 'Student added', 'success');
    m.close();
    loadStudents();
  });
}

async function studentHistory(s) {
  const h = await api.get(`/api/admin/students/${s.id}/history`);
  const m = modal({
    title: `${s.name} · ${s.uuid}`,
    wide: true,
    body: `
      <div class="grid cols-2">
        <div>
          <div class="card-title"><h3>Boardings</h3><span class="pill">${h.items.length}</span></div>
          ${h.items.length ? `<div class="feed">${h.items.map((c) => `<div class="feed-item"><div class="meta"><span class="name">Bus ${esc(c.bus_number)} · ${directionLabel(c.direction)}</span><span class="sub">${fmtDateTime(c.created_at)} ${flagPills(c.flags)}${c.note ? ` · ${esc(c.note)}` : ''}</span></div></div>`).join('')}</div>` : '<div class="empty small">No boardings yet</div>'}
        </div>
        <div>
          <div class="card-title"><h3>Linked phones</h3><button class="btn sm danger w" id="resetDev" ${h.devices.length ? '' : 'disabled'}>Reset devices</button></div>
          <p class="xs muted mb">A phone is linked to the first student who boards with it. Reset when a student changes phones or is blocked.</p>
          ${h.devices.length ? `<div class="feed">${h.devices.map((d) => `<div class="feed-item"><div class="meta"><span class="name mono">${esc(d.id)}</span><span class="sub">linked ${fmtDateTime(d.bound_at)} · last used ${fmtRel(d.last_seen)}</span><span class="xs faint truncate" title="${esc(d.ua)}">${esc(d.ua || '')}</span></div></div>`).join('')}</div>` : '<div class="empty small">No phone linked</div>'}
        </div>
      </div>`,
  });
  $('#resetDev', m.root).addEventListener('click', async () => {
    if (!(await confirmDialog(`Unlink all phones from ${s.name}? Their next scan links a phone again.`, { okText: 'Reset', danger: true }))) return;
    try { const r = await api.post(`/api/admin/students/${s.id}/devices/reset`); toast(`${r.unlinked} phone(s) unlinked`, 'success'); m.close(); } catch (e) { toast(e.message, 'error'); }
  });
}

function importDialog() {
  const m = modal({
    title: 'Import students from CSV',
    wide: true,
    body: `
      <p class="small muted">Header row required. Recognised columns: <code>uuid</code> (or id / enrollment / roll no), <code>name</code>, <code>course</code>, <code>year</code>, <code>specialization</code>, <code>bus</code> (bus number), <code>stop</code>, <code>phone</code>. Existing IDs are updated; unknown buses and stops are created.</p>
      <div class="field"><label>Choose file</label><input class="input" type="file" id="csvFile" accept=".csv,text/csv,text/plain"></div>
      <div class="field"><label>…or paste CSV</label><textarea class="input" id="csvText" placeholder="uuid,name,course,year,specialization,bus,stop,phone&#10;UU2023CS0142,Aditi Sharma,B.Tech,2nd,CSE (AI&amp;ML),12,Rajpur Road,9876543210"></textarea></div>
      <div id="csvResult"></div>
      <div class="error-text" data-error hidden></div>`,
    footer: '<button class="btn" data-close>Close</button><button class="btn primary" id="csvGo">Import</button>',
  });
  $('#csvFile', m.root).addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; f.text().then((t) => { $('#csvText', m.root).value = t; }); });
  $('#csvGo', m.root).addEventListener('click', async () => {
    const btn = $('#csvGo', m.root);
    const text = $('#csvText', m.root).value;
    if (!text.trim()) return toast('Paste or choose a CSV first', 'warn');
    btn.disabled = true;
    try {
      const r = await api.request('POST', '/api/admin/students/import', text);
      $('#csvResult', m.root).innerHTML = `<div class="card soft small"><b>${r.inserted}</b> added · <b>${r.updated}</b> updated · <b>${r.skipped}</b> skipped${r.busesCreated ? ` · ${r.busesCreated} bus(es) created` : ''}${r.stopsCreated ? ` · ${r.stopsCreated} stop(s) created` : ''}${r.errors.length ? `<ul class="mt">${r.errors.slice(0, 20).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>`;
      toast('Import finished', 'success');
      busCache = null;
      loadStudents();
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  });
}

// ------------------------------------------------------------------ buses & stops
async function renderBuses() {
  const buses = await busesList(true);
  content.innerHTML = `
    <div class="row between wrap"><p class="muted small">Every bus has its own stops, students, bus admin and portal. A student can only board the bus they are registered on.</p><div class="row wrap"><span class="pill accent">${buses.filter((b) => b.active).length} buses</span><a class="btn" href="/incharge" target="_blank" rel="noopener">Bus portals</a><button class="btn w" id="seedFleet" title="Adds any missing standard bus, stop and bus admin account">Create 19-bus fleet</button><button class="btn primary w" id="addBus">${ICONS.plus}<span>Add bus</span></button></div></div>
    <div class="grid auto">${buses.length ? buses.map((b) => `
      <div class="card stack" data-bus="${b.id}">
        <div class="row between">
          <div class="row"><div class="avatar">${esc(b.number)}</div><div><div class="bold">${esc(b.name)}</div><div class="xs muted">${esc(b.route || 'No route description')}</div></div></div>
          <div class="row">${b.live ? '<span class="pill live">Live</span>' : ''}${b.active ? '' : '<span class="pill">Inactive</span>'}<a class="btn sm" href="/bus/${encodeURIComponent(b.number)}" target="_blank" rel="noopener" title="Open this bus's portal">Open</a><button class="btn icon sm ghost w" data-edit-bus="${b.id}" title="Edit bus">${ICONS.edit}</button><button class="btn icon sm ghost w" data-del-bus="${b.id}" title="Delete bus">${ICONS.trash}</button></div>
        </div>
        <div class="row wrap small muted"><span>${icon('users')} ${b.students} students</span><span>${icon('user')} ${b.incharges.length ? b.incharges.map((u) => `${esc(u.name)} <span class="xs mono faint">(${esc(u.username)})</span>`).join(', ') : 'No bus admin yet'}</span></div>
        <div>
          <div class="label mb">Stops (in order)</div>
          <div class="row wrap" data-stops>${b.stops.map((s) => `<span class="pill outline">${esc(s.name)} <button class="btn icon sm ghost w" data-del-stop="${s.id}" title="Remove stop" aria-label="Remove">${ICONS.x}</button></span>`).join('') || '<span class="xs faint">No stops yet</span>'}</div>
          <form class="row mt w" data-add-stop="${b.id}"><input class="input grow" name="name" placeholder="Add a stop…" maxlength="80" required><button class="btn sm" type="submit">${ICONS.plus}</button></form>
        </div>
      </div>`).join('') : `<div class="card"><div class="empty"><div class="big">${ICONS.bus}</div>No buses yet. Use <b>Create 19-bus fleet</b>, add one, or import students with a bus column.</div></div>`}
    </div>`;
  $('#addBus').addEventListener('click', () => busForm());
  $('#seedFleet').addEventListener('click', seedFleetDialog);
  $$('[data-edit-bus]').forEach((b) => b.addEventListener('click', () => busForm(buses.find((x) => x.id === Number(b.dataset.editBus)))));
  $$('[data-del-bus]').forEach((b) => b.addEventListener('click', async () => {
    const bus = buses.find((x) => x.id === Number(b.dataset.delBus));
    if (!(await confirmDialog(`Delete bus ${bus.number}? Buses with trip history are deactivated instead.`, { okText: 'Delete', danger: true }))) return;
    try { await api.del(`/api/admin/buses/${bus.id}`); toast('Bus removed', 'success'); renderBuses(); } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-add-stop]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.post(`/api/admin/buses/${f.dataset.addStop}/stops`, { name: f.elements.name.value }); renderBuses(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-del-stop]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove this stop? Students on it will have no stop until reassigned.', { okText: 'Remove', danger: true }))) return;
    try { await api.del(`/api/admin/stops/${b.dataset.delStop}`); renderBuses(); } catch (e) { toast(e.message, 'error'); }
  }));
}

async function seedFleetDialog() {
  const ok = await confirmDialog('Create the standard 19-bus fleet? Missing buses, stops and bus admin accounts (incharge1 to incharge19) are added; anything that already exists is left as it is.', { title: 'Create 19-bus fleet', okText: 'Create' });
  if (!ok) return;
  const btn = $('#seedFleet');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  let r;
  try { r = await api.post('/api/admin/fleet'); } catch (e) { toast(e.message, 'error'); if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } return; }
  busCache = null;
  await renderBuses();
  if (!r.incharges.length) {
    toast(`Fleet complete: ${r.buses} new bus(es), ${r.stops} new stop(s). All bus admin accounts already existed.`, 'success', 5000);
    return;
  }
  const origin = location.origin;
  const rows = r.incharges.map((u) => ({ ...u, portal: `${origin}/bus/${encodeURIComponent(u.bus)}` }));
  const m = modal({
    title: 'Bus admin accounts created',
    wide: true,
    body: `
      <p class="small"><b>Save these now: the passwords are shown only once.</b> Give each bus admin their line. They cannot change it themselves; you can set a new one any time under Staff.</p>
      <p class="xs muted">${r.buses} new bus(es) · ${r.stops} new stop(s) · ${r.incharges.length} new account(s)</p>
      ${table(['Bus', 'Username', 'Temporary password', 'Portal'], rows.map((u) => `<tr><td><b>Bus ${esc(u.bus)}</b></td><td class="mono">${esc(u.username)}</td><td class="mono bold">${esc(u.password)}</td><td class="xs mono">${esc(u.portal)}</td></tr>`))}`,
    footer: `<button class="btn" id="fleetCopy">${ICONS.copy}<span>Copy all</span></button><button class="btn" id="fleetCsv">${ICONS.download}<span>Download CSV</span></button><button class="btn primary" data-close>I saved them</button>`,
  });
  const text = rows.map((u) => `Bus ${u.bus}\t${u.username}\t${u.password}\t${u.portal}`).join('\n');
  $('#fleetCopy', m.root).addEventListener('click', () => copyText(text));
  $('#fleetCsv', m.root).addEventListener('click', () => {
    const csv = ['bus,username,temporary_password,portal', ...rows.map((u) => [u.bus, u.username, u.password, u.portal].join(','))].join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = el(`<a href="${url}" download="incharge-accounts.csv"></a>`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function busForm(b = null) {
  const m = modal({
    title: b ? `Edit bus ${b.number}` : 'Add bus',
    body: `
      <form id="busForm" class="stack">
        <div class="grid cols-2">
          <div class="field"><label>Bus number</label><input class="input" name="number" value="${esc(b?.number || '')}" required maxlength="20" placeholder="12"></div>
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(b?.name || '')}" required maxlength="60" placeholder="Rajpur Express"></div>
        </div>
        <div class="field"><label>Route description</label><input class="input" name="route" value="${esc(b?.route || '')}" maxlength="200" placeholder="Rajpur Road, Clock Tower, Campus"></div>
        <label class="check"><input type="checkbox" name="active" ${b ? (b.active ? 'checked' : '') : 'checked'}> Active</label>
        <div class="error-text" data-error hidden></div>
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="busSave">Save</button>',
  });
  const form = $('#busForm', m.root);
  const save = $('#busSave', m.root);
  save.addEventListener('click', () => form.requestSubmit());
  formHandler(form, save, async (v) => {
    if (b) await api.put(`/api/admin/buses/${b.id}`, v); else await api.post('/api/admin/buses', v);
    toast('Saved', 'success'); m.close(); renderBuses();
  });
}

// ------------------------------------------------------------------ staff
async function renderStaff() {
  const [r, buses] = await Promise.all([api.get('/api/admin/users'), busesList()]);
  const rows = r.items.map((u) => `
    <tr>
      <td><div class="bold">${esc(u.name)}</div><div class="xs muted mono">${esc(u.username)}</div></td>
      <td><span class="pill ${u.role === 'admin' ? 'accent' : u.role === 'operator' ? 'outline' : ''}">${roleLabel(u.role)}</span></td>
      <td>${u.bus_number ? `<a href="/bus/${encodeURIComponent(u.bus_number)}" target="_blank" rel="noopener" title="Open this bus">Bus ${esc(u.bus_number)}</a>` : u.role === 'incharge' ? '<span class="faint">Any bus</span>' : '<span class="faint">All buses</span>'}</td>
      <td>${u.active ? '<span class="pill success">Active</span>' : '<span class="pill">Inactive</span>'}${u.locked_until && u.locked_until > Date.now() ? ' <span class="pill danger">Locked</span>' : ''}${u.role === 'admin' && u.must_change_password ? ' <span class="pill warn" title="Must choose a new password at next sign-in">New password due</span>' : ''}</td>
      <td class="xs muted">${u.last_seen ? fmtRel(u.last_seen) : 'Never'}</td>
      <td class="actions">
        <button class="btn icon sm ghost" data-act="password" data-id="${u.id}" title="Set password" ${u.id === user.id ? 'disabled' : ''}>${ICONS.key}</button>
        <button class="btn icon sm ghost" data-act="edit" data-id="${u.id}" title="Edit">${ICONS.edit}</button>
        <button class="btn icon sm ghost" data-act="del" data-id="${u.id}" title="Remove" ${u.id === user.id ? 'disabled' : ''}>${ICONS.trash}</button>
      </td>
    </tr>`);
  content.innerHTML = `
    <div class="card soft small">
      <div><b>Super admin</b>: everything, including every password.</div>
      <div><b>Operations admin</b>: watches every bus live; cannot change anything.</div>
      <div><b>Bus admin</b>: runs one bus. Bus and operations admins cannot change their own password; you set it here with the key button.</div>
    </div>
    <div class="row between wrap"><span class="small muted">${r.items.length} accounts</span><button class="btn primary" id="addUser">${ICONS.plus}<span>Add staff</span></button></div>
    <div id="staffWrap">${table(['Name', 'Role', 'Bus', 'Status', 'Last seen', ''], rows)}</div>`;
  $('#addUser').addEventListener('click', () => userForm(null, buses));
  $('#staffWrap').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = r.items.find((x) => x.id === Number(b.dataset.id));
    if (b.dataset.act === 'edit') userForm(u, buses);
    if (b.dataset.act === 'password') setPasswordDialog(u);
    if (b.dataset.act === 'del' && (await confirmDialog(`Remove ${u.name}? Accounts with trip history are deactivated instead.`, { okText: 'Remove', danger: true }))) {
      try { await api.del(`/api/admin/users/${u.id}`); toast('Removed', 'success'); renderStaff(); } catch (err) { toast(err.message, 'error'); }
    }
  });
}

/** Super admin sets a password for someone else (typed, or generated and shown once). */
function setPasswordDialog(u) {
  const m = modal({
    title: `Set password for ${u.name}`,
    body: `
      <form id="pwSetForm" class="stack" autocomplete="off">
        <p class="small muted">${u.role === 'admin' ? 'They will be asked to choose their own password at next sign-in.' : `${roleLabel(u.role)}s cannot change their own password, so this is the password they will use.`} They are signed out on every device.</p>
        <div class="field"><label>New password</label><input class="input" name="password" type="text" autocomplete="new-password" minlength="10" placeholder="Leave empty to generate one"><div class="help">At least 10 characters with letters and numbers.</div></div>
        <div class="error-text" data-error hidden></div>
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="pwSetSave">Set password</button>',
  });
  const form = $('#pwSetForm', m.root);
  const save = $('#pwSetSave', m.root);
  save.addEventListener('click', () => form.requestSubmit());
  formHandler(form, save, async (v) => {
    const r = await api.post(`/api/admin/users/${u.id}/password`, { password: v.password.trim() });
    m.close();
    if (r.generated) showPassword(u.username, r.password, u.role);
    else toast(`Password for ${u.name} updated`, 'success');
    renderStaff();
  });
}

function showPassword(username, password, role = 'incharge') {
  modal({
    title: 'New password',
    body: `<p class="small muted">Give this to the staff member now; it won't be shown again.${role === 'admin' ? ' They will be asked to choose their own at first sign-in.' : ''}</p>
      <div class="card soft"><div class="label">Username</div><div class="mono bold">${esc(username)}</div><div class="label mt">Password</div><div class="row"><code class="bold" id="pwVal">${esc(password)}</code><button class="btn icon sm ghost" id="pwCopy">${ICONS.copy}</button></div></div>`,
    footer: '<button class="btn primary" data-close>Done</button>',
  });
  $('#pwCopy').addEventListener('click', () => copyText(password));
}

function userForm(u, buses) {
  const m = modal({
    title: u ? `Edit ${u.name}` : 'Add staff',
    body: `
      <form id="userForm" class="stack" autocomplete="off">
        <div class="grid cols-2">
          <div class="field"><label>Full name</label><input class="input" name="name" value="${esc(u?.name || '')}" required maxlength="80"></div>
          <div class="field"><label>Username</label><input class="input mono" name="username" value="${esc(u?.username || '')}" required minlength="3" maxlength="32" autocapitalize="off"></div>
          <div class="field"><label>Role</label><select class="input" name="role">${ROLE_OPTIONS.map(([k, label]) => `<option value="${k}" ${(u?.role || 'incharge') === k ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          <div class="field"><label>Bus (bus admins only)</label><select class="input" name="bus_id">${busOptions(buses, u?.bus_id)}</select><div class="help">The bus this admin runs. Ignored for other roles.</div></div>
        </div>
        ${u ? '' : '<div class="field"><label>Password</label><input class="input" name="password" type="text" autocomplete="new-password" placeholder="Leave empty to generate one"><div class="help">Bus and operations admins keep this password; only you can change it later.</div></div>'}
        <label class="check"><input type="checkbox" name="active" ${u ? (u.active ? 'checked' : '') : 'checked'}> Active</label>
        <div class="error-text" data-error hidden></div>
      </form>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="userSave">Save</button>',
  });
  const form = $('#userForm', m.root);
  const save = $('#userSave', m.root);
  save.addEventListener('click', () => form.requestSubmit());
  formHandler(form, save, async (v) => {
    const body = { ...v, bus_id: v.bus_id || null };
    if (!body.password) delete body.password;
    if (u) { await api.put(`/api/admin/users/${u.id}`, body); toast('Saved', 'success'); }
    else { const r = await api.post('/api/admin/users', body); showPassword(v.username, r.password, v.role); }
    m.close(); renderStaff();
  });
}

// ------------------------------------------------------------------ trips
const tripsState = { date: todayIso(), bus: '' };
async function renderTrips() {
  const buses = await busesList();
  content.innerHTML = `
    <div class="card"><div class="row wrap">
      <input class="input" type="date" id="tDate" value="${tripsState.date}">
      <select class="input" id="tBus"><option value="">All buses</option>${buses.map((b) => `<option value="${b.id}" ${String(b.id) === tripsState.bus ? 'selected' : ''}>Bus ${esc(b.number)}</option>`).join('')}</select>
    </div></div>
    <div id="tripsTable"></div>`;
  $('#tDate').addEventListener('change', (e) => { tripsState.date = e.target.value; loadTrips(); });
  $('#tBus').addEventListener('change', (e) => { tripsState.bus = e.target.value; loadTrips(); });
  await loadTrips();
}
async function loadTrips() {
  const r = await api.get(`/api/admin/trips?date=${tripsState.date}&bus=${tripsState.bus}`);
  const rows = r.items.map((t) => `
    <tr class="clickable" data-trip="${t.id}">
      <td><span class="bold">Bus ${esc(t.bus_number)}</span><div class="xs muted">${esc(t.bus_name)}</div></td>
      <td>${directionIcon(t.direction)} ${directionLabel(t.direction)}</td>
      <td>${esc(t.incharge_name)}</td>
      <td class="num">${fmtTime(t.started_at)}–${t.ended_at ? fmtTime(t.ended_at) : '<span class="pill live">running</span>'}</td>
      <td class="num"><b>${t.boarded}</b> / ${t.expected}</td>
      <td>${t.flagged ? `<span class="pill warn">${t.flagged}</span>` : '<span class="faint">—</span>'}</td>
    </tr>`);
  $('#tripsTable').innerHTML = table(['Bus', 'Trip', 'Bus admin', 'Time', 'Verified', 'To review'], rows, `No trips on ${fmtDate(r.start)}`);
  $$('[data-trip]').forEach((tr) => tr.addEventListener('click', () => openTripModal(Number(tr.dataset.trip))));
}

let tripModal = null;
async function openTripModal(id) {
  const s = await api.get(`/api/admin/trips/${id}`);
  tripModal?.close();
  openTripId = id;
  tripModal = modal({ title: `Bus ${s.trip.bus_number} · ${directionLabel(s.trip.direction)} · ${fmtDate(s.trip.started_at)}`, wide: true, body: '<div id="tripBody"></div>', onClose: () => { openTripId = null; tripModal = null; } });
  paintTripModal(s);
}
async function refreshTripModal(id) { if (!tripModal) return; try { paintTripModal(await api.get(`/api/admin/trips/${id}`)); } catch { /* ignore */ } }
function paintTripModal(s) {
  const body = $('#tripBody');
  if (!body) return;
  const tab = body.dataset.tab || 'boarded';
  body.innerHTML = `
    <div class="row wrap between">
      <div class="row wrap">
        <span class="pill ${s.trip.status === 'active' ? 'live' : ''}">${s.trip.status === 'active' ? 'Running' : 'Ended'}</span>
        <span class="small muted">${esc(s.trip.incharge_name)} · ${fmtTime(s.trip.started_at)}${s.trip.ended_at ? `–${fmtTime(s.trip.ended_at)}` : ''}</span>
      </div>
      <div class="row"><a class="btn sm w" href="/api/admin/trips/${s.trip.id}/export.csv">${ICONS.download}<span>CSV</span></a>${s.trip.status === 'active' ? `<button class="btn sm danger w" id="tripEnd">End trip</button>` : ''}</div>
    </div>
    <div class="row mt"><span class="count-hero"><span class="n">${s.counts.boarded}</span><span class="of">/ ${s.counts.expected} boarded</span></span><span class="grow"></span>${s.counts.flagged ? `<span class="pill warn">${s.counts.flagged} flagged</span>` : ''}</div>
    <div class="progress mt"><i></i></div>
    <div class="tabs mt"><button data-tab="boarded" class="${tab === 'boarded' ? 'active' : ''}">Boarded (${s.checkins.length})</button><button data-tab="missing" class="${tab === 'missing' ? 'active' : ''}">Not boarded (${s.notBoarded.length})</button></div>
    <div class="mt" id="tripList"></div>`;
  $('.progress > i', body).style.width = `${s.counts.expected ? Math.min(100, (s.counts.boarded / s.counts.expected) * 100) : 0}%`;
  const paintList = () => {
    const t = body.dataset.tab || 'boarded';
    $$('.tabs button', body).forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#tripList', body).innerHTML = t === 'boarded'
      ? table(['Time', 'Student', 'Course', 'Stop', 'How', 'Flags'], s.checkins.map((c) => `<tr><td class="num">${fmtTime(c.created_at)}</td><td><b>${esc(c.name)}</b><div class="xs muted mono">${esc(c.uuid)}</div></td><td>${esc([c.course, c.year].filter(Boolean).join(' · '))}</td><td>${esc(c.stop || '—')}</td><td>${c.method === 'manual' ? `manual · ${esc(c.marked_by_name || '')}${c.note ? `<div class="xs muted">${esc(c.note)}</div>` : ''}` : 'QR'}</td><td>${flagPills(c.flags) || '<span class="faint">—</span>'}</td></tr>`), 'No one has boarded yet')
      : table(['Student', 'Course', 'Stop'], s.notBoarded.map((n) => `<tr><td><b>${esc(n.name)}</b><div class="xs muted mono">${esc(n.uuid)}</div></td><td>${esc([n.course, n.year].filter(Boolean).join(' · '))}</td><td>${esc(n.stop || '—')}</td></tr>`), 'Everyone assigned to this bus has boarded');
  };
  $$('.tabs button', body).forEach((b) => b.addEventListener('click', () => { body.dataset.tab = b.dataset.tab; paintList(); }));
  $('#tripEnd', body)?.addEventListener('click', () => endTripAdmin(s.trip.id));
  paintList();
}

// ------------------------------------------------------------------ flags
const flagsState = { date: todayIso() };
async function renderFlags() {
  content.innerHTML = `
    <div class="card"><div class="row wrap between"><input class="input" type="date" id="fDate" value="${flagsState.date}"><div class="row wrap small muted">${flagPills('new_device')} first time on a new phone &nbsp; ${flagPills('wrong_bus')} boarded a bus they are not assigned to &nbsp; ${flagPills('manual')} marked by staff</div></div></div>
    <div id="flagsTable"></div>`;
  $('#fDate').addEventListener('change', (e) => { flagsState.date = e.target.value; loadFlags(); });
  await loadFlags();
}
async function loadFlags() {
  const r = await api.get(`/api/admin/flags?date=${flagsState.date}`);
  $('#flagsTable').innerHTML = table(['Time', 'Student', 'Bus', 'Flags', 'Details'], r.items.map((c) => `
    <tr class="clickable" data-trip="${c.trip_id}">
      <td class="num">${fmtTime(c.created_at)}</td>
      <td><b>${esc(c.name)}</b><div class="xs muted mono">${esc(c.uuid)}</div></td>
      <td>Bus ${esc(c.bus_number)} · ${directionLabel(c.direction)}</td>
      <td>${flagPills(c.flags)}</td>
      <td class="xs muted">${c.method === 'manual' ? `by ${esc(c.marked_by_name || 'staff')}${c.note ? ` · ${esc(c.note)}` : ''}` : `ip ${esc(c.ip || '')}`}</td>
    </tr>`), 'Nothing to review on this day.');
  $$('[data-trip]').forEach((tr) => tr.addEventListener('click', () => openTripModal(Number(tr.dataset.trip))));
}

// ------------------------------------------------------------------ audit
let auditPage = 1;
async function renderAudit() {
  const r = await api.get(`/api/admin/audit?page=${auditPage}`);
  const pages = Math.max(1, Math.ceil(r.total / r.limit));
  content.innerHTML = `
    ${table(['When', 'Who', 'Action', 'Target', 'Details', 'IP'], r.items.map((a) => `<tr><td class="num nowrap">${fmtDateTime(a.created_at)}</td><td>${esc(a.actor_name || 'system')}</td><td><span class="pill ${/fail|lock|delete|deactivate/.test(a.action) ? 'danger' : /login|logout/.test(a.action) ? '' : 'accent'}">${esc(a.action)}</span></td><td class="xs muted">${esc(a.entity || '')} ${esc(a.entity_id || '')}</td><td class="small">${esc(a.details)}</td><td class="xs muted mono">${esc(a.ip || '')}</td></tr>`))}
    <div class="row between"><span class="small muted">${r.total} entries</span><span class="row"><button class="btn sm" id="aPrev" ${auditPage <= 1 ? 'disabled' : ''}>Newer</button><span class="small">Page ${auditPage} of ${pages}</span><button class="btn sm" id="aNext" ${auditPage >= pages ? 'disabled' : ''}>Older</button></span></div>`;
  $('#aPrev').addEventListener('click', () => { auditPage--; renderAudit(); });
  $('#aNext').addEventListener('click', () => { auditPage++; renderAudit(); });
}

// ------------------------------------------------------------------ settings
async function renderSettings() {
  const s = await api.get('/api/admin/settings');
  const day = s.qrMode === 'day';
  content.innerHTML = `
    <div class="card stack">
      <div class="row between wrap">
        <div><h2>QR validity</h2><p class="muted small">How long a bus QR code keeps working. Changes apply to every bus screen within a few minutes.</p></div>
        <span class="pill ${day ? 'warn' : 'success'}">${day ? 'Whole day' : `Rotating every ${s.qrRotateSec}s`}</span>
      </div>
      <form id="qrForm" class="choice">
        <label><input type="radio" name="qr_mode" value="day" ${day ? 'checked' : ''}><span class="bold">Whole day</span><span class="xs muted">One QR per bus per day (India time). Can be printed. A photo of it also works all day, so an absent student could check in if someone forwards it; the bus admin can press <b>New QR code</b> to cancel it.</span></label>
        <label><input type="radio" name="qr_mode" value="rotating" ${day ? '' : 'checked'}><span class="bold">Rotating every ${s.qrRotateSec}s</span><span class="xs muted">Works only from the live bus screen. Screenshots and forwarded links stop working within ${s.qrRotateSec * 2}s. Strongest protection against remote check-ins.</span></label>
      </form>
    </div>
    <div class="grid cols-2">
      <div class="card stack">
        <div><h2>QR link address</h2><p class="muted small">The QR codes encode this address. Student phones must be able to open it: ${s.serverless ? 'on a hosted deployment that is your production domain (custom domain if you added one).' : "on a local network it is your computer's Wi-Fi IP; in production it is your https domain."}</p></div>
        <form id="setForm" class="stack">
          <div class="field"><label>Public base URL</label><input class="input mono" name="base_url" value="${esc(s.base_url)}" placeholder="${s.serverless ? 'https://bus.your-college.edu' : `http://${esc(s.lanIp)}:${s.port}`}"><div class="help">Leave empty to auto-detect (${esc(s.envBaseUrl || (s.serverless ? 'the Vercel production domain' : `http://${s.lanIp}:${s.port}`))}).</div></div>
          <div class="card soft small">Currently in use: <code>${esc(s.effectiveBaseUrl)}</code></div>
          <div class="error-text" data-error hidden></div>
          <button class="btn primary" type="submit">Save</button>
        </form>
      </div>
      <div class="card stack">
        <div><h2>Security profile</h2><p class="muted small">Set in ${s.serverless ? 'the Vercel environment variables' : '<code>.env</code>'} and applied at start.</p></div>
        <div class="feed">
          <div class="feed-item"><div class="meta"><span class="name">${s.serverless ? 'Serverless hosting' : 'Single server'} · ${s.database === 'turso' ? 'Turso database' : s.database === 'sqlite' ? 'local SQLite file' : 'libSQL file'}</span><span class="sub">Live updates ${s.liveMode === 'poll' ? 'arrive by polling every few seconds' : 'are pushed instantly'}.</span></div></div>
          <div class="feed-item"><div class="meta"><span class="name">${day ? 'QR valid for the whole day' : `QR rotates every ${s.qrRotateSec}s`}</span><span class="sub">${day ? 'Same QR all day per bus; New QR code cancels it.' : `A screenshot or forwarded link stops working within ${s.qrRotateSec * 2}s.`}</span></div></div>
          <div class="feed-item"><div class="meta"><span class="name">${s.checkinMinutes} minute check-in window</span><span class="sub">After scanning, the student must finish within this time.</span></div></div>
          <div class="feed-item"><div class="meta"><span class="name">One phone = one student</span><span class="sub">A phone is linked to the first student who boards with it. Max ${s.maxDevicesPerStudent} phones per student per 30 days.</span></div></div>
          <div class="feed-item"><div class="meta"><span class="name">Server-side identity</span><span class="sub">Name, course, year, stop all come from the database; the phone only sends ID + name and can't alter them.</span></div></div>
          <div class="feed-item"><div class="meta"><span class="name">Staff hardening</span><span class="sub">scrypt password hashing, 5-strike lockout, CSRF + origin checks, strict CSP, audit log.</span></div></div>
        </div>
      </div>
    </div>`;
  const form = $('#setForm');
  formHandler(form, $('button[type=submit]', form), async (v) => { const r = await api.put('/api/admin/settings', { base_url: v.base_url }); toast(`Saved · QR links now use ${r.effectiveBaseUrl}`, 'success'); renderSettings(); });
  $('#qrForm').addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (mode === 'day' && !(await confirmDialog('Switch to whole-day QR codes? Each bus QR will work all day, including photos of it, so remote check-ins become possible if a QR is shared. Bus admins can cancel a leaked QR with New QR code.', { title: 'Whole-day QR', okText: 'Switch' }))) { renderSettings(); return; }
    try { await api.put('/api/admin/settings', { qr_mode: mode }); toast(mode === 'day' ? 'QR codes now work for the whole day' : `QR codes now rotate every ${s.qrRotateSec}s`, 'success'); } catch (err) { toast(err.message, 'error'); }
    renderSettings();
  });
}
