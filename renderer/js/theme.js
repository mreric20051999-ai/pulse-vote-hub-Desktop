// Apply the saved theme before first paint to avoid a dark->light flash.
// Loaded in <head> before the stylesheets. 'system' is resolved after load
// (common.js) because it needs the main process's nativeTheme answer.
// Also owns the shared sidebar collapse toggle (works on every page).
(function () {
  try {
    const p = JSON.parse(window.localStorage.getItem('pvh_prefs') || '{}');
    if (p.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else if (p.theme === 'dark') document.documentElement.removeAttribute('data-theme');
    if (p.sidebarCollapsed) document.documentElement.classList.add('sidebar-collapsed-bp');
  } catch (e) { /* keep default */ }

  function readPrefs() {
    try { return JSON.parse(window.localStorage.getItem('pvh_prefs') || '{}'); } catch (e) { return {}; }
  }
  function writePrefs(p) {
    try { window.localStorage.setItem('pvh_prefs', JSON.stringify(p)); } catch (e) { /* noop */ }
  }
  function setCollapsed(collapsed) {
    document.documentElement.classList.remove('sidebar-collapsed-bp');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const p = readPrefs();
    p.sidebarCollapsed = !!collapsed;
    writePrefs(p);
    const btn = document.getElementById('sidebar-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
  }

  function initSidebarToggle() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || sidebar.querySelector('.sidebar-toggle')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sidebar-toggle';
    btn.className = 'sidebar-toggle';
    btn.setAttribute('aria-label', 'Toggle sidebar');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="15 18 9 12 15 6"></polyline></svg>';
    let lastToggle = 0;
    btn.addEventListener('click', (e) => {
      // Rapid clicks/double-clicks must collapse to a single toggle, otherwise the
      // sidebar toggles twice in quick succession and "shoots" around mid-animation.
      // Ignore any activation that lands within the double-click window of the last,
      // regardless of whether the browser reports it with event.detail > 1.
      if (e && e.detail > 1) return;
      const now = Date.now();
      if (now - lastToggle < 350) return;
      lastToggle = now;
      const collapsed = !document.body.classList.contains('sidebar-collapsed');
      setCollapsed(collapsed);
    });
    sidebar.appendChild(btn);

    const prefs = readPrefs();
    setCollapsed(!!prefs.sidebarCollapsed);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarToggle);
  } else {
    initSidebarToggle();
  }
})();
