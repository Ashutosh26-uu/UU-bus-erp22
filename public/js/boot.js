/*
 * Runs before the page is drawn (plain script in <head>, no module):
 *  - applies the saved light/dark theme so there is no flash of the wrong colours
 *  - shows the United University splash for 2 seconds the first time the site is opened in a tab
 */
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('uu_theme');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  } catch (e) { /* storage blocked */ }

  var seen = false;
  try { seen = sessionStorage.getItem('uu_splash') === '1'; } catch (e) { seen = true; }
  if (seen) return;
  root.classList.add('splash-on');
  var started = Date.now();
  var done = false;

  function finish() {
    if (done) return;
    done = true;
    var el = document.getElementById('splash');
    if (el) el.classList.add('out');
    try { sessionStorage.setItem('uu_splash', '1'); } catch (e) { /* ignore */ }
    setTimeout(function () { root.classList.remove('splash-on'); }, 460);
  }
  function schedule() {
    setTimeout(finish, Math.max(0, 2000 - (Date.now() - started)));
    var el = document.getElementById('splash');
    if (el) el.addEventListener('click', finish);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})();
