// Apply the saved theme before first paint to avoid a dark->light flash.
// Loaded in <head> before the stylesheets. 'system' is resolved after load
// (common.js) because it needs the main process's nativeTheme answer.
(function () {
  try {
    const p = JSON.parse(window.localStorage.getItem('pvh_prefs') || '{}');
    if (p.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else if (p.theme === 'dark') document.documentElement.removeAttribute('data-theme');
  } catch (e) { /* keep default */ }
})();