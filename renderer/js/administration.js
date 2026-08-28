(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  // Administration is admin-only; a non-admin shouldn't be here.
  if (session.role !== 'admin') { window.location.assign('dashboard.html'); return; }
  document.body.classList.add('is-admin');
  const $ = (id) => document.getElementById(id);

  // ---------- Section sub-menu ----------
  const links = [...document.querySelectorAll('.section-links .sub-link')];
  function setActive(name) {
    links.forEach((l) => l.classList.toggle('active', l.dataset.target === name));
  }
  links.forEach((l) => {
    l.addEventListener('click', (e) => {
      e.preventDefault();
      const el = document.getElementById(l.dataset.target);
      if (!el) return;
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      setActive(l.dataset.target);
      history.replaceState(null, '', '#' + l.dataset.target);
    });
  });
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) setActive(en.target.id); });
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.ofc-section').forEach((s) => spy.observe(s));
  }
  const initial = location.hash.replace('#', '');
  if (initial) setActive(initial);

  // ---------- Backup & export ----------
  function bindBackup() {
    const msg = $('backup-msg');
    $('backup-db-btn').addEventListener('click', async () => {
      msg.textContent = '';
      const res = await window.pvh.backupDatabase();
      msg.textContent = res.ok ? `Backup saved to ${res.path}` : (res.error || 'Backup failed');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
    });
    $('export-election-btn').addEventListener('click', async () => {
      msg.textContent = '';
      const list = await window.pvh.listElections();
      if (!list.length) {
        msg.textContent = 'No elections to export yet.';
        msg.className = 'auth-error';
        return;
      }
      const target = list.find((e) => e.status === 'active') || list[0];
      const res = await window.pvh.exportElection(target.id);
      msg.textContent = res.ok ? `Exported "${target.title}" to ${res.path}` : (res.error || 'Export failed');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
    });
  }

  // ---------- My account ----------
  function bindMyPassword() {
    $('my-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('my-password-msg');
      const pw = $('my-new-pass').value;
      if (pw.length < 6) {
        msg.textContent = 'Password must be at least 6 characters';
        msg.className = 'auth-error';
        return;
      }
      const res = await window.pvh.changePassword(session.id, pw);
      msg.textContent = res.ok ? 'Password updated.' : (res.error || 'Failed to update password');
      msg.className = res.ok ? 'notice-ok' : 'auth-error';
      if (res.ok) $('my-new-pass').value = '';
    });
  }

  bindBackup();
  bindMyPassword();
})();
