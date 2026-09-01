// Public browser view: live results + official declaration. Runs in a plain
// browser against the host's LAN hub — there is no Electron IPC/preload here,
// only fetch() to the same-origin /api/public/* endpoints.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var fmtNum = function (n) { return Number(n || 0).toLocaleString(); };

  var STATUS = { draft: 'Draft', upcoming: 'Upcoming', active: 'Active', closed: 'Closed' };

  var state = { elections: [], currentId: null, tab: 'results', report: null, timer: null };

  function fmtDateFull(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDateDay(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }

  // ---------- Election selector ----------
  function loadElections() {
    getJson('/api/public/elections').then(function (res) {
      state.elections = (res && res.elections) || [];
      var sel = $('pub-sel');
      if (!state.elections.length) {
        sel.innerHTML = '<span class="pub-sel-empty">No elections available yet.</span>';
        return;
      }
      sel.innerHTML = '<select id="pub-select" aria-label="Choose election">' +
        state.elections.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.title) + ' · ' + esc(STATUS[e.status] || e.status) + '</option>'; }).join('') +
        '</select>';
      var select = $('pub-select');
      if (state.currentId && select.querySelector('option[value="' + state.currentId + '"]')) select.value = state.currentId;
      state.currentId = select.value;
      select.addEventListener('change', function () {
        state.currentId = select.value;
        history.replaceState(null, '', '?id=' + encodeURIComponent(state.currentId));
        refresh();
      });
      showPanes();
      refresh();
      clearInterval(state.timer);
      state.timer = setInterval(refresh, 10000);
    }).catch(function () {
      var sel = $('pub-sel');
      sel.innerHTML = '<span class="pub-sel-empty">Could not reach the Pulse Vote Hub.</span>';
    });
  }

  function pickFromUrl() {
    var q = new URLSearchParams(window.location.search);
    var id = q.get('id');
    if (id) state.currentId = id;
  }

  function showPanes() {
    $('pub-tabs').hidden = false;
    $('pub-results').hidden = false;
    $('pub-declaration').hidden = false;
  }

  // ---------- Refresh ----------
  function refresh() {
    if (!state.currentId) return;
    getJson('/api/public/result/' + encodeURIComponent(state.currentId)).then(function (r) {
      if (!r || !r.ok) {
        $('pub-results').innerHTML = '<div class="pub-error">' + esc((r && r.error) || 'Could not load results.') + '</div>';
        return;
      }
      state.report = r;
      renderResults(r);
      renderDeclaration(r);
      $('pub-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }).catch(function () {
      $('pub-results').innerHTML = '<div class="pub-error">Could not reach the hub.</div>';
    });
  }

  // ---------- Live results view ----------
  function overallCard(r) {
    if (r.tie) {
      return '<div class="pub-ovc pub-ovc-tie"><span class="pub-ovc-label">/ Overall tie</span><span class="pub-ovc-name">' + esc(r.tie.name) + '</span><span class="pub-ovc-num">' + fmtNum(r.tie.votes) + ' votes each</span></div>';
    }
    if (r.winner) {
      return '<div class="pub-ovc"><span class="pub-ovc-label">Overall leader</span><span class="pub-ovc-name">' + esc(r.winner.name) + '</span><span class="pub-ovc-num">' + fmtNum(r.winner.votes) + ' votes · ' + r.winner.percentage + '%</span></div>';
    }
    return '';
  }

  function renderResults(r) {
    $('pub-results-empty').hidden = true;
    var e = r.election;
    var t = r.turnout || { registered: 0, cast: 0, turnoutPct: 0 };
    var cats = (r.categories || []).map(function (cat) {
      var top = Math.max(0, cat.candidates.map(function (c) { return c.votes; }));
      var cards = cat.candidates.map(function (c) {
        var win = c.votes > 0 && c.votes === top;
        return '<div class="pub-card' + (win ? ' is-active' : '') + '">' +
          '<div class="pub-card-top"><span class="pub-card-med">' + (c.name || '?').charAt(0).toUpperCase() + '</span><span class="pub-card-name">' + esc(c.name) + (win ? '<span class="pub-win" title="Leading">★</span>' : '') + '</span></div>' +
          '<div class="pub-card-num">' + fmtNum(c.votes) + ' <small>votes</small></div>' +
          '<div class="pub-bar"><div class="pub-bar-fill" style="width:' + Math.min(100, c.percentage) + '%"></div></div>' +
          '<div class="pub-card-pct">' + c.percentage + '% · category</div>' +
        '</div>';
      }).join('');
      return '<section class="pub-cat"><h3 class="pub-cat-title">' + esc(cat.name) + '</h3><div class="pub-cards">' + (cards || '<div class="pub-hint">No candidates.</div>') + '</div></section>';
    }).join('');

    var trow = (r.stations && r.stations.length) ? '' : '';
    $('pub-results').innerHTML =
      '<div class="pub-election"><h2>' + esc(e.title) + '</h2><span class="pub-status ' + esc(e.status) + '">' + esc(STATUS[e.status] || e.status) + '</span></div>' +
      overallCard(r) +
      '<div class="pub-stats">' +
        (e.type === 'station' ? '<div class="pub-stat"><span class="pub-stat-num">' + fmtNum((r.stations || []).length) + '</span><span class="pub-stat-lab">Stations reported</span></div>' : '') +
        '<div class="pub-stat"><span class="pub-stat-num">' + fmtNum(r.totalVotes) + '</span><span class="pub-stat-lab">Votes cast</span></div>' +
        '<div class="pub-stat"><span class="pub-stat-num">' + t.turnoutPct + '%</span><span class="pub-stat-lab">Turnout</span></div>' +
        '<div class="pub-stat"><span class="pub-stat-num">' + fmtNum(t.cast) + ' / ' + fmtNum(t.registered) + '</span><span class="pub-stat-lab">Registered voters</span></div>' +
      '</div>' +
      '<div class="pub-cats">' + cats + '</div>';
  }

  // ---------- Official declaration view ----------
  function categoryWinnersRows(r) {
    return (r.categoryWinners || []).map(function (cw) {
      if (cw.mode === 'win') {
        return '<div class="dcl-wrow win"><span class="dcl-wcat">' + esc(cw.name) + '</span><span class="dcl-wname">' + esc(cw.winner.name) + '</span><span class="dcl-wnum">' + fmtNum(cw.winner.votes) + ' votes · ' + cw.winner.percentage + '%</span></div>';
      }
      if (cw.mode === 'tie') {
        return '<div class="dcl-wrow tie"><span class="dcl-wcat">' + esc(cw.name) + '</span><span class="dcl-wname">' + esc(cw.names.join(' & ')) + '</span><span class="dcl-wnum">Tied at ' + fmtNum(cw.votes) + ' votes each</span></div>';
      }
      return '<div class="dcl-wrow none"><span class="dcl-wcat">' + esc(cw.name) + '</span><span class="dcl-wname">No votes cast</span><span class="dcl-wnum">—</span></div>';
    }).join('');
  }

  function categoryAccordion(r) {
    return r.categories.map(function (cat) {
      var top = Math.max(0, cat.candidates.map(function (c) { return c.votes; }));
      var cards = cat.candidates.map(function (c) {
        var win = c.votes > 0 && c.votes === top;
        return '<div class="dcl-card' + (win ? ' is-winner' : '') + '">' +
          '<div class="dcl-media" data-photo="' + esc(c.photo_path || '') + '">' + (c.name || '?').charAt(0).toUpperCase() + '</div>' +
          '<div class="dcl-card-name">' + esc(c.name) + (win ? '<span class="dcl-win-badge">★</span>' : '') + '</div>' +
          '<span class="dcl-card-arrow"></span>' +
        '</div>';
      }).join('');
      return '<div class="dcl-cat">' +
        '<div class="dcl-cat-btn"><span class="dcl-cat-ico"><span class="dcl-cat-glyph">✓</span></span><span class="dcl-cat-name">' + esc(cat.name) + '</span><span class="dcl-cat-meta">' + fmtNum(cat.votes) + ' vote' + (cat.votes === 1 ? '' : 's') + '</span></div>' +
        '<div class="dcl-cat-body"><div class="dcl-cat-inner"><div class="dcl-cards">' + cards + '</div></div></div>' +
      '</div>';
    }).join('');
  }

  function renderDeclaration(r) {
    var cont = $('pub-declaration');
    var e = r.election;
    if (!r.effectivelyClosed) {
      cont.innerHTML = '<div class="dcl dcl-locked"><span class="dcl-lock-ic">🔒</span><h3>Declaration not yet published</h3><p>The official declaration of results for <strong>' + esc(e.title) + '</strong> will be published here once polling closes and the results are certified.</p><div class="dcl-lock-meta"><span>Status · <b>' + esc(STATUS[r.status] || r.status) + '</b></span><span>Polling closes · <b>' + esc(fmtDateFull(e.end_date)) + '</b></span></div></div>';
      return;
    }
    var t = r.turnout || { registered: 0, cast: 0, turnoutPct: 0 };
    var wid = e.id && e.id.length > 8 ? e.id.slice(0, 8).toUpperCase() : (esc(e.id) || '—');
    var bandTag = r.status === 'closed' ? '<span class="dcl-band-tag">CERTIFIED</span>' : '<span class="dcl-band-tag">RESULTS DECLARED</span>';
    cont.innerHTML =
      '<div class="dcl">' +
        '<div class="dcl-head"><span class="dcl-seal"></span><div class="dcl-head-txt"><div class="dcl-kicker">Pulse Vote Hub · Electoral Administration</div><h2 class="dcl-title">Official Declaration of Results</h2><p class="dcl-sub">Published under the authority of the Electoral Administration</p></div>' + bandTag + '</div>' +
        '<div class="dcl-band"><span class="dcl-star">★</span> DECLARED UNDER ELECTORAL AUTHORITY <span class="dcl-star">★</span></div>' +
        '<div class="dcl-ident"><div class="dcl-ident-main"><h3>' + esc(e.title) + '</h3><p>' + (e.type === 'station' ? 'Station-based election' : 'School-wide election') + ' · Reference ' + wid + '</p></div><div class="dcl-ident-grid">' +
          '<span>Polling window<em>' + esc(fmtDateFull(e.start_date)) + ' – ' + esc(fmtDateFull(e.end_date)) + '</em></span>' +
          '<span>Categories<em>' + fmtNum(r.categoryWinners.length) + '</em></span>' +
          '<span>Registered voters<em>' + fmtNum(t.registered) + '</em></span>' +
          '<span>Votes cast<em>' + fmtNum(r.totalVotes) + '</em></span>' +
          '<span>Turnout<em>' + t.turnoutPct + '%</em></span>' +
          '<span>Declared on<em>' + esc(fmtDateDay(e.end_date)) + '</em></span>' +
        '</div></div>' +
        '<p class="dcl-preamble">Pursuant to the official election schedule for <strong>' + esc(e.title) + '</strong>, and upon the final tally of votes duly cast and counted at the close of polling, the Electoral Administration hereby certifies the outcome and declares the following candidates duly elected to the offices specified below.</p>' +
        '<section class="dcl-block"><div class="dcl-block-title">Duly elected</div><div class="dcl-wrows">' + categoryWinnersRows(r) + '</div></section>' +
        '<section class="dcl-block"><div class="dcl-block-title">Certified results by category</div><div class="dcl-cats">' + categoryAccordion(r) + '</div></section>' +
        '<div class="dcl-foot"><div class="dcl-sig"><div class="dcl-sig-line"></div><span>Chairperson</span><em>Electoral Administration</em></div><div class="dcl-sig"><div class="dcl-sig-line"></div><span>Secretary</span><em>Electoral Administration</em></div><div class="dcl-declared"><span>Declared this</span><strong>' + esc(fmtDateFull(e.end_date)) + '</strong></div></div>' +
      '</div>';
    loadPhotos(cont);
  }

  function loadPhotos(root) {
    root.querySelectorAll('.dcl-media[data-photo]').forEach(function (media) {
      var p = media.dataset.photo;
      if (!p) return;
      var img = document.createElement('img');
      img.className = 'dcl-photo';
      img.alt = '';
      img.decoding = 'async';
      img.onerror = function () { img.remove(); };
      img.src = '/api/public/photo?p=' + encodeURIComponent(p);
      media.appendChild(img);
    });
  }

  // ---------- Tabs + init ----------
  function initTabs() {
    var tabs = document.querySelectorAll('.pub-tab');
    tabs.forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.dataset.tab;
        tabs.forEach(function (x) { x.classList.toggle('active', x === b); });
        $('pub-results').hidden = state.tab !== 'results';
        $('pub-declaration').hidden = state.tab !== 'declaration';
      });
    });
  }

  window.addEventListener('DOMContentLoaded', function () {
    initTabs();
    pickFromUrl();
    loadElections();
  });
})();
