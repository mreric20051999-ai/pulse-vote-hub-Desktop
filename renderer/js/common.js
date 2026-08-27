(function () {
  // Shared session guard + sidebar footer for authed pages
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) {
    window.location.assign('index.html');
    return;
  }

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
        const map = { dashboard: 'dashboard.html', elections: 'elections.html', voters: 'voters.html', stations: 'stations.html', admin: 'dashboard.html', officers: 'dashboard.html' };
        const target = map[navName];
        if (!target) return;
        // If we're already on the target page, don't reload — scroll to the
        // relevant section (e.g. Administration/Officers -> coordinator panel).
        if (window.location.pathname.split('/').pop() === target) {
          const anchor = (navName === 'admin' || navName === 'officers')
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
