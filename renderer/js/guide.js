(function () {
  // Land back where the officer belongs: the station portal for a station
  // officer, the dashboard for everyone else, the sign-in screen if no
  // session survived.
  function backToApp() {
    let s = null;
    try {
      s = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
    } catch (e) {
      s = null;
    }
    if (!s || !s.id) {
      window.location.assign('index.html');
      return;
    }
    const stationOfficer = s.role === 'assistant' && !!s.assigned_station_id;
    window.location.assign(stationOfficer ? 'station.html' : 'dashboard.html');
  }

  function initGuide() {
    if (window.pvhIcons) window.pvhIcons.inject('.icon');
    const openApp = document.getElementById('guide-open-app');
    if (openApp) openApp.addEventListener('click', backToApp);
    const printBtn = document.getElementById('guide-print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGuide);
  } else {
    initGuide();
  }
})();