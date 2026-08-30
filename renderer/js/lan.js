// LAN sync panel (Administration > LAN sync). Talks to the main process over
// the pvh bridge; the main process is the one that owns hub/peer state, so this
// file is mostly UI wiring + the live status subscription.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasLan = window.pvh && typeof window.pvh.lanStatus === 'function';
  const panel = $('lan-pill');
  if (!hasLan || !panel) return;

  const pill = {
    set(kind, text) {
      panel.className = 'lan-pill' + (kind ? ' ' + kind : '');
      $('lan-pill-text').textContent = text;
    },
  };

  // Browser ballot links (host mode): list each LAN address the hub is on,
  // with a copy button that flips to "Copied" briefly.
  function renderKioskLinks(urls) {
    const box = $('lan-kiosk-box');
    const list = $('lan-kiosk-links');
    if (!box || !list) return;
    if (!urls.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    list.innerHTML = urls.map((u) => `
      <li>
        <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>
        <button type="button" class="btn btn-sm btn-ghost lan-copy" data-u="${esc(u)}">Copy</button>
      </li>`).join('');
    list.querySelectorAll('.lan-copy').forEach((b) => {
      b.addEventListener('click', () => {
        const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(b.dataset.u).then(done, () => { window.prompt('Copy the link', b.dataset.u); done(); });
        } else { window.prompt('Copy the link', b.dataset.u); done(); }
      });
    });
  }

  // ---------- status rendering ----------
  function renderStatus(s) {
    if (!s) return;
    const mode = s.mode || 'off';

    $('lan-dev-name').value = s.deviceName || '';
    $('lan-stat-votes').textContent = (s.stats && s.stats.votes) || 0;
    $('lan-stat-devices').textContent = (s.peers && s.peers.length) || 0;
    $('lan-stat-synced').textContent = mode === 'client'
      ? ((s.client && (s.client.queue || 0) + (s.client.unsynced || 0)) || 0)
      : 0;

    document.querySelectorAll('.lan-radio').forEach((r) => {
      r.classList.toggle('active', r.dataset.lmode === mode);
      r.querySelector('input').checked = r.dataset.lmode === mode;
    });

    $('lan-host-box').style.display = mode === 'host' ? '' : 'none';
    $('lan-client-box').style.display = mode === 'client' ? '' : 'none';

    $('lan-port').value = s.port || 7380;

    // Host side
    if (mode === 'host') {
      $('lan-start-host-btn').style.display = 'none';
      $('lan-stop-host-btn').style.display = '';
      $('lan-host-info').style.display = '';
      $('lan-address').textContent = (s.addresses && s.addresses.length ? s.addresses[0] : 'this device') + ':' + s.port;
      $('lan-advert-name').textContent = s.deviceName || 'this device';
      const peers = (s.peers || []).map((p) => (p && p.deviceName) || 'A device').join(', ');
      const peerEl = $('lan-peer-list');
      peerEl.textContent = peers || 'none yet';
      peerEl.className = 'lan-peer-list' + (peers ? '' : ' idle');
      renderKioskLinks(s.kioskUrls || []);
      pill.set(peers ? 'ok' : 'warn', peers ? 'Hosting (' + s.peers.length + ' connected)' : 'Hosting');
    } else if (mode === 'client') {
      const c = s.client || {};
      $('lan-connect-btn').style.display = 'none';
      $('lan-disconnect-btn').style.display = '';
      $('lan-client-info').style.display = '';
      const hubName = (c.hub && c.hub.serverName) || 'connecting…';
      $('lan-client-hub').textContent = hubName + ((c.hub && c.hub.host) ? ' (' + c.hub.host + ')' : '');
      const stateLabel = { connected: 'Connected', connecting: 'Connecting…', offline: 'Offline — reconnecting', idle: 'Not connected' }[c.state] || c.state || '—';
      $('lan-client-state').textContent = stateLabel;
      $('lan-client-queue').textContent = c.queue || 0;
      $('lan-client-unsynced').textContent = c.unsynced || 0;
      const queued = (c.queue || 0) + (c.unsynced || 0);
      pill.set(c.state === 'connected' ? (queued ? 'warn' : 'ok') : 'bad',
        c.state === 'connected' ? (queued ? 'Synced ' + queued + ' pending' : 'Connected') : stateLabel);
      $('lan-host-url').value = c.hub ? ((c.hub.host || '') + ':' + (c.hub.port || 7380)) : $('lan-host-url').value;
    } else {
      $('lan-start-host-btn').style.display = '';
      $('lan-stop-host-btn').style.display = 'none';
      $('lan-host-info').style.display = 'none';
      $('lan-connect-btn').style.display = '';
      $('lan-disconnect-btn').style.display = 'none';
      $('lan-client-info').style.display = 'none';
      pill.set('', 'Standalone');
    }
  }

  async function refresh() {
    const s = await window.pvh.lanStatus();
    renderStatus(s);
  }

  window.pvh.onLanStatus((s) => renderStatus(s));

  // ---------- actions ----------

  function setMsg(id, res, okText) {
    const el = $(id);
    el.textContent = res && res.ok ? (okText || 'Done') : ((res && res.error) || 'Something went wrong');
    el.className = res && res.ok ? 'notice-ok' : 'auth-error';
  }

  $('lan-save-name-btn').addEventListener('click', async () => {
    const res = await window.pvh.lanSetName($('lan-dev-name').value);
    if (res && res.ok) {
      window.pvhUI.toast('Device name saved.', 'success');
      refresh();
    } else {
      window.pvhUI.toast((res && res.error) || 'Could not save name', 'error');
    }
  });

  $('lan-start-host-btn').addEventListener('click', async (e) => {
    await window.pvhUI.busy(e.currentTarget, 'Starting…', async () => {
      const res = await window.pvh.lanSetMode('host', { port: Number($('lan-port').value) || 7380 });
      setMsg('lan-host-msg', res, 'Server started.');
      if (res && res.ok) {
        window.pvhUI.toast('Server started.', 'success');
        refresh();
      } else {
        window.pvhUI.toast((res && res.error) || 'Could not start server', 'error');
      }
    });
  });

  $('lan-stop-host-btn').addEventListener('click', async () => {
    const res = await window.pvh.lanStop();
    setMsg('lan-host-msg', res, 'Server stopped.');
    if (res && res.ok) window.pvhUI.toast('Server stopped.', 'success');
    else window.pvhUI.toast((res && res.error) || 'Could not stop server', 'error');
    refresh();
  });

  $('lan-connect-btn').addEventListener('click', async (e) => {
    await window.pvhUI.busy(e.currentTarget, 'Connecting…', async () => {
      const res = await window.pvh.lanSetMode('client', { host: $('lan-host-url').value });
      setMsg('lan-client-msg', res, 'Connecting…');
      if (res && res.ok) {
        window.pvhUI.toast('Connected to hub.', 'success');
        refresh();
      } else {
        window.pvhUI.toast((res && res.error) || 'Could not connect', 'error');
      }
    });
  });

  $('lan-disconnect-btn').addEventListener('click', async () => {
    const res = await window.pvh.lanStop();
    setMsg('lan-client-msg', res, 'Disconnected.');
    if (res && res.ok) window.pvhUI.toast('Disconnected.', 'success');
    else window.pvhUI.toast((res && res.error) || 'Could not disconnect', 'error');
    refresh();
  });

  $('lan-scan-btn').addEventListener('click', async (e) => {
    await window.pvhUI.busy(e.currentTarget, 'Scanning…', async () => {
      const box = $('lan-found');
      box.innerHTML = '<div class="lan-empty">Searching for hubs…</div>';
      const res = await window.pvh.lanDiscover(3000);
      if (!res || !res.ok) {
        box.innerHTML = `<div class="lan-empty">${esc((res && res.error) || 'Discovery unavailable')}</div>`;
        return;
      }
      if (!res.services.length) {
        box.innerHTML = '<div class="lan-empty">No hubs found. Connect by address below, or start the hub on the host device.</div>';
        return;
      }
      box.innerHTML = res.services.map((svc, i) => {
        const host = (svc.addresses && svc.addresses[0]) || svc.host || '';
        const url = host ? `${host}:${svc.port}` : '';
        return `<div class="lan-svc">
          <div class="lan-svc-meta">
            <div class="lan-svc-name">${esc(svc.name || 'Pulse Device')}</div>
            <div class="lan-svc-host">${esc(url || 'no address')}</div>
          </div>
          ${url ? `<button class="btn btn-secondary lan-svc-connect" data-url="${esc(url)}"><span class="icon btn-icon" data-icon="lan"></span>Connect</button>` : ''}
        </div>`;
      }).join('');
      box.querySelectorAll('.lan-svc-connect').forEach((b) => {
        b.addEventListener('click', async () => {
          $('lan-host-url').value = b.dataset.url;
          const res = await window.pvh.lanSetMode('client', { host: b.dataset.url });
          setMsg('lan-client-msg', res, 'Connecting…');
          if (res && res.ok) {
            window.pvhUI.toast('Connected to hub.', 'success');
            refresh();
          } else {
            window.pvhUI.toast((res && res.error) || 'Could not connect', 'error');
          }
        });
      });
      window.pvhUI.toast(`Found ${res.services.length} hub(s) on the network.`, 'success');
    });
  });
  window.pvhIcons.inject('.lan-found .lan-svc-connect');

  // Clicks on the mode radios only steer the visible box; the Start/Connect
  // buttons perform the actual switch.
  document.querySelectorAll('.lan-radio input').forEach((r) => {
    r.addEventListener('change', () => {
      const v = r.value;
      document.querySelectorAll('.lan-radio').forEach((x) => x.classList.toggle('active', x.dataset.lmode === v));
      $('lan-host-box').style.display = v === 'host' ? '' : 'none';
      $('lan-client-box').style.display = v === 'client' ? '' : 'none';
    });
  });

  refresh();
})();