// Turas Lúbtha website: light/dark switch, sections sliding in, the year.
(function () {
  var root = document.documentElement;
  var KEY = 'tl-theme';
  var saved = function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  // The sun/moon button: switch, and remember the choice on this device.
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    var label = function () { btn.setAttribute('aria-label', root.dataset.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); };
    label();
    btn.addEventListener('click', function () {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) { /* private window */ }
      label();
    });
  });
  // No choice saved: follow the device when it switches between light and dark.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var follow = function () { if (!saved()) root.dataset.theme = mq.matches ? 'dark' : 'light'; };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }
  // Sections slide in as they scroll into view.
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  } else items.forEach(function (el) { el.classList.add('in'); });
  var y = document.getElementById('year'); if (y) y.textContent = new Date().getFullYear();
})();
