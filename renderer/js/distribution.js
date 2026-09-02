// Creator console: product distribution (downloads + local install register).
// Runs only inside the developer page; every IPC call is also role-gated to the
// developer role on the main-process side.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const installsEl = $('dist-stat-installs');
  const downloadsEl = $('dist-stat-downloads');
  const releasesEl = $('dist-stat-releases');
  const msgEl = $('dist-github-msg');
  let cachedDeployments = [];

  const fmtNum = (n) => (n == null ? 0 : Number(n).toLocaleString());
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtSize = (b) => {
    if (!b) return '';
    const k = b / 1024;
    return k > 1024 * 1024 ? `${(k / 1024 / 1024).toFixed(1)} GB` : k > 1024 ? `${(k / 1024).toFixed(1)} MB` : `${Math.round(k)} KB`;
  };

  function injectIcons() { if (window.pvhIcons) window.pvhIcons.inject('#distribution .icon'); }

  // ---------- Install register ----------
  async function loadRegister() {
    const res = await window.pvh.listDeployments();
    if (!res || res.ok === false) { $('dist-rows').innerHTML = `<p class="auth-error">${esc((res && res.error) || 'Could not load the register.')}</p>`; return; }
    cachedDeployments = res.deployments || [];
    installsEl.textContent = fmtNum(cachedDeployments.length);

    if (!cachedDeployments.length) {
      $('dist-rows').innerHTML = '<p class="text-muted hint">Nothing recorded yet. Use "Register this computer" or add entries above.</p>';
      return;
    }
    $('dist-rows').innerHTML = cachedDeployments.map((d) => `
      <div class="dist-row">
        <div class="dist-row-main">
          <div class="dist-row-name">${esc(d.machine_name)}</div>
          <div class="dist-row-meta">
            ${d.location ? `<span>${esc(d.location)}</span> · ` : ''}
            ${d.platform ? `<span>${esc(d.platform)}</span> · ` : ''}
            ${d.app_version ? `<span>v${esc(d.app_version)}</span> · ` : ''}
            <span>installed ${fmtDate(d.installed_at)}</span>
            ${d.registered_at ? `<span>· recorded ${fmtDate(d.registered_at)}</span>` : ''}
          </div>
          ${d.notes ? `<div class="dist-row-notes">${esc(d.notes)}</div>` : ''}
        </div>
        <button class="btn btn-danger btn-sm dist-rm" data-id="${esc(d.id)}">Remove</button>
      </div>`).join('');
    $('dist-rows').querySelectorAll('.dist-rm').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`Remove "${b.closest('.dist-row').querySelector('.dist-row-name').textContent}" from the register?`)) return;
        await window.pvh.removeDeployment(b.dataset.id);
        window.pvhUI.toast('Entry removed.', 'success');
        loadRegister();
      }));
  }

  $('dist-register-this-btn').addEventListener('click', async () => {
    const res = await window.pvh.thisComputer({});
    if (!res || res.ok === false) { window.pvhUI.toast((res && res.error) || 'Could not read this machine.', 'error'); return; }
    const c = res.computer;
    await window.pvh.addDeployment({
      machine_name: c.machine_name,
      location: c.location,
      platform: c.platform,
      app_version: c.app_version,
      installed_at: c.installed_at,
      notes: c.notes,
    });
    window.pvhUI.toast(`Registered this computer (${c.machine_name}, v${c.app_version}).`, 'success');
    loadRegister();
  });

  $('dist-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const machine = $('dist-mach').value.trim();
    if (!machine) { window.pvhUI.toast('Enter a machine / user name.', 'error'); $('dist-mach').focus(); return; }
    const dateVal = $('dist-inst').value;
    const installedAt = dateVal ? new Date(dateVal + 'T00:00:00').getTime() : Date.now();
    const payload = {
      machine_name: machine,
      location: $('dist-loc').value.trim(),
      platform: null,
      app_version: $('dist-ver').value.trim() || null,
      installed_at: installedAt,
      notes: $('dist-notes').value.trim(),
    };
    const res = await window.pvhUI.busy($('dist-add-btn'), 'Adding…', () => window.pvh.addDeployment(payload));
    if (!res || res.ok === false) {
      window.pvhUI.toast((res && res.error) || 'Could not add the entry. Try again.', 'error');
      return;
    }
    e.target.reset();
    $('dist-mach').focus();
    window.pvhUI.toast('Install added to the register.', 'success');
    loadRegister();
  });

  $('dist-export-btn').addEventListener('click', async () => {
    const res = await window.pvh.exportDeployments();
    if (res && res.ok) window.pvhUI.toast(`Saved to ${res.path}`, 'success');
    else window.pvhUI.toast((res && res.error) || 'Export failed.', 'error');
  });

  // ---------- GitHub downloads ----------
  function renderReleases(data) {
    releasesEl.textContent = fmtNum(data.releases.length);
    downloadsEl.textContent = fmtNum(data.releases.reduce((t, r) => t + r.assets.reduce((a, x) => a + (x.download_count || 0), 0), 0));
    if (!data.releases.length) { $('dist-releases').innerHTML = '<p class="text-muted hint">No public releases yet.</p>'; return; }
    $('dist-releases').innerHTML = data.releases.map((r) => `
      <div class="dist-release">
        <div class="dist-release-head">
          ${r.prerelease ? '<span class="dist-release-badge is-pre">Pre-release</span>' : ''}
          <a class="dist-release-tag" href="https://github.com/${esc(data.repo)}/releases/tag/${esc(r.tag_name)}" target="_blank" rel="noopener">${esc(r.tag_name)}</a>
          <span class="dist-release-total">${fmtNum(r.assets.reduce((a, x) => a + (x.download_count || 0), 0))} downloads</span>
          <span class="dist-release-date">${r.published_at ? new Date(r.published_at).toLocaleDateString() : ''}</span>
        </div>
        <div class="dist-assets">
          ${r.assets.length ? r.assets.map((a) => `
            <div class="dist-asset">
              <div class="dist-asset-main">
                <div class="dist-asset-name">${esc(a.name)}</div>
                <div class="dist-asset-meta">${fmtSize(a.size)}${a.updated_at ? ` · ${new Date(a.updated_at).toLocaleDateString()}` : ''}</div>
              </div>
              <span class="dist-asset-count">${fmtNum(a.download_count)}</span>
            </div>`).join('') : '<p class="text-muted hint">No installer assets attached.</p>'}
        </div>
      </div>`).join('');
    const fetched = $('dist-fetched');
    if (fetched) { fetched.hidden = false; fetched.textContent = `Fetched ${new Date(data.fetched_at).toLocaleString()}`; }
    injectIcons();
  }

  $('dist-refresh-btn').addEventListener('click', async () => {
    msgEl.textContent = 'Refreshing…';
    const res = await window.pvh.githubReleases();
    if (!res || res.ok === false) {
      msgEl.textContent = (res && res.error) || 'Could not reach GitHub.';
      return;
    }
    msgEl.textContent = '';
    renderReleases(res);
  });

  // Token handling (admin only, stored in local config).
  (async () => {
    const t = await window.pvh.githubToken();
    if (t && t.ok && t.hasToken) $('dist-token').placeholder = 'Token saved — replace to update, leave blank to remove';
  })();
  $('dist-token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await window.pvh.setGithubToken($('dist-token').value.trim());
    $('dist-token').value = '';
    $('dist-token-msg').textContent = 'Token saved to this device.';
    msgEl.textContent = '';
  });

  loadRegister();
})();