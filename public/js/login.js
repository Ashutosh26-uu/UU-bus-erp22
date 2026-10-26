import { $, api, formHandler, ICONS, toast } from './common.js';

const form = $('#loginForm');
const pw = $('#password');
const toggle = $('#togglePw');
toggle.innerHTML = ICONS.eye;
toggle.addEventListener('click', () => { pw.type = pw.type === 'password' ? 'text' : 'password'; });
// focus the username box on wide screens only; on phones it would pop the keyboard over the photo
if (matchMedia('(min-width: 861px)').matches) $('#username').focus();

formHandler(form, $('button[type=submit]', form), async (v) => {
  const r = await api.post('/api/auth/login', { username: v.username, password: v.password });
  api.csrf = r.csrf;
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && /^\/(admin|incharge|bus\/[A-Za-z0-9%._-]+)$/.test(next) ? next : null;
  toast(`Welcome, ${r.user.name}`, 'success', 1200);
  // incharges land on their own bus portal (/bus/<number>); admins on the console
  location.href = safeNext || r.user.home || '/';
});
