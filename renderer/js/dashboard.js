(function () {
  const $ = (id) => document.getElementById(id);

  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;

  $('status-pill').innerHTML = '<span class="status-dot success"></span>Signed in';

  window.pvh.dashboardStats().then((s) => {
    $('stat-active').textContent = s.active;
    $('stat-setup').textContent = s.setup;
    $('stat-closed').textContent = s.closed;
  });

  // Refresh stats when returning to this page
  window.addEventListener('focus', () => {
    window.pvh.dashboardStats().then((s) => {
      $('stat-active').textContent = s.active;
      $('stat-setup').textContent = s.setup;
      $('stat-closed').textContent = s.closed;
    });
  });
})();
