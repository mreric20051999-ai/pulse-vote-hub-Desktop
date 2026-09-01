(function () {
  const $ = (id) => document.getElementById(id);

  const views = {
    setup: $('setup-view'),
    login: $('login-view'),
    adminSetup: $('admin-setup-view'),
    redeem: $('redeem-view'),
  };

  const errors = {
    setup: $('setup-error'),
    login: $('login-error'),
    adminSetup: $('admin-setup-error'),
    redeem: $('redeem-error'),
  };

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  function show(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== name); });
  }

  // ---- Password visibility toggle (eye) ----
  const passInput = $('login-pass');
  const passToggle = $('login-pass-toggle');
  if (passInput && passToggle) {
    passToggle.addEventListener('click', () => {
      const showPw = passInput.type === 'password';
      passInput.type = showPw ? 'text' : 'password';
      passToggle.setAttribute('aria-pressed', String(showPw));
      passToggle.setAttribute('aria-label', showPw ? 'Hide password' : 'Show password');
    });
  }

  function focus(name) {
    const map = { setup: 'setup-name', login: 'login-id', adminSetup: 'admin-setup-name', redeem: 'redeem-code' };
    const el = $(map[name]);
    if (el) el.focus();
  }

  // Format a lockout delay like "3m 45s" for the error text.
  function formatRetry(ms) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${s}s`;
  }

  // Shared handling for both login forms: normalizes the auth result message
  // and disables the form while an account is locked out.
  function applyAuthResult(res, errEl, btn, idleLabel) {
    if (res.code === 'locked') {
      errEl.textContent = res.error + (res.retryAfterMs ? ` Retry in ${formatRetry(res.retryAfterMs)}.` : '');
      btn.disabled = true;
      btn.textContent = 'Locked';
      setTimeout(() => {
        errEl.textContent = '';
        btn.disabled = false;
        btn.textContent = idleLabel;
      }, Math.min(res.retryAfterMs || 0, 2147483647));
      return;
    }
    if (res.code === 'invalid' && res.remaining && res.remaining <= 3) {
      errEl.textContent = `${res.error}. ${res.remaining} attempt${res.remaining === 1 ? '' : 's'} remaining before lockout.`;
      return;
    }
    errEl.textContent = res.error || 'Sign in failed';
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

  // ---- Admin-mode routing (setup toggle) ----
  // There is no separate administrator sign-in any more: every account signs
  // in through the single form. The first-run toggle only opens admin setup
  // while no administrator exists yet.
  function openAdminSetupOrLogin() {
    window.pvh.hasAdmin().then((adminExists) => {
      if (adminExists) {
        show('login');
        focus('login');
      } else {
        show('adminSetup');
        focus('adminSetup');
      }
    });
  }

  $('setup-admin-link').addEventListener('click', openAdminSetupOrLogin);
  $('admin-setup-back').addEventListener('click', () => { show('setup'); focus('setup'); });

  // ---- Access-code redemption (one-time code issued by an admin) ----
  function openRedeem() {
    show('redeem');
    focus('redeem');
  }
  $('setup-redeem-link').addEventListener('click', openRedeem);
  $('login-redeem-link').addEventListener('click', openRedeem);
  $('redeem-back').addEventListener('click', () => {
    window.pvh.setupCheck().then((configured) => { show(configured ? 'login' : 'setup'); focus(configured ? 'login' : 'setup'); });
  });

  // ---- First-run: import a Location Run Pack (fresh machine) ----
  $('setup-import-run').addEventListener('click', async () => {
    const err = $('setup-import-error');
    err.textContent = '';
    const overlay = document.createElement('div');
    overlay.className = 'pvh-modal-overlay';
    overlay.innerHTML = `
      <div class="pvh-modal" role="dialog" aria-modal="true" style="width:min(520px,92vw)">
        <header class="pvh-modal-head">
          <h2 class="pvh-modal-title">Import a Location Run Pack</h2>
          <button type="button" class="pvh-modal-close" aria-label="Close">×</button>
        </header>
        <div class="pvh-modal-body">
          <p class="text-muted mb">Choose the run pack file from your main coordinator, then enter its passphrase and the setup code to create your location coordinator account.</p>
          <p class="auth-error" id="first-import-err"></p>
          <div class="field">
            <label class="label" for="fi-pass">Passphrase</label>
            <input class="input" type="password" id="fi-pass" autocomplete="new-password" placeholder="Set by the main coordinator">
          </div>
          <div class="field">
            <label class="label" for="fi-setup">Setup code</label>
            <input class="input" type="text" id="fi-setup" placeholder="e.g. AB12CD34EF56">
          </div>
          <button class="btn btn-primary btn-block" id="fi-go">Choose file &amp; import</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.pvh-modal-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#fi-go').addEventListener('click', async () => {
      const pass = overlay.querySelector('#fi-pass').value.trim();
      const setup = overlay.querySelector('#fi-setup').value.trim();
      const b = overlay.querySelector('#fi-go');
      b.disabled = true; b.textContent = 'Importing…';
      const res = await window.pvh.importRunPack({ passphrase: pass, setupCode: setup });
      if (res && res.canceled) { b.disabled = false; b.textContent = 'Choose file & import'; return; }
      if (!res || !res.ok) {
        overlay.querySelector('#first-import-err').textContent = (res && res.error) || 'Import failed';
        b.disabled = false; b.textContent = 'Choose file & import';
        return;
      }
      // After import, log into the freshly-created location coordinator account.
      const login = await window.pvh.login({ officerId: res.coordinator.officer_id, password: setup });
      if (login.ok) {
        const officer = login.officer;
        const session = Object.assign({}, officer, login.session && login.session.token ? { token: login.session.token } : {});
        window.localStorage.setItem('pvh_session', JSON.stringify(session));
        window.location.assign('location-runs.html');
      } else {
        overlay.querySelector('#first-import-err').textContent = 'Imported. Sign in with the setup code to continue.';
        show('login'); focus('login');
        $('login-id').value = res.coordinator.officer_id;
        $('login-pass').value = setup;
      }
      close();
    });
  });

  // ---- Stepped setup (name → id → password) for coordinator & admin ----
  function initSetupSteps(opts) {
    const form = $(opts.formId);
    if (!form) return;
    const steps = Array.from(form.querySelectorAll('.setup-step'));
    const dots = Array.from(document.querySelectorAll(opts.dotsId + ' .step-dot'));
    if (steps.length < 2) return;
    const vals = opts.fieldIds.map((id) => $(id));
    let current = 0;

    function showStep(i, dir) {
      if (dots.length) dots.forEach((d, k) => d.classList.toggle('is-active', k === i));
      const el = steps[i];
      el.hidden = false;
      el.classList.toggle('is-back', dir === 'back');
      el.classList.remove('is-processing');
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      const inp = vals[i];
      if (inp) inp.focus();
    }

    function move(i) {
      if (i < 0 || i >= steps.length || i === current) return;
      const dir = i > current ? 'forward' : 'back';
      const cur = steps[current];
      cur.classList.add('is-processing');
      cur.classList.toggle('is-back', dir === 'back');
      const onEnd = () => {
        cur.removeEventListener('animationend', onEnd);
        cur.hidden = true;
        cur.classList.remove('is-processing', 'is-back');
        current = i;
        showStep(i, dir);
      };
      cur.addEventListener('animationend', onEnd);
    }

    form.querySelectorAll('.step-next').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const inp = vals[idx];
        if (!inp || !inp.value.trim()) { if (inp) inp.focus(); return; }
        move(idx + 1);
      });
    });

    form.querySelectorAll('.step-back').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stepNo = Number((btn.closest('.setup-step') || {}).dataset.step || 0);
        move(stepNo - 2);
      });
    });

    for (let idx = 0; idx < vals.length - 1; idx++) {
      const inp = vals[idx];
      if (!inp) continue;
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!inp.value.trim()) return;
        move(idx + 1);
      });
    }

    showStep(0);
  }

  initSetupSteps({ formId: 'setup-form', dotsId: '#setup-dots', fieldIds: ['setup-name', 'setup-id', 'setup-pass'] });
  initSetupSteps({ formId: 'admin-setup-form', dotsId: '#admin-setup-dots', fieldIds: ['admin-setup-name', 'admin-setup-id', 'admin-setup-code', 'admin-setup-pass'] });

  // Explain the setup code step depending on whether this machine has already
  // been provisioned with a setup code.
  const setupHint = $('admin-setup-code-hint');
  window.pvh.hasSetupCode().then((codeExists) => {
    if (setupHint) {
      setupHint.textContent = codeExists
        ? 'Enter the setup code provisioned for this machine to claim the administrator account.'
        : 'Choose a setup code to lock down the administrator account on this machine. Keep it safe — it cannot be changed later.';
    }
  });

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
    const name = $('admin-setup-name').value;
    const officerId = $('admin-setup-id').value;
    const password = $('admin-setup-pass').value;
    const setupCode = $('admin-setup-code').value;
    const confirmSetupCode = $('admin-setup-code-confirm').value;

    const btn = $('admin-setup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await window.pvh.setupAdmin({
      name,
      officerId,
      password,
      setupCode,
      confirmSetupCode,
    });

    if (res.ok) {
      show('login');
      $('login-id').value = res.officer.officer_id;
      $('login-pass').focus();
    } else {
      errors.adminSetup.textContent = res.error || 'Setup failed';
      btn.disabled = false;
      btn.textContent = 'Create Administrator';
    }
  });

  // ---- Officer login (routes by role) ----
  function completeLogin(officer, token) {
    const session = Object.assign({}, officer, token ? { token } : {});
    window.localStorage.setItem('pvh_session', JSON.stringify(session));
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
      completeLogin(res.officer, res.session && res.session.token);
    } else {
      applyAuthResult(res, errors.login, $('login-btn'), 'Sign in');
      $('login-pass').value = '';
      $('login-pass').focus();
    }
  });

  // ---- Access code redemption submit ----
  $('redeem-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.redeem.textContent = '';
    const btn = $('redeem-btn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await window.pvh.redeemSetupCode({
      code: $('redeem-code').value,
      name: $('redeem-name').value,
      officerId: $('redeem-id').value,
      password: $('redeem-pass').value,
      confirmPassword: $('redeem-pass-confirm').value,
    });

    if (res.ok) {
      completeLogin(res.officer, null);
    } else {
      errors.redeem.textContent = res.error || 'Could not create your account';
      btn.disabled = false;
      btn.textContent = 'Create account';
    }
  });
})();
