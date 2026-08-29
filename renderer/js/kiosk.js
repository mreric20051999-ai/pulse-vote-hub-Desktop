// Kiosk lockdown for public voting screens. Engages fullscreen, hides the
// cursor after idle, blocks the context menu, re-locks if Escape is pressed,
// and tells the main process to swallow window shortcuts (F11 / reload /
// devtools / close) while this page lives. Navigation to another page clears
// fullscreen automatically; the main-process shortcut guard is released via
// pvh.kioskExit() on the way out. Dev override: set localStorage
// "pvh_kiosk_disabled" = "1" before loading to skip auto-engage.
(function () {
  if (localStorage.getItem('pvh_kiosk_disabled') === '1') return;

  let cursorTimer = null;

  // Hide the cursor until the operator moves the mouse again.
  function armCursorHide() {
    clearTimeout(cursorTimer);
    document.documentElement.classList.add('hide-cursor');
    cursorTimer = setTimeout(() => {
      if (document.fullscreenElement) document.documentElement.classList.add('hide-cursor');
    }, 2500);
  }

  // Show the cursor on movement, then re-arm hiding after idle.
  function showCursor() {
    document.documentElement.classList.remove('hide-cursor');
    armCursorHide();
  }

  function requestFull() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
        document.documentElement.classList.add('hide-cursor');
      }
    } catch (e) { /* fullscreen unavailable */ }
  }

  // Escape normally exits fullscreen — immediately re-lock the kiosk.
  function onFullscreenChange() {
    if (document.fullscreenElement) {
      armCursorHide();
    } else {
      setTimeout(requestFull, 120);
    }
  }

  window.pvhKiosk = {
    enter() {
      document.body.classList.add('kiosk');
      requestFull();
      document.addEventListener('contextmenu', (e) => e.preventDefault());
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('mousemove', showCursor);
      document.addEventListener('mousedown', showCursor);
      document.addEventListener('keydown', showCursor);
      armCursorHide();
      try { window.pvh.kioskEnter(); } catch (e) { /* main-process guard optional */ }
    },
    exit() {
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
      document.documentElement.classList.remove('hide-cursor');
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      try { window.pvh.kioskExit(); } catch (e) { /* ignore */ }
    },
  };

  document.addEventListener('DOMContentLoaded', () => window.pvhKiosk.enter());
  window.addEventListener('beforeunload', () => {
    try { window.pvh.kioskExit(); } catch (e) { /* ignore */ }
  });
})();