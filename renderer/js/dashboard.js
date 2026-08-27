(function () {
  const $ = (id) => document.getElementById(id);

  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');

  if (!session) {
    window.location.assign('index.html');
    return;
  }

  $('officer-name').textContent = session.name;
  $('officer-role').textContent = session.role;
  $('status-pill').textContent = 'Signed in';
  $('status-pill').classList.toggle('pill-info', true);
  $('status-pill').querySelector('.status-dot').classList.add('success');

  window.pvh.dashboardStats().then((s) => {
    $('stat-active').textContent = s.active;
    $('stat-setup').textContent = s.setup;
    $('stat-closed').textContent = s.closed;
  });

  $('logout-btn').addEventListener('click', () => {
    window.localStorage.removeItem('pvh_session');
    window.location.assign('index.html');
  });

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
    });
  });
})();
