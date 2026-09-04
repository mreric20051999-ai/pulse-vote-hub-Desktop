(function () {
  const $ = (id) => document.getElementById(id);

  const views = {
    setup: $('setup-view'),
    login: $('login-view'),
    license: $('license-view'),
    adminSetup: $('admin-setup-view'),
    developerSetup: $('developer-setup-view'),
    developerLogin: $('developer-login-view'),
    redeem: $('redeem-view'),
    recovery: $('recovery-view'),
    recoverySave: $('recovery-save-view'),
  };

  const errors = {
    setup: $('setup-error'),
    login: $('login-error'),
    license: $('license-error'),
    adminSetup: $('admin-setup-error'),
    developerSetup: $('dev-setup-error'),
    developerLogin: $('dev-login-error'),
    redeem: $('redeem-error'),
    recovery: $('recovery-error'),
    recoverySave: $('recovery-save-error'),
  };

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  function show(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== name); });
  }

  // ---- Password visibility toggle (eye) ----
  // Wrap a password input in a .password-wrap with an eye toggle button.
  function addPassToggle(input) {
    if (!input) return;
    const wrap = input.parentElement;
    if (!wrap || !wrap.classList.contains('password-wrap')) return;
    const toggle = wrap.querySelector('.password-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const showPw = input.type === 'password';
      input.type = showPw ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(showPw));
      toggle.setAttribute('aria-label', showPw ? 'Hide password' : 'Show password');
    });
  }
  function buildPassToggle() {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'password-toggle';
    t.setAttribute('aria-label', 'Show password');
    t.setAttribute('aria-pressed', 'false');
    t.innerHTML = `
      <svg class="eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    return t;
  }
  function attachPassToggle(id) {
    const input = $(id);
    if (!input) return;
    const wrap = input.parentElement;
    if (!wrap) return;
    if (wrap.classList.contains('password-wrap')) { addPassToggle(input); return; }
    const w = document.createElement('div');
    w.className = 'password-wrap';
    input.parentNode.insertBefore(w, input);
    w.appendChild(input);
    const toggle = buildPassToggle();
    w.appendChild(toggle);
    addPassToggle(input);
  }

  const passFields = ['login-pass', 'setup-pass', 'admin-setup-code', 'admin-setup-code-confirm', 'admin-setup-pass', 'dev-setup-pass', 'dev-setup-key', 'dev-setup-key-confirm', 'dev-login-pass', 'dev-login-pass-confirm', 'redeem-pass', 'redeem-pass-confirm', 'recovery-pass', 'recovery-pass-confirm', 'recovery-code'];
  passFields.forEach(attachPassToggle);

  function focus(name) {
    const map = { setup: 'setup-name', login: 'login-id', license: 'license-code', adminSetup: 'admin-setup-name', developerSetup: 'dev-setup-name', developerLogin: 'dev-login-id', redeem: 'redeem-code', recovery: 'recovery-id', recoverySave: 'recovery-save-done' };
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

  // Officer-mode entry. An already-configured machine signs straight in; a
  // fresh machine must first activate its license before first-run setup.
  window.pvh.setupCheck().then((configured) => {
    if (configured) {
      show('login');
      focus('login');
      return;
    }
    const proceedToSetup = () => { show('setup'); focus('setup'); };
    window.pvh.licenseStatus().then((lic) => {
      if (lic && lic.licensed) proceedToSetup();
      else { show('license'); focus('license'); }
    }).catch(() => proceedToSetup());
  });

  // ---- License activation submit (first-run gate) ----
  $('license-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.license.textContent = '';
    const btn = $('license-btn');
    btn.disabled = true;
    btn.textContent = 'Activating…';

    const res = await window.pvh.activateLicense($('license-code').value);

    if (res.ok) {
      show('setup');
      focus('setup');
    } else {
      errors.license.textContent = res.error || 'Could not activate this license.';
      btn.disabled = false;
      btn.textContent = 'Activate license';
      $('license-code').focus();
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

  // ---- Developer bootstrap (root role, dedicated key) ----
  // After the main developer exists, the hidden gesture opens the compact
  // Developer sign-in (code + ID + password) rather than the setup form.
  function openDeveloperSetupOrLogin() {
    window.pvh.hasDeveloper().then((devExists) => {
      if (devExists) {
        show('developerLogin');
        focus('developerLogin');
      } else {
        show('developerSetup');
        focus('developerSetup');
      }
    });
  }
  const devSetupBack = () => {
    window.pvh.setupCheck().then((configured) => { show(configured ? 'login' : 'setup'); focus(configured ? 'login' : 'setup'); });
  };
  // Developer bootstrap is deliberately hidden from the public first-run flow.
  // The only entry point is the hidden keyboard shortcut (Ctrl/⌘+Shift+D) so
  // installers and end users never see a developer option.
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) {
      ev.preventDefault();
      // The developer bootstrap must only open on a machine that is already
      // licensed or already has a developer account. On a fresh, unactivated
      // user machine this gesture is ignored so activation cannot be bypassed.
      window.pvh.canDeveloperBootstrap().then((allowed) => {
        if (allowed) openDeveloperSetupOrLogin();
      }).catch(() => {});
    }
  });
  $('developer-setup-back').addEventListener('click', devSetupBack);
  $('developer-login-back').addEventListener('click', devSetupBack);

  // The developer key is issued server-side (private channel); no per-machine
  // provisioning hint is needed any more.

  // ---- Access-code redemption (one-time code issued by an admin) ----
  function openRedeem() {
    show('redeem');
    focus('redeem');
  }
  $('login-redeem-link').addEventListener('click', openRedeem);
  $('redeem-back').addEventListener('click', () => {
    window.pvh.setupCheck().then((configured) => { show(configured ? 'login' : 'setup'); focus(configured ? 'login' : 'setup'); });
  });

  // ---- Break-glass password recovery (admin/developer) ----
  const forgotLink = $('login-forgot-link');
  const recoveryBack = $('recovery-back');
  const recoveryCodeBox = $('recovery-save-code');

  // Only offer recovery when a break-glass code actually exists on this machine.
  window.pvh.hasRecoveryCode().then((ok) => {
    if (forgotLink) forgotLink.hidden = !ok;
  }).catch(() => {});

  if (forgotLink) {
    forgotLink.addEventListener('click', () => { show('recovery'); focus('recovery'); });
  }
  if (recoveryBack) {
    recoveryBack.addEventListener('click', () => { show('login'); focus('login'); });
  }

  $('recovery-save-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodeBox.textContent.trim());
      errors.recoverySave.textContent = 'Recovery code copied.';
    } catch (err) {
      errors.recoverySave.textContent = 'Unable to copy — write the code down manually.';
    }
  });

  $('recovery-save-done').addEventListener('click', () => { show('login'); focus('login'); });

  // Submit the recovery form.
  $('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.recovery.textContent = '';
    const btn = $('recovery-btn');
    const target = errors.recovery;
    const officerId = $('recovery-id').value;
    const recoveryCode = $('recovery-code').value;
    const newPassword = $('recovery-pass').value;
    const confirm = $('recovery-pass-confirm').value;

    if (newPassword !== confirm) {
      target.textContent = 'Passwords do not match.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Resetting…';

    try {
      const res = await window.pvh.recoverPassword(officerId, recoveryCode, newPassword);
      if (res.ok) {
        // Back to sign-in with the reset credentials pre-filled.
        show('login');
        $('login-id').value = res.officer.officer_id;
        $('login-pass').value = '';
        errors.login.textContent = 'Password reset successfully. Sign in with your new password.';
        focus('login');
      } else {
        if (res.code !== 'locked') {
          target.textContent = res.error || 'Could not reset the password.';
        } else {
          target.textContent = res.error + (res.retryAfterMs ? ` Retry in a minute.` : '');
        }
        $('recovery-code').value = '';
        $('recovery-code').focus();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reset password';
    }
  });

  // ---- First-run join toggle: Import a Location Run Pack <-> Redeem ------
  // A compact segmented switch replaces two stacked full-width buttons so
  // both first-run options fit in one row.
  const importPanels = {
    open() {
      const err = $('setup-import-error'); if (err) err.textContent = '';
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
    },
  };

  function setFirstRunTab(pane) {
    document.querySelectorAll('.first-run-tab').forEach((t) => {
      const active = t.dataset.pane === pane;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
  }
  document.querySelectorAll('.first-run-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      setFirstRunTab(tab.dataset.pane);
      if (tab.dataset.pane === 'redeem') openRedeem();
      else importPanels.open();
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
        const optional = opts.optionalIdx && opts.optionalIdx.includes(idx);
        const inp = vals[idx];
        if (!optional && (!inp || !inp.value.trim())) { if (inp) inp.focus(); return; }
        if (opts.onStepNext) opts.onStepNext(idx);
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
        const optional = opts.optionalIdx && opts.optionalIdx.includes(idx);
        if (!optional && !inp.value.trim()) return;
        if (opts.onStepNext) opts.onStepNext(idx);
        move(idx + 1);
      });
    }

    showStep(0);
  }

  initSetupSteps({ formId: 'setup-form', dotsId: '#setup-dots', fieldIds: ['setup-name', 'setup-id', 'setup-pass'] });
  initSetupSteps({ formId: 'admin-setup-form', dotsId: '#admin-setup-dots', fieldIds: ['admin-setup-name', 'admin-setup-id', 'admin-setup-code', 'admin-setup-pass'] });
  initSetupSteps({ formId: 'developer-setup-form', dotsId: '#developer-setup-dots', fieldIds: ['dev-setup-name', 'dev-setup-id', 'dev-setup-pass', 'dev-setup-key'] });
  initSetupSteps({ formId: 'redeem-form', dotsId: '#redeem-dots', fieldIds: ['redeem-code', 'redeem-name', 'redeem-id', 'redeem-pass'] });
  initSetupSteps({ formId: 'recovery-form', dotsId: '#recovery-dots', fieldIds: ['recovery-id', 'recovery-code', 'recovery-pass'] });

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
      const code = res.recoveryCode;
      if (code && recoveryCodeBox) {
        recoveryCodeBox.textContent = code;
        errors.recoverySave.textContent = '';
        show('recoverySave');
        focus('recoverySave');
      } else {
        show('login');
        $('login-id').value = res.officer.officer_id;
        $('login-pass').focus();
      }
    } else {
      errors.adminSetup.textContent = res.error || 'Setup failed';
      btn.disabled = false;
      btn.textContent = 'Create Administrator';
    }
  });

  // ---- Developer bootstrap submit ----
  $('developer-setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errors.developerSetup.textContent = '';

    const res = await window.pvh.setupDeveloper({
      name: $('dev-setup-name').value,
      officerId: $('dev-setup-id').value,
      password: $('dev-setup-pass').value,
      devKey: $('dev-setup-key').value,
    });

    if (res.ok) {
      show('login');
      $('login-id').value = res.officer.officer_id;
      $('login-pass').focus();
    } else {
      errors.developerSetup.textContent = res.error || 'Setup failed';
    }
  });

  // ---- Developer sign-in (stepped: short code → ID → password) ----
  // The short code step is optional: existing developers skip it. The confirm
  // field only appears when a first-time developer enters a short code.
  const devLoginCode = $('dev-login-code');
  const devLoginConfirmField = $('dev-login-confirm-field');
  const devLoginConfirm = $('dev-login-pass-confirm');
  // The short code decides the mode: blank code = an existing developer signing
  // in (no confirmation), a code = a brand-new developer creating an account
  // (confirmation required). This decision is locked in when the user clicks
  // Continue on the short-code step.
  let devIsNew = false;
  const syncDevLoginMode = () => {
    devIsNew = (devLoginCode.value || '').trim().length > 0;
    if (devLoginConfirmField) devLoginConfirmField.hidden = !devIsNew;
    if (devLoginConfirm) devLoginConfirm.required = devIsNew;
    $('dev-login-btn').textContent = devIsNew ? 'Create developer account' : 'Sign in';
  };
  initSetupSteps({
    formId: 'developer-login-form',
    dotsId: '#developer-login-dots',
    fieldIds: ['dev-login-code', 'dev-login-id', 'dev-login-pass'],
    optionalIdx: [0],
    onStepNext: syncDevLoginMode,
  });

  $('developer-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = errors.developerLogin;
    errEl.textContent = '';
    const btn = $('dev-login-btn');
    btn.disabled = true;
    btn.textContent = 'Working…';

    const code = (devLoginCode.value || '').trim();
    const officerId = $('dev-login-id').value;
    const password = $('dev-login-pass').value;

    try {
      if (devIsNew) {
        // First-time developer: redeem the short code and create the account,
        // then hand over to the normal login to sign in.
        const res = await window.pvh.redeemDeveloperCode({
          code,
          officerId,
          password,
          confirmPassword: (devLoginConfirm || {}).value || '',
        });
        if (!res.ok) { errEl.textContent = res.error || 'Could not create your developer account.'; return; }
        show('login');
        $('login-id').value = res.officer.officer_id;
        $('login-pass').focus();
      } else {
        const res = await window.pvh.login({ officerId, password });
        if (res.ok) {
          completeLogin(res.officer, res.session && res.session.token);
        } else {
          applyAuthResult(res, errEl, $('dev-login-btn'), 'Sign in');
          $('dev-login-pass').value = '';
          $('dev-login-pass').focus();
        }
      }
    } finally {
      btn.disabled = false;
      syncDevLoginMode();
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
      // A failed sign-in must leave the button usable again for a retry.
      // applyAuthResult re-enables the button itself only for the "locked"
      // case (after a delay). Any other failure falls through with the button
      // still disabled from the "Signing in..." state, so reset it here —
      // otherwise it stays stuck until the app is reloaded.
      if (res.code !== 'locked' && btn.disabled) {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
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
