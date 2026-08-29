(function () {
  // Shared session guard + sidebar footer for authed pages
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) {
    window.location.assign('index.html');
    return;
  }

  if (session.role === 'admin') document.body.classList.add('is-admin');

  const footer = document.getElementById('sidebar-footer');
  if (footer) {
    footer.innerHTML = `
      <div class="officer-chip">
        <div class="officer-name"></div>
        <div class="officer-role"></div>
        <button class="btn btn-ghost btn-sm logout-btn" id="logout-btn">Sign out</button>
      </div>`;
    footer.querySelector('.officer-name').textContent = session.name;
    footer.querySelector('.officer-role').textContent = session.role;
    footer.querySelector('#logout-btn').addEventListener('click', () => {
      window.localStorage.removeItem('pvh_session');
      window.location.assign('index.html');
    });
  }

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  // ---- Global action feedback: toasts + busy buttons ----
  const toastsRoot = (() => {
    const root = document.createElement('div');
    root.className = 'toasts';
    document.body.appendChild(root);
    return root;
  })();

  function toast(msg, type, ms) {
    type = type || 'info';
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    toastsRoot.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-leave');
      setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
    }, ms || 2800);
    return el;
  }

  // Temporarily switch a button into a busy (spinner + label) state while `fn`
  // runs, then restore it exactly. Returns whatever `fn` resolves to.
  async function busy(btn, busyLabel, fn) {
    if (!btn) return fn ? await fn() : undefined;
    if (btn.disabled) return fn ? await fn() : undefined;
    const prev = { html: btn.innerHTML, disabled: btn.disabled };
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = '';
    const sp = document.createElement('span');
    sp.className = 'btn-spinner';
    sp.setAttribute('aria-hidden', 'true');
    btn.appendChild(sp);
    const lbl = document.createElement('span');
    lbl.textContent = busyLabel || 'Please wait…';
    btn.appendChild(lbl);
    try {
      return await fn();
    } finally {
      btn.innerHTML = prev.html;
      btn.disabled = prev.disabled;
      btn.classList.remove('is-busy');
    }
  }

  window.pvhUI = { toast, busy };

  const nav = document.getElementById('nav');
  if (nav) {
    // Highlight current page based on data-nav matching active class already set
    nav.querySelectorAll('.nav-item').forEach((a) => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript')) return; // real navigations proceed
        e.preventDefault();
        const navName = a.getAttribute('data-nav');
        // Navigate to the matching page if it exists
        const map = { dashboard: 'dashboard.html', elections: 'elections.html', voters: 'voters.html', stations: 'stations.html', results: 'results.html', admin: 'administration.html', officers: 'officers.html' };
        const target = map[navName];
        if (!target) return;
        // If we're already on the target page, don't reload — scroll to the
        // relevant section (e.g. Administration -> coordinator panel).
        if (window.location.pathname.split('/').pop() === target) {
          const anchor = (navName === 'admin')
            ? document.getElementById('coordinators-panel')
            : null;
          if (anchor) { anchor.scrollIntoView({ behavior: 'auto', block: 'start' }); }
          return;
        }
        window.location.assign(target);
      });
    });
  }
})();
