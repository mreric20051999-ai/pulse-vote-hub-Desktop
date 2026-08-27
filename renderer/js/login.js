(function () {
  const $ = (id) => document.getElementById(id);

  const setupView = $('setup-view');
  const loginView = $('login-view');
  const setupError = $('setup-error');
  const loginError = $('login-error');

  // Version footer
  window.pvh.platform().then((info) => {
    $('auth-version').textContent = `v${info.version}`;
  });

  // Determine whether coordinator is configured
  window.pvh.setupCheck().then((configured) => {
    if (configured) {
      loginView.hidden = false;
      $('login-id').focus();
    } else {
      setupView.hidden = false;
      $('setup-name').focus();
    }
  });

  // --- Setup form ---
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setupError.textContent = '';
    const btn = $('setup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await window.pvh.setupCoordinator({
      name: $('setup-name').value,
      officerId: $('setup-id').value,
      password: $('setup-pass').value,
    });

    if (res.ok) {
      setupView.hidden = true;
      loginView.hidden = false;
      $('login-id').value = res.officer.officer_id;
      $('login-pass').focus();
    } else {
      setupError.textContent = res.error || 'Setup failed';
      btn.disabled = false;
      btn.textContent = 'Create Coordinator';
    }
  });

  // --- Login form ---
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    const res = await window.pvh.login({
      officerId: $('login-id').value,
      password: $('login-pass').value,
    });

    if (res.ok) {
      window.localStorage.setItem('pvh_session', JSON.stringify(res.officer));
      window.location.assign('dashboard.html');
    } else {
      loginError.textContent = res.error || 'Sign in failed';
      btn.disabled = false;
      btn.textContent = 'Sign in';
      $('login-pass').value = '';
      $('login-pass').focus();
    }
  });
})();
