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
      </div>`;
    footer.querySelector('.officer-name').textContent = session.name;
    footer.querySelector('.officer-role').textContent = session.role;
  }

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
        const map = { dashboard: 'dashboard.html', elections: 'elections.html', voters: 'voters.html' };
        if (map[navName]) window.location.assign(map[navName]);
      });
    });
  }
})();
