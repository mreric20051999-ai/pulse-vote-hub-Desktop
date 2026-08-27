(function () {
  const $ = (id) => document.getElementById(id);

  const views = {
    setup: $('setup-view'),
    login: $('login-view'),
    adminSetup: $('admin-setup-view'),
    adminLogin: $('admin-login-view'),
  };

  const errors = {
    setup: $('setup-error'),
    login: $('login-error'),
    adminSetup: $('admin-setup-error'),
    adminLogin: $('admin-login-error'),
  };

  function show(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== name); });
  }
  function focus(name) {
    const map = { setup: 'setup-name', login: 'login-id', adminSetup: 'admin-setup-name', adminLogin: 'admin-login-id' };
    const el = $(map[name]);
    if (el) el.focus();
  }

  // Version footer
  window.pvh.platform().then((info) => {
    $('auth-version').textContent = `v${info.version}`;
  });

  // Officer-mode entry
  window.pvh.setupCheck().then((configured) => {
    if (configured) {
      show('login');
      focus('login');
    } else {
      show('setup');
      focus('setup');
    }
  });

  // ---- Admin-mode routing (toggle links) ----
  function openAdminSetupOrLogin() {
    window.pvh.hasAdmin().then((adminExists) => {
      if (adminExists) {
        show('adminLogin');
        focus('adminLogin');
      } else {
        show('adminSetup');
        focus('adminSetup');
      }
    });
  }

  $('login-admin-link').addEventListener('click', openAdminSetupOrLogin);
  $('setup-admin-link').addEventListener('click', openAdminSetupOrLogin);
  $('admin-setup-back').addEventListener('click', () => { show('setup'); focus('setup'); });
  $('admin-login-back').addEventListener('click', () => { show('login'); focus('login'); });

  // ---- Coordinator setup ----
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.setup.textContent = '';
    const btn = $('setup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await window.pvh.setupCoordinator({
      name: $('setup-name').value,
      officerId: $('setup-id').value,
      password: $('setup-pass').value,
    });

    if (res.ok) {
      show('login');
      $('login-id').value = res.officer.officer_id;
      $('login-pass').focus();
    } else {
      errors.setup.textContent = res.error || 'Setup failed';
      btn.disabled = false;
      btn.textContent = 'Create Coordinator';
    }
  });

  // ---- Administrator (superuser) setup ----
  $('admin-setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.adminSetup.textContent = '';
    const btn = $('admin-setup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await window.pvh.setupAdmin({
      name: $('admin-setup-name').value,
      officerId: $('admin-setup-id').value,
      password: $('admin-setup-pass').value,
    });

    if (res.ok) {
      show('adminLogin');
      $('admin-login-id').value = res.officer.officer_id;
      $('admin-login-pass').focus();
    } else {
      errors.adminSetup.textContent = res.error || 'Setup failed';
      btn.disabled = false;
      btn.textContent = 'Create Administrator';
    }
  });

  // ---- Officer login (routes by role) ----
  function completeLogin(officer) {
    window.localStorage.setItem('pvh_session', JSON.stringify(officer));
    // A station officer (assistant assigned to a station) lands directly on
    // their station portal; everyone else goes to the dashboard.
    const isStationOfficer = officer.role === 'assistant' && !!officer.assigned_station_id;
    window.location.assign(isStationOfficer ? 'station.html' : 'dashboard.html');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.login.textContent = '';
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    const res = await window.pvh.login({
      officerId: $('login-id').value,
      password: $('login-pass').value,
    });

    if (res.ok) {
      completeLogin(res.officer);
    } else {
      errors.login.textContent = res.error || 'Sign in failed';
      btn.disabled = false;
      btn.textContent = 'Sign in';
      $('login-pass').value = '';
      $('login-pass').focus();
    }
  });

  // ---- Admin login ----
  $('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.adminLogin.textContent = '';
    const btn = $('admin-login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    const res = await window.pvh.login({
      officerId: $('admin-login-id').value,
      password: $('admin-login-pass').value,
    });

    if (res.ok) {
      if (res.officer.role !== 'admin') {
        errors.adminLogin.textContent = 'This account is not an administrator.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
        $('admin-login-pass').value = '';
        return;
      }
      completeLogin(res.officer);
    } else {
      errors.adminLogin.textContent = res.error || 'Sign in failed';
      btn.disabled = false;
      btn.textContent = 'Sign in';
      $('admin-login-pass').value = '';
      $('admin-login-pass').focus();
    }
  });
})();
