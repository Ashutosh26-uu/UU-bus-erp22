import { $, api, formHandler, ICONS, toast } from './common.js';

const form = $('#loginForm');
const pw = $('#password');
const toggle = $('#togglePw');
toggle.innerHTML = ICONS.eye;
toggle.addEventListener('click', () => { pw.type = pw.type === 'password' ? 'text' : 'password'; });

formHandler(form, $('button[type=submit]', form), async (v) => {
  const r = await api.post('/api/auth/login', { username: v.username, password: v.password });
  api.csrf = r.csrf;
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && /^\/(admin|incharge)$/.test(next) ? next : null;
  const home = r.user.role === 'admin' ? '/admin' : '/incharge';
  toast(`Welcome, ${r.user.name}`, 'success', 1200);
  location.href = safeNext || home;
});
