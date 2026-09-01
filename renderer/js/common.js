(function () {
  // Shared session guard + sidebar profile for authed pages
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  // A session is only valid with a signed token (minted at login). A stale
  // session that has an officer id but no token is expired/forged → route to
  // login so the user re-authenticates.
  if (!session || !session.token) {
    try { window.localStorage.removeItem('pvh_session'); } catch (err) { /* noop */ }
    window.location.assign('index.html');
    return;
  }

  if (session.role === 'admin') document.body.classList.add('is-admin');

  applyTheme();

  const WEB_URL = 'https://pulse-vote-hub-app.web.app';
  const WEB_BLOG_URL = 'https://pulse-vote-hub-app.web.app/blog.html';

  const ic = (name, size) => (window.pvhIcons && window.pvhIcons.icon(name, size || 18)) || '';
  const roleLabel = (r) => (r === 'admin' ? 'Administrator' : 'Coordinator');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function timeAgo(ts) {
    const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    return day === 1 ? 'yesterday' : day + 'd ago';
  }
  const initials = (name) =>
    String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';

  function getPrefs() {
    try { return JSON.parse(window.localStorage.getItem('pvh_prefs') || '{}'); } catch (e) { return {}; }
  }
  function setPref(key, val) {
    const p = getPrefs();
    p[key] = val;
    window.localStorage.setItem('pvh_prefs', JSON.stringify(p));
  }

  // Apply the theme to the document. Explicit 'light'/'dark' wins; 'system'
  // (the default) asks the main process, which follows the OS + any theme:set.
  async function applyTheme() {
    const pref = getPrefs().theme || 'system';
    let resolved = null;
    if (pref === 'light') resolved = 'light';
    else if (pref === 'dark') resolved = 'dark';
    else if (window.pvh && window.pvh.getTheme) {
      try { resolved = await window.pvh.getTheme(); } catch (e) { resolved = null; }
    }
    if (resolved === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    return resolved || 'dark';
  }

  // ---------- Sidebar profile (avatar + menu) ----------

  function buildProfile(footer) {
    const isAdmin = session.role === 'admin';
    footer.innerHTML = `
      <div class="profile" id="profile">
        <button type="button" class="profile-trigger" id="profile-trigger" aria-haspopup="true" aria-expanded="false">
          <span class="profile-avatar" aria-hidden="true">${initials(session.name)}</span>
          <span class="profile-meta">
            <span class="profile-name">${session.name}</span>
            <span class="profile-role">${roleLabel(session.role)}</span>
          </span>
          <span class="profile-caret">${ic('chevron', 16)}</span>
        </button>
        <div class="profile-menu" id="profile-menu" role="menu" aria-label="Profile menu" hidden>
          <div class="profile-menu-head">
            <span class="profile-avatar" aria-hidden="true">${initials(session.name)}</span>
            <span class="profile-menu-ident">
              <span class="profile-menu-name">${session.name}</span>
              <span class="profile-menu-role">${roleLabel(session.role)}</span>
            </span>
          </div>
          <button type="button" class="profile-item" role="menuitem" data-action="preferences">${ic('settings')} Preferences</button>
          <button type="button" class="profile-item" role="menuitem" data-action="guide">${ic('help')} User guide</button>
          <button type="button" class="profile-item" role="menuitem" data-action="faq">${ic('help')} FAQ</button>
          <button type="button" class="profile-item" role="menuitem" data-action="privacy">${ic('privacy')} Privacy policy</button>
          ${isAdmin
            ? '<button type="button" class="profile-item" role="menuitem" data-action="inbox">' + ic('mail') + ' Admin inbox <span class="profile-badge" id="inbox-badge" hidden></span></button>'
            : '<button type="button" class="profile-item" role="menuitem" data-action="speak">' + ic('message') + ' Speak to admin <span class="profile-badge" id="speak-badge" hidden></span></button>'}
          <button type="button" class="profile-item" role="menuitem" data-action="website">${ic('globe')} Visit website</button>
          <button type="button" class="profile-item" role="menuitem" data-action="blog">${ic('newspaper')} Blog</button>
          <button type="button" class="profile-item" role="menuitem" data-action="about">${ic('globe')} About Pulse Trend</button>
          <div class="profile-divider"></div>
          <button type="button" class="profile-item profile-item-danger" role="menuitem" data-action="signout">${ic('logout')} Sign out</button>
        </div>
      </div>`;

    const trigger = footer.querySelector('#profile-trigger');
    const menu = footer.querySelector('#profile-menu');
    window.pvhUI.inboxBadge = footer.querySelector('#inbox-badge');
    window.pvhUI.speakBadge = footer.querySelector('#speak-badge');

    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function closeMenu() {
      if (menu.hidden) return;
      setOpen(false);
      document.removeEventListener('mousedown', onDocMouse);
      document.removeEventListener('keydown', onDocKey);
    }
    function onDocMouse(e) {
      if (!footer.contains(e.target)) closeMenu();
    }
    function onDocKey(e) {
      if (e.key === 'Escape') closeMenu();
    }
    trigger.addEventListener('click', () => {
      if (menu.hidden) {
        setOpen(true);
        refreshInboxBadge();
        document.addEventListener('mousedown', onDocMouse);
        document.addEventListener('keydown', onDocKey);
      } else {
        closeMenu();
      }
    });

    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('.profile-item');
      if (!item) return;
      const action = item.dataset.action;
      closeMenu();
      if (action === 'signout') {
        window.localStorage.removeItem('pvh_session');
        window.location.assign('index.html');
        return;
      }
      if (action === 'website' || action === 'blog') {
        const url = action === 'blog' ? WEB_BLOG_URL : WEB_URL;
        if (window.pvh && window.pvh.openExternal) {
          const res = await window.pvh.openExternal(url);
          toast(res && res.ok ? 'Opened in your browser.' : (res && res.error) || 'Could not open the link.', res && res.ok ? 'success' : 'error');
        } else {
          window.open(url, '_blank');
        }
        return;
      }
      if (action === 'inbox') {
        const target = 'administration.html#inbox';
        if (window.location.pathname.split('/').pop() === 'administration.html') {
          const el = document.getElementById('inbox');
          if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
        } else {
          window.location.assign(target);
        }
        return;
      }
      if (action === 'guide') {
        window.location.assign('guide.html');
        return;
      }
      if (action === 'preferences') prefsModal();
      if (action === 'faq') faqModal();
      if (action === 'about') aboutModal();
      if (action === 'privacy') privacyModal();
      if (action === 'speak') speakModal();
    });
  }

  function refreshInboxBadge() {
    if (session.role !== 'admin' || !window.pvh || !window.pvh.unreadMessages) return;
    window.pvh.unreadMessages().then((res) => {
      const n = (res && res.ok) ? res.count : 0;
      if (window.pvhUI.inboxBadge) {
        window.pvhUI.inboxBadge.textContent = n;
        window.pvhUI.inboxBadge.hidden = !(n > 0);
      }
      const navBadge = document.querySelector('.nav-item[data-nav="admin"] .nav-badge');
      if (navBadge) {
        navBadge.textContent = n;
        navBadge.hidden = !(n > 0);
      }
    }).catch(() => {});
  }

  function refreshSpeakBadge() {
    if (session.role === 'admin' || !window.pvh || !window.pvh.unreadMine) return;
    window.pvh.unreadMine().then((res) => {
      const n = (res && res.ok) ? res.count : 0;
      if (window.pvhUI.speakBadge) {
        window.pvhUI.speakBadge.textContent = n;
        window.pvhUI.speakBadge.hidden = !(n > 0);
      }
    }).catch(() => {});
  }

  // ---------- Toast + busy feedback ----------

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

  window.pvhUI = { toast, busy, inboxBadge: null, speakBadge: null, refreshInboxBadge, refreshSpeakBadge };

  // ---------- Shared modal ----------

  function openModal({ title, body, width, onMount }) {
    const old = document.querySelector('.pvh-modal-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pvh-modal-overlay';
    overlay.innerHTML = `
      <div class="pvh-modal" role="dialog" aria-modal="true"${width ? ` style="width:min(${width},92vw)"` : ''}>
        <header class="pvh-modal-head">
          <h2 class="pvh-modal-title">${title}</h2>
          <button type="button" class="pvh-modal-close" aria-label="Close">${ic('x', 20)}</button>
        </header>
        <div class="pvh-modal-body"></div>
      </div>`;
    const bodyEl = overlay.querySelector('.pvh-modal-body');
    bodyEl.innerHTML = body;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.pvh-modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    if (onMount) onMount(bodyEl, close);
    return { close, el: overlay };
  }

  // ---------- FAQ ----------

  const FAQ_ITEMS = [
    ['Is my data stored online?',
     'No. Every vote, voter record and setting lives on this computer — or on your own network hub when you run LAN sync or the Browser ballot. Nothing is uploaded anywhere, and every device works fully offline apart from your own network traffic.'],
    ['How do I set up an election?',
     'Go to Elections, create an election, add positions and candidates, enrol voters, then Publish. From Stations you can open and manage the polling station, and Results gives you live tallies.'],
    ['Do voters need the app installed to vote?',
     'No. When a coordinator or admin starts the Browser ballot (Dashboard > Browser ballot), the app serves the ballot to your network. Any laptop or desktop can open the link in its browser and vote — voter ID and password still apply, and every ballot is verified and hash-chained on the hub.'],
    ['What is the difference between “Browser ballot” and “LAN sync”?',
     'They work together. LAN sync mirrors the live database between devices that have the app installed, so several polling PCs share the same vote tally. The Browser ballot reuses that same hub but serves the ballot to plain browsers, so laptops and desktops can vote without installing anything. Both can run at the same time on the same hub.'],
    ['Can a voter vote more than once?',
     'One enrolled voter equals one vote. Votes are stored as an unbroken, signed hash-chain, so a duplicate cast is immediately detectable — with a clear integrity report if anything is ever tampered with.'],
    ['What happens if the network goes down at a station?',
     'Installed-app stations keep working fully offline and sync over your local network hub once it is back. Browser ballots connect live to the hub, so voting laptops need to stay on the same network; if it drops mid-ballot the vote can simply be recast. Every vote is still re-verified for integrity on sync.'],
    ['How do I combine results from several stations?',
     'Use the Merge section: export an election snapshot from each machine and import them here with your admin key. The app verifies each file’s signature before merging anything into the totals.'],
    ['Someone forgot their password.',
     'From Administration > Officers, an admin can reset any officer’s password. Voter access credentials can be reset from the Voters list for the election.'],
    ['How secure is the ballot?',
     'Ballots are cryptographically signed, the vote and audit trails are hash-chained, and admin actions are immutably recorded. You can run Verify integrity anytime to get a full report.'],
    ['Where can I get more help?',
     'Open your Profile menu and choose “User guide” for the full manual, or use “Speak to admin” and your admin will read it from Administration > Inbox. To stay up to date or reach the Pulse Trend team, follow the channels in the “About Pulse Trend” section below.'],
  ];

  const PULSE_TREND = {
    about: 'Pulse Vote Hub is powered by <strong>Pulse Trend</strong> — an offline-first voting and event platform made for reliable, transparent polls across classrooms, campuses and communities.',
    channels: [
      { key: 'facebook', label: 'Facebook', url: 'https://web.facebook.com/pulsetrendtv' },
      { key: 'x', label: 'X (Twitter)', url: 'https://x.com/the_pulsetrend?s=11' },
      { key: 'tiktok', label: 'TikTok', url: 'https://tiktok.com/@thepulsetrend' },
      { key: 'youtube', label: 'YouTube', url: 'https://youtube.com/@thepulsetrend' },
      { key: 'instagram', label: 'Instagram', url: 'https://instagram.com/thepulsetrend' },
      { key: 'threads', label: 'Threads', url: 'https://www.threads.com/@the_pulsetrend?igshid=NTc4MTIwNjQ2YQ==' },
    ],
  };

  function socialLinks() {
    return PULSE_TREND.channels
      .map(({ key, label, url }) =>
        `<a class="pvh-social" href="#" data-href="${esc(url)}" aria-label="${esc(label)}">${(window.pvhIcons && window.pvhIcons.brand) ? window.pvhIcons.brand(key, 16) : ''}<span>${esc(label)}</span></a>`)
      .join('');
  }

  function openExternalUrl(url, msg) {
    if (window.pvh && window.pvh.openExternal) {
      window.pvh.openExternal(url).then((res) =>
        toast(res && res.ok ? 'Opened in your browser.' : (res && res.error) || 'Could not open the link.', res && res.ok ? 'success' : 'error')
      );
    } else {
      window.open(url, '_blank');
    }
    if (msg) toast(msg, 'success');
  }

  function aboutModal() {
    openModal({
      title: 'About Pulse Trend',
      width: '560px',
      body: `
        <p class="pvh-about">${PULSE_TREND.about}</p>
        <h4 class="pvh-social-title">Connect with us</h4>
        <div class="pvh-social-grid">${socialLinks()}</div>
        <p class="pvh-contact">Contact: <strong>020 469 9001</strong></p>
      `,
      onMount(bodyEl) {
        bodyEl.querySelectorAll('.pvh-social').forEach((a) =>
          a.addEventListener('click', (e) => { e.preventDefault(); openExternalUrl(a.dataset.href); })
        );
      },
    });
  }

  function faqModal() {
    const items = FAQ_ITEMS
      .map(([q, a]) => `<details class="pvh-faq"><summary>${q}</summary><p>${a}</p></details>`)
      .join('');
    openModal({
      title: 'Frequently asked questions',
      width: '560px',
      body: `
        <div class="pvh-faq-wrap">${items}</div>
        <hr class="pvh-faq-hr">
        <p class="pvh-about">${PULSE_TREND.about}</p>
        <h4 class="pvh-social-title">Connect with us</h4>
        <div class="pvh-social-grid">${socialLinks()}</div>
        <p class="pvh-contact">Contact: <strong>020 469 9001</strong></p>
      `,
      onMount(bodyEl) {
        bodyEl.querySelectorAll('.pvh-social').forEach((a) =>
          a.addEventListener('click', (e) => { e.preventDefault(); openExternalUrl(a.dataset.href); })
        );
      },
    });
  }

  // ---------- Privacy policy ----------

  const PRIVACY_SECTIONS = [
    ['Your data stays on your machine',
     'Pulse Vote Hub is an offline-first desktop application. Names, voter rolls, ballots, settings and messages are stored only in a local database on the device you are using — or on the hub device when you run LAN sync or the Browser ballot. Nothing is sent to us.'],
    ['No tracking, no telemetry',
     'The app does not collect analytics, track usage, or phone home. The only outbound requests are the optional installer-download check in Administration (a public, read-only GitHub query) and loading shared assets and fonts from the web while you are online. When you leave the desktop application and open a web page, that website’s own policy applies.'],
    ['Who can see what',
     'Only the officers and admins you create can sign in. Administration and the inbox are visible to admins only, and every administrative action is recorded in an immutable audit trail.'],
    ['On a shared network (LAN sync & Browser ballot)',
     'When a coordinator or admin starts the hub, votes and check-ins from other synced devices — and from voting laptops using the Browser ballot — travel over your own local Wi-Fi or LAN only. The ballot page is served by the app itself, so no device needs the app installed. Every one of those ballots carries the same identity checks and signed hash-chain as a ballot cast on the machine directly. None of this traffic leaves your network.'],
    ['Vote integrity',
     'Ballots and audit events are cryptographically signed and chained so any modification is detectable. Integrity reports are available to you at any time and are part of your own backup files.'],
    ['Installer downloads (optional)',
     'The admin-only Installer downloads panel can read public download counts from GitHub Releases. A GitHub token — required only when your repository is private — is stored on this device and used solely to authenticate that read. It is never shared with anyone else.'],
    ['Backups are your responsibility',
     'You can export backups and election snapshots whenever you like; those files belong to you and never leave your control unless you share them.'],
    ['Contact',
     'For questions about this policy, use “Speak to admin” inside the app — an admin at your organisation will see it in Administration > Inbox.'],
  ];

  function privacyModal() {
    const html = PRIVACY_SECTIONS
      .map(([h, p]) => `<section class="pvh-privacy"><h3>${h}</h3><p>${p}</p></section>`)
      .join('');
    openModal({ title: 'Privacy policy', width: '560px', body: `<div class="pvh-privacy-wrap">${html}</div>` });
  }

  // ---------- Preferences ----------

  function prefsModal() {
    const soundOn = getPrefs().sound !== 'off';
    const theme = getPrefs().theme || 'system';
    const seg = (v, label) => `<button type="button" class="pvh-seg-btn${theme === v ? ' active' : ''}" data-theme-value="${v}">${label}</button>`;
    openModal({
      title: 'Preferences',
      width: '480px',
      body: `
        <div class="pvh-prefs">
          <div class="pvh-pref-row">
            <label for="pref-sound">
              <span class="pvh-pref-label">Sound effects</span>
              <span class="pvh-pref-hint">Plays chimes, ticks and alerts while you use the app.</span>
            </label>
            <span class="switch"><input type="checkbox" id="pref-sound"${soundOn ? ' checked' : ''}><span class="switch-track"></span></span>
          </div>
          <div class="pvh-pref-row pvh-pref-row-stack">
            <span class="pvh-pref-label">Appearance</span>
            <span class="pvh-pref-hint">Light, dark, or match your computer’s setting.</span>
            <div class="pvh-seg" role="radiogroup" aria-label="Theme">
              ${seg('system', 'System')}${seg('light', 'Light')}${seg('dark', 'Dark')}
            </div>
          </div>
          <div class="pvh-pref-actions">
            <button type="button" class="btn btn-ghost" id="pref-test-sound"${soundOn ? '' : ' disabled'}>Test sound</button>
            <button type="button" class="btn btn-ghost" id="pref-website">${ic('globe', 16)} Open web version</button>
          </div>
        </div>`,
      onMount(body, close) {
        const cb = body.querySelector('#pref-sound');
        const test = body.querySelector('#pref-test-sound');
        cb.addEventListener('change', () => {
          setPref('sound', cb.checked ? 'on' : 'off');
          test.disabled = !cb.checked;
          toast(cb.checked ? 'Sound effects enabled.' : 'Sound effects muted.', 'success');
        });
        test.addEventListener('click', () => {
          if (getPrefs().sound === 'off') { toast('Sound is muted — enable it in Preferences.', 'error'); return; }
          if (window.pvhAudio && window.pvhAudio.playConfirm) window.pvhAudio.playConfirm();
        });
        body.querySelectorAll('.pvh-seg-btn').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const v = btn.dataset.themeValue;
            body.querySelectorAll('.pvh-seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
            setPref('theme', v);
            if (window.pvh && window.pvh.setTheme) {
              try { await window.pvh.setTheme(v); } catch (e) { /* still apply below */ }
            }
            await applyTheme();
            toast(v === 'system' ? 'Theme set to System.' : `${v.charAt(0).toUpperCase() + v.slice(1)} theme applied.`, 'success');
          });
        });
        body.querySelector('#pref-website').addEventListener('click', async () => {
          if (window.pvh && window.pvh.openExternal) {
            const res = await window.pvh.openExternal(WEB_URL);
            toast(res && res.ok ? 'Opened the web version in your browser.' : (res && res.error) || 'Could not open the link.', res && res.ok ? 'success' : 'error');
          }
        });
      },
    });
  }

  // ---------- Speak to admin ----------

  function speakModal() {
    openModal({
      title: 'Speak to admin',
      width: '560px',
      body: `
        <div class="pvh-speak">
          <p class="pvh-speak-hint">Your messages to the admin, and their replies. Send a new note below.</p>
          <div class="pvh-speak-log" id="speak-log">
            <div class="pvh-speak-empty">Loading…</div>
          </div>
          <textarea id="speak-body" class="pvh-speak-input" maxlength="2000" rows="3" placeholder="Type your message…"></textarea>
          <div class="pvh-speak-foot">
            <span class="pvh-speak-count" id="speak-count">0 / 2000</span>
            <button type="button" class="btn btn-ghost btn-sm" id="speak-refresh">Refresh</button>
            <button type="button" class="btn btn-primary" id="speak-send">Send message</button>
          </div>
        </div>`,
      onMount(body, close) {
        const logEl = body.querySelector('#speak-log');
        const ta = body.querySelector('#speak-body');
        const count = body.querySelector('#speak-count');
        const send = body.querySelector('#speak-send');
        const refresh = body.querySelector('#speak-refresh');
        const mineLogin = (session && session.officer_id) || '';

        function msgHtml(m, isMine) {
          const label = isMine ? 'You' : m.from_name + (m.reply_to_id ? ' (Admin)' : '');
          return `
            <div class="pvh-speak-msg ${isMine ? 'pvh-speak-mine' : 'pvh-speak-admin'}">
              <div class="pvh-speak-msg-head">
                <span class="pvh-speak-msg-from">${esc(label)}</span>
                <span class="pvh-speak-msg-time">${timeAgo(m.created_at)}</span>
              </div>
              <p class="pvh-speak-msg-body">${esc(m.body)}</p>
            </div>`;
        }

        function load() {
          if (!window.pvh || !window.pvh.myMessages) return;
          window.pvh.myMessages().then((res) => {
            const all = (res && res.ok) ? res.messages : [];
            if (!all.length) {
              logEl.innerHTML = '<div class="pvh-speak-empty">No messages yet. Write one below and it will appear in Administration &gt; Inbox.</div>';
            } else {
              logEl.innerHTML = all.map((m) => msgHtml(m, m.from_officer === mineLogin)).join('');
            }
            logEl.scrollTop = logEl.scrollHeight;
            if (window.pvh.markMineRead) window.pvh.markMineRead().then(() => refreshSpeakBadge());
          }).catch(() => {});
        }

        ta.addEventListener('input', () => { count.textContent = ta.value.length + ' / 2000'; });
        refresh.addEventListener('click', load);
        send.addEventListener('click', async () => {
          if (!window.pvh || !window.pvh.sendMessage) { toast('Messaging is unavailable.', 'error'); return; }
          if (!ta.value.trim()) { toast('Write a message first.', 'error'); return; }
          const res = await busy(send, 'Sending…', () => window.pvh.sendMessage(ta.value));
          if (res && res.ok) {
            ta.value = '';
            count.textContent = '0 / 2000';
            toast('Message sent to the admin.', 'success');
            load();
          } else {
            toast((res && res.error) || 'Could not send the message.', 'error');
          }
        });
        ta.focus();
        load();
      },
    });
  }

  // ---------- Render ----------

  const footer = document.getElementById('sidebar-footer');
  if (footer) buildProfile(footer);

  if (window.pvhIcons) window.pvhIcons.inject('.icon');

  const nav = document.getElementById('nav');
  if (nav) {
    if (session.role === 'admin') {
      const adminNav = nav.querySelector('.nav-item[data-nav="admin"]');
      if (adminNav) {
        const b = document.createElement('span');
        b.className = 'nav-badge';
        b.hidden = true;
        adminNav.appendChild(b);
      }
    }
    // Highlight current page based on data-nav matching active class already set
    nav.querySelectorAll('.nav-item').forEach((a) => {
      let lastNav = 0;
      a.addEventListener('click', (e) => {
        // A double-click on a nav button would normally fire two clicks and
        // navigate/reload the page twice (collapsing the sidebar transition and
        // making the whole page "bump in"). Treat a rapid second activation as a
        // single click so the sidebar never double-navigates.
        if (e && e.detail > 1) { e.preventDefault(); return; }
        const now = Date.now();
        if (now - lastNav < 350) { e.preventDefault(); return; }
        lastNav = now;
        const href = a.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript')) return; // real navigations proceed
        e.preventDefault();
        const navName = a.getAttribute('data-nav');
        // Navigate to the matching page if it exists
        const map = { dashboard: 'dashboard.html', elections: 'elections.html', voters: 'voters.html', stations: 'stations.html', results: 'results.html', admin: 'administration.html', officers: 'officers.html', 'location-runs': 'location-runs.html' };
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

  if (session.role === 'admin') {
    refreshInboxBadge();
    setInterval(refreshInboxBadge, 20000);
  } else {
    refreshSpeakBadge();
    setInterval(refreshSpeakBadge, 20000);
  }
})();