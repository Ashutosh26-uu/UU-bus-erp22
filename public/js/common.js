/* Shared helpers: DOM, API client (CSRF aware), toasts, modals, theme, SSE, formatting. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.code = data?.code || null;
    this.data = data || {};
  }
}

export const api = {
  csrf: null,
  liveMode: 'sse',
  extraHeaders: {},
  onUnauthenticated: null,
  async request(method, url, body, { raw = false } = {}) {
    const headers = { Accept: 'application/json', ...this.extraHeaders };
    if (body !== undefined && !(typeof body === 'string')) headers['Content-Type'] = 'application/json';
    if (typeof body === 'string') headers['Content-Type'] = 'text/plain; charset=utf-8';
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
    } catch {
      throw new ApiError(0, { error: 'Network error. Check your connection and try again.', code: 'NETWORK' });
    }
    if (raw) return res;
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthenticated) this.onUnauthenticated();
      throw new ApiError(res.status, data);
    }
    return data;
  },
  get: (url) => api.request('GET', url),
  post: (url, body = {}) => api.request('POST', url, body),
  put: (url, body = {}) => api.request('PUT', url, body),
  del: (url) => api.request('DELETE', url),
};

// ------------------------------------------------------------------ toasts
let toastRoot = null;
export function toast(message, type = 'info', ms = 3600) {
  if (!toastRoot) { toastRoot = el('<div class="toasts" aria-live="polite"></div>'); document.body.appendChild(toastRoot); }
  const icons = { info: 'ℹ️', success: '✅', error: '⚠️', warn: '⚠️' };
  const t = el(`<div class="toast ${type}"><span>${icons[type] || ''}</span><div>${esc(message)}</div></div>`);
  toastRoot.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, ms);
  return t;
}

// ------------------------------------------------------------------ modals
export function modal({ title, body = '', footer = '', wide = false, onClose } = {}) {
  const root = el(`
    <div class="modal-root" role="dialog" aria-modal="true" aria-label="${esc(title || 'Dialog')}">
      <div class="modal ${wide ? 'wide' : ''}">
        <header><h2>${esc(title || '')}</h2><button class="btn icon ghost" data-close aria-label="Close">${ICONS.x}</button></header>
        <div class="body"></div>
        <footer></footer>
      </div>
    </div>`);
  const bodyEl = $('.body', root);
  const footEl = $('footer', root);
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  if (typeof footer === 'string') footEl.innerHTML = footer; else if (footer) footEl.appendChild(footer);
  if (!footEl.childElementCount) footEl.remove();
  const close = () => { if (!root.isConnected) return; root.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  root.addEventListener('click', (e) => { if (e.target === root || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(root);
  const first = $('input, select, textarea, button:not([data-close])', bodyEl);
  setTimeout(() => first?.focus(), 30);
  return { root, body: bodyEl, footer: footEl, close };
}

export function confirmDialog(message, { title = 'Are you sure?', okText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title,
      body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okText)}</button>`,
      onClose: () => resolve(result),
    });
    $('[data-ok]', m.root).addEventListener('click', () => { result = true; m.close(); });
    setTimeout(() => $('[data-ok]', m.root).focus(), 30);
  });
}

/** Wire a form inside a modal: collects values, shows errors inline, disables button while busy. */
export function formHandler(form, submitBtn, fn) {
  const errBox = $('[data-error]', form) || form.appendChild(el('<div class="error-text" data-error hidden></div>'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;
    try { await fn(formValues(form)); } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
    finally { submitBtn.removeAttribute('aria-busy'); submitBtn.disabled = false; }
  });
}
export function formValues(form) {
  const out = {};
  for (const elm of form.elements) {
    if (!elm.name) continue;
    if (elm.type === 'checkbox') out[elm.name] = elm.checked;
    else out[elm.name] = elm.value;
  }
  return out;
}

// ------------------------------------------------------------------ theme
export const theme = {
  init() {
    try { const t = localStorage.getItem('uu_theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
  },
  current() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },
  toggle() {
    const next = this.current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('uu_theme', next); } catch { /* ignore */ }
    return next;
  },
  button(btn) {
    const paint = () => { btn.innerHTML = this.current() === 'dark' ? ICONS.sun : ICONS.moon; btn.title = 'Toggle theme'; };
    paint();
    btn.addEventListener('click', () => { this.toggle(); paint(); });
  },
};
theme.init();

// ------------------------------------------------------------------ live events (SSE or polling)
/** Same handlers either way: the server says which transport it uses (api.liveMode from /api/auth/me). */
export function liveEvents(handlers, onStatus) {
  return api.liveMode === 'poll' ? pollLive(handlers, onStatus) : sseLive(handlers, onStatus);
}

/** Serverless deployments: ask for new events every few seconds (slower when the tab is hidden). */
function pollLive(handlers, onStatus) {
  let cursor = 0;
  let stopped = false;
  let timer = null;
  let inflight = false;
  let failures = 0;
  const VISIBLE_MS = 2500;
  const HIDDEN_MS = 15000;
  const schedule = (ms) => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, ms); };
  async function tick() {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const r = await api.get(`/api/events/poll?after=${cursor}`);
      for (const ev of r.events) {
        const fn = handlers[ev.type];
        if (fn) { try { fn(ev.data); } catch (err) { console.error('event handler failed', ev.type, err); } }
      }
      cursor = r.cursor;
      failures = 0;
      onStatus?.(true);
    } catch (e) {
      failures++;
      onStatus?.(false);
      if (e.status === 401) { stopped = true; return; }
    } finally {
      inflight = false;
    }
    schedule(failures ? Math.min(VISIBLE_MS * 2 ** failures, 20000) : document.hidden ? HIDDEN_MS : VISIBLE_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !inflight) schedule(0); });
  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

/** Single long-running server: one Server-Sent Events stream, instant updates. */
function sseLive(handlers, onStatus) {
  let es = null;
  let stopped = false;
  let retry = 1000;
  const connect = () => {
    if (stopped) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => { retry = 1000; onStatus?.(true); });
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error('event handler failed', name, err); } });
    }
    es.onerror = () => {
      onStatus?.(false);
      es.close();
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 15000);
    };
  };
  connect();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && es && es.readyState === EventSource.CLOSED) connect(); });
  return { stop() { stopped = true; es?.close(); } };
}

// ------------------------------------------------------------------ formatting
const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtTimeSec = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fmtDate = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${pad(d.getDate())} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getFullYear()}`; };
export const fmtDateTime = (ms) => (ms ? `${fmtDate(ms)}, ${fmtTime(ms)}` : '');
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export function fmtRel(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(ms);
}
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const directionLabel = (d) => (d === 'to_college' ? 'To college' : d === 'from_college' ? 'From college' : d || '');
export const directionIcon = (d) => (d === 'to_college' ? '🏫' : '🏠');

const FLAG_INFO = {
  new_device: ['warn', 'New phone', 'Checked in from a phone not used before'],
  wrong_bus: ['warn', 'Other bus', 'Student is assigned to a different bus'],
  manual: ['accent', 'Manual', 'Marked by staff, not by QR scan'],
};
export function flagPills(flags) {
  if (!flags) return '';
  return String(flags).split(',').filter(Boolean).map((f) => {
    const [cls, label, title] = FLAG_INFO[f] || ['', f, ''];
    return `<span class="pill ${cls}" title="${esc(title)}">${esc(label)}</span>`;
  }).join(' ');
}

export function copyText(text) {
  try { navigator.clipboard?.writeText(text); toast('Copied to clipboard', 'success', 1500); } catch { /* ignore */ }
}

export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------------ auth bootstrap for staff pages
export async function requireStaff(roles) {
  api.onUnauthenticated = () => { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; };
  let me;
  try { me = await api.get('/api/auth/me'); } catch (e) { if (e.status === 401) return null; throw e; }
  api.csrf = me.csrf;
  api.liveMode = me.live || 'sse';
  if (roles && !roles.includes(me.user.role)) { location.href = '/'; return null; }
  if (me.user.mustChangePassword) await forcePasswordChange();
  return me.user;
}

export function passwordChangeForm({ forced = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: forced ? 'Set a new password' : 'Change password',
      body: `
        <form id="pwForm" class="stack" autocomplete="off">
          ${forced ? '<p class="muted small">For security you must replace the temporary password before continuing.</p>' : ''}
          <div class="field"><label>Current password</label><input class="input" name="current" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>New password</label><input class="input" name="next" type="password" autocomplete="new-password" minlength="10" required><div class="help">At least 10 characters with letters and numbers.</div></div>
          <div class="field"><label>Repeat new password</label><input class="input" name="again" type="password" autocomplete="new-password" required></div>
          <div class="error-text" data-error hidden></div>
          <button class="btn primary block" type="submit">Save password</button>
        </form>`,
      onClose: () => { if (done) return; if (forced) location.reload(); else resolve(false); },
    });
    if (forced) $('[data-close]', m.root).remove();
    const form = $('#pwForm', m.root);
    formHandler(form, $('button[type=submit]', form), async (v) => {
      if (v.next !== v.again) throw new Error('New passwords do not match');
      await api.post('/api/auth/change-password', { current: v.current, next: v.next });
      toast('Password updated', 'success');
      done = true;
      m.close();
      resolve(true);
    });
  });
}
export const forcePasswordChange = () => passwordChangeForm({ forced: true });

export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
  location.href = '/login';
}

// ------------------------------------------------------------------ icons (inline SVG, CSP friendly)
export const ICONS = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="12" width="8" height="9" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/></svg>',
  students: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10"/><path d="M4 16h16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 10h16M8 20v2m8-2v2"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/></svg>',
  staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 18a3.5 3.5 0 0 1 7 0M14 9h4M14 13h4"/></svg>',
  trips: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h12a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h12"/><circle cx="3" cy="7" r="1.5" fill="currentColor"/><circle cx="21" cy="23" r="1.5" fill="currentColor"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 1-1h11l-1.5 4L16 11H5"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M15 8l3 3M18 5l2 2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};
