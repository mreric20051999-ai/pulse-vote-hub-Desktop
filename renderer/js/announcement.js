(function () {
  const session = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
  if (!session) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const pickerRoot = $('election-picker');
  const declPanel = $('decl-panel');
  const declRoot = $('decl-root');
  const actions = $('decl-actions');
  let currentElectionId = null;
  let lastReport = null;
  let lastHtml = '';
  let activePop = null;

  const statusMap = { draft: 'Draft', upcoming: 'Upcoming', active: 'Active', closed: 'Closed' };

  function fmtNum(n) { return Number(n || 0).toLocaleString(); }

  function fmtDateFull(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDateDay(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // ---------- Election picker ----------
  async function loadElections() {
    pickerRoot.innerHTML = '<p class="text-muted hint">Loading elections…</p>';
    let list;
    try { list = await window.pvh.listElections(); } catch (e) { list = []; }
    if (!Array.isArray(list) || !list.length) {
      pickerRoot.innerHTML = '<p class="pick-empty">No elections yet. Create one in Elections to see its declaration of results.</p>';
      return;
    }
    pickerRoot.innerHTML = list.map((e) => `
      <div class="pick-card" data-id="${esc(e.id)}" data-title="${esc(e.title)}">
        <div class="pick-card-title">${esc(e.title)}</div>
        <div class="pick-meta">
          <span>${e.type === 'station' ? 'Station' : 'School'}</span>
          <span class="${e.status === 'closed' ? 'pick-meta-closed' : ''}">${e.status === 'closed' ? '◉ Declared' : statusMap[e.status] || '—'}</span>
        </div>
      </div>`).join('');
    pickerRoot.querySelectorAll('.pick-card').forEach((card) => {
      card.addEventListener('click', () => {
        currentElectionId = card.dataset.id;
        const q = new URLSearchParams(window.location.search);
        q.set('id', currentElectionId);
        history.replaceState(null, '', '?' + q.toString());
        loadDeclaration();
      });
    });
  }

  // ---------- Declaration ----------
  async function loadDeclaration() {
    if (!currentElectionId) return;
    declPanel.style.display = '';
    declRoot.innerHTML = '<p class="text-muted hint">Preparing the declaration…</p>';
    actions.style.display = '';
    let r;
    try { r = await window.pvh.resultsReport(currentElectionId, null); } catch (e) { r = { ok: false, error: String(e) }; }
    if (!r || !r.ok) {
      if (r && r.code === 'forbidden') { declRoot.innerHTML = '<p class="auth-error">You do not have access to this election.</p>'; return; }
      declRoot.innerHTML = `<p class="auth-error">${esc((r && r.error) || 'Could not load results')}</p>`;
      return;
    }
    deactivateCards(currentElectionId);
    renderDeclaration(r);
  }

  function deactivateCards(id) {
    pickerRoot.querySelectorAll('.pick-card').forEach((c) => {
      c.classList.toggle('is-active', c.dataset.id === id);
    });
  }

  function renderDeclaration(r) {
    lastReport = r;
    const e = r.election;

    if (!r.effectivelyClosed) {
      lastHtml = `
        <div class="dcl dcl-locked">
          <span class="icon dcl-lock-ic" data-icon="lock"></span>
          <h3>Declaration not yet published</h3>
          <p>The official declaration of results for <strong>${esc(e.title)}</strong> will be published here once polling closes and the results are certified.</p>
          <div class="dcl-lock-meta">
            <span>Status &middot; <b>${statusMap[r.status] || esc(r.status)}</b></span>
            <span>Polling closes &middot; <b>${esc(fmtDateFull(e.end_date))}</b></span>
          </div>
        </div>`;
      declRoot.innerHTML = lastHtml;
      if (window.pvhIcons) window.pvhIcons.inject('.icon');
      return;
    }

    lastHtml = buildDeclaration(r, { print: false });
    activePop = null;
    declRoot.innerHTML = lastHtml;
    if (window.pvhIcons) window.pvhIcons.inject('.icon');
    bindCatAccordion();
    bindCandidatePhotos(declRoot);
  }

  // ---------- Declaration document ----------
  function buildDeclaration(r, opts) {
    const print = !!(opts && opts.print);
    const e = r.election;
    const t = r.turnout || { registered: 0, cast: 0, turnoutPct: 0 };
    const etype = e.type === 'station' ? 'Station-based election' : 'School-wide election';

    const winnersRows = (r.categoryWinners || []).map((cw) => {
      if (cw.mode === 'win') {
        return `
          <div class="dcl-wrow win">
            <span class="dcl-wcat">${esc(cw.name)}</span>
            <span class="dcl-wname">${esc(cw.winner.name)}</span>
            <span class="dcl-wnum">${fmtNum(cw.winner.votes)} votes &middot; ${cw.winner.percentage}%</span>
          </div>`;
      }
      if (cw.mode === 'tie') {
        return `
          <div class="dcl-wrow tie">
            <span class="dcl-wcat">${esc(cw.name)}</span>
            <span class="dcl-wname">${esc(cw.names.join(' & '))}</span>
            <span class="dcl-wnum">Tied at ${fmtNum(cw.votes)} votes each</span>
          </div>`;
      }
      return `
        <div class="dcl-wrow none">
          <span class="dcl-wcat">${esc(cw.name)}</span>
          <span class="dcl-wname">No votes cast</span>
          <span class="dcl-wnum">&mdash;</span>
        </div>`;
    }).join('');

    const wid = e.id && e.id.length > 8 ? e.id.slice(0, 8).toUpperCase() : (esc(e.id) || '—');
    const statusBand = r.status === 'closed' ? '<span class="dcl-band-tag">CERTIFIED</span>' : '<span class="dcl-band-tag">RESULTS DECLARED</span>';

    return `
      <div class="dcl">
        <div class="dcl-head">
          <span class="dcl-seal" aria-hidden="true"></span>
          <div class="dcl-head-txt">
            <div class="dcl-kicker">Pulse Vote Hub &middot; Electoral Administration</div>
            <h2 class="dcl-title">Official Declaration of Results</h2>
            <p class="dcl-sub">Published under the authority of the Electoral Administration</p>
          </div>
          ${statusBand}
        </div>

        <div class="dcl-band"><span class="dcl-star" aria-hidden="true">&#9733;</span> DECLARED UNDER ELECTORAL AUTHORITY <span class="dcl-star" aria-hidden="true">&#9733;</span></div>

        <div class="dcl-ident">
          <div class="dcl-ident-main">
            <h3>${esc(e.title)}</h3>
            <p>${etype} &middot; Reference ${wid}</p>
          </div>
          <div class="dcl-ident-grid">
            <span>Polling window<em>${esc(fmtDateFull(e.start_date))} &ndash; ${esc(fmtDateFull(e.end_date))}</em></span>
            <span>Categories<em>${fmtNum(r.categoryWinners.length)}</em></span>
            <span>Registered voters<em>${fmtNum(t.registered)}</em></span>
            <span>Votes cast<em>${fmtNum(r.totalVotes)}</em></span>
            <span>Turnout<em>${t.turnoutPct}%</em></span>
            <span>Declared on<em>${esc(fmtDateDay(e.end_date))}</em></span>
          </div>
        </div>

        <p class="dcl-preamble">Pursuant to the official election schedule for <strong>${esc(e.title)}</strong>, and upon the final tally of votes duly cast and counted at the close of polling, the Electoral Administration hereby certifies the outcome and declares the following candidates duly elected to the offices specified below.</p>

        <section class="dcl-block">
          <div class="dcl-block-title">Duly elected</div>
          <div class="dcl-wrows">${winnersRows || '<div class="dcl-wrow none"><span class="dcl-wcat">&mdash;</span><span class="dcl-wname">No candidates registered</span></div>'}</div>
        </section>

        <section class="dcl-block">
          <div class="dcl-block-title">Certified results by category</div>
          <div class="dcl-cats" id="dcl-cats">${buildCatAccordion(r, print)}</div>
        </section>

        <div class="dcl-foot">
          <div class="dcl-sig">
            <div class="dcl-sig-line"></div>
            <span>Chairperson</span>
            <em>Electoral Administration</em>
          </div>
          <div class="dcl-sig">
            <div class="dcl-sig-line"></div>
            <span>Secretary</span>
            <em>Electoral Administration</em>
          </div>
          <div class="dcl-declared">
            <span>Declared this</span>
            <strong>${esc(fmtDateFull(e.end_date))}</strong>
          </div>
        </div>
      </div>`;
  }

  // ---------- Certified results: interactive category accordion ----------
  function buildCatAccordion(r, allOpen) {
    return r.categories.map((cat, ci) => {
      const top = Math.max(0, ...cat.candidates.map((c) => c.votes));
      const cards = cat.candidates.map((c, i) => {
        const win = c.votes > 0 && c.votes === top;
        const initial = (c.name || '?').charAt(0).toUpperCase();
        const ballot = c.ballot_number != null && c.ballot_number > 0 ? 'Ballot #' + c.ballot_number : 'Rank #' + (i + 1);
        const open = allOpen ? ' open' : '';
        const detailHtml = allOpen ? `
              <div class="dcl-card-detail">
                <div class="dcl-detail-inner">
                  <div class="dcl-detail-rows">
                    <div class="dcl-detail-row"><span class="dcl-detail-label">Total votes</span><strong class="dcl-detail-val">${fmtNum(c.votes)}</strong></div>
                    <div class="dcl-detail-row"><span class="dcl-detail-label">Category share</span><strong class="dcl-detail-val">${c.percentage}%</strong></div>
                  </div>
                  <div class="dcl-bar"><div class="dcl-bar-fill" style="width:${Math.min(100, c.percentage)}%"></div></div>
                  <div class="dcl-detail-meta"><span>${esc(ballot)}</span><span>${win ? 'Duly elected' : 'Certified result'}</span></div>
                </div>
              </div>` : '';
        return `
          <div class="dcl-card${win ? ' is-winner' : ''}${open}" tabindex="0" role="button" aria-expanded="${allOpen ? 'true' : 'false'}"
            data-votes="${c.votes}" data-pct="${c.percentage}" data-ballot="${esc(ballot)}" data-win="${win ? 'true' : 'false'}">
            <div class="dcl-media" data-photo="${esc(c.photo_path || '')}">${esc(initial)}</div>
            <div class="dcl-card-name">${esc(c.name)}${win ? '<span class="dcl-win-badge" title="Winner">&#9733;</span>' : ''}</div>
            <span class="dcl-card-arrow" aria-hidden="true"></span>
            ${detailHtml}
          </div>`;
      }).join('');
      const open = allOpen || ci === 0;
      const ico = allOpen
        ? '<span class="dcl-cat-ico"><span class="dcl-cat-glyph">&#10003;</span></span>'
        : '<span class="dcl-cat-ico"><span class="icon" data-icon="results"></span></span>';
      return `
        <div class="dcl-cat">
          <button type="button" class="dcl-cat-btn${open ? ' open' : ''}" aria-expanded="${open ? 'true' : 'false'}">
            ${ico}
            <span class="dcl-cat-name">${esc(cat.name)}</span>
            <span class="dcl-cat-meta">${fmtNum(cat.votes)} vote${cat.votes === 1 ? '' : 's'} &middot; ${cat.candidates.length} candidate${cat.candidates.length === 1 ? '' : 's'}</span>
            <span class="dcl-cat-arrow" aria-hidden="true"></span>
          </button>
          <div class="dcl-cat-body">
            <div class="dcl-cat-inner">
              <div class="dcl-cards">${cards}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function bindCatAccordion() {
    const root = document.getElementById('dcl-cats');
    if (!root) return;
    root.querySelectorAll('.dcl-cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const open = btn.classList.toggle('open');
        closeCardPop();
        root.querySelectorAll('.dcl-cat-btn.open').forEach((b) => { if (b !== btn) b.classList.remove('open'); });
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
    root.querySelectorAll('.dcl-card').forEach((card) => {
      const toggle = () => {
        if (activePop && activePop._card === card) { closeCardPop(); }
        else { openCardPop(card); }
      };
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
    });
  }

  // Floating result popover — overlays below the card so the card never grows.
  function openCardPop(card) {
    const dcl = card.closest('.dcl');
    if (!dcl) return;
    closeCardPop();
    const pop = document.createElement('div');
    pop.className = 'dcl-pop';
    pop._card = card;
    pop.innerHTML = `
      <div class="dcl-detail-rows">
        <div class="dcl-detail-row"><span class="dcl-detail-label">Total votes</span><strong class="dcl-detail-val">${fmtNum(card.dataset.votes)}</strong></div>
        <div class="dcl-detail-row"><span class="dcl-detail-label">Category share</span><strong class="dcl-detail-val">${esc(card.dataset.pct)}%</strong></div>
      </div>
      <div class="dcl-bar"><div class="dcl-bar-fill" style="width:${Math.min(100, Number(card.dataset.pct))}%"></div></div>
      <div class="dcl-detail-meta"><span>${esc(card.dataset.ballot)}</span><span>${card.dataset.win === 'true' ? 'Duly elected' : 'Certified result'}</span></div>`;
    dcl.appendChild(pop);
    const position = () => {
      const cr = card.getBoundingClientRect();
      const dr = dcl.getBoundingClientRect();
      pop.style.left = (cr.left - dr.left + dcl.scrollLeft) + 'px';
      pop.style.top = (cr.bottom - dr.top + dcl.scrollTop + 8) + 'px';
      pop.style.width = cr.width + 'px';
    };
    position();
    requestAnimationFrame(() => requestAnimationFrame(position));
    card.classList.add('is-open');
    card.setAttribute('aria-expanded', 'true');
    activePop = pop;
  }

  function closeCardPop() {
    if (!activePop) return;
    if (activePop._card) {
      activePop._card.classList.remove('is-open');
      activePop._card.setAttribute('aria-expanded', 'false');
    }
    activePop.remove();
    activePop = null;
  }

  function bindCandidatePhotos(root) {
    root.querySelectorAll('.dcl-media[data-photo]').forEach((media) => {
      if (!media.dataset.photo) return;
      const img = document.createElement('img');
      img.className = 'dcl-photo';
      img.alt = '';
      img.decoding = 'async';
      window.pvh.candidatePhotoUrl(media.dataset.photo).then((url) => {
        if (url) {
          img.src = url;
          media.appendChild(img);
        }
      });
    });
  }

  // ---------- Export / print ----------
  function safeBase(title) {
    return (title || 'declaration').replace(/[^\w\- ]+/g, '_').trim().replace(/\s+/g, '_');
  }

  function handleExportError(res, label) {
    if (res && res.canceled) return;
    alert((res && res.error) || `${label} export failed.`);
  }

  async function buildStandaloneHtml() {
    const title = lastReport.election.title;
    const r = lastReport;
    let body = r.effectivelyClosed ? buildDeclaration(r, { print: true }) : lastHtml;
    const css = buildDeclarationCss();

    const photos = [...new Set((body.match(/data-photo="([^"]*)"/g) || []).map((m) => m.slice(12, -1)).filter(Boolean))];
    const urlMap = {};
    await Promise.all(photos.map(async (p) => { if (!(p in urlMap)) urlMap[p] = await window.pvh.candidatePhotoUrl(p); }));
    body = body.replace(/(<div class="dcl-media" data-photo=")([^"]*)">[\s\S]*?<\/div>/g, (m, pre, path) => {
      const url = urlMap[path];
      return url ? `${pre}${path}"><img class="dcl-photo" src="${esc(encodeURI(url))}" alt="" /></div>` : m;
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)} — Official Declaration of Results</title>
  <style>${css}</style>
</head>
<body class="print-body">
  <div class="dcl-render">${body}</div>
</body>
</html>`;
  }

  async function exportHtml() {
    if (!lastReport) return;
    const base = safeBase(lastReport.election.title);
    const html = await buildStandaloneHtml();
    window.pvh.exportFile(html, `${base}_declaration`, 'html').then((res) => {
      if (!res || !res.ok) handleExportError(res, 'HTML');
    });
  }

  async function exportPdf() {
    if (!lastReport) return;
    const base = safeBase(lastReport.election.title);
    const html = await buildStandaloneHtml();
    window.pvh.exportPdf(html, `${base}_declaration`).then((res) => {
      if (!res || !res.ok) handleExportError(res, 'PDF');
    });
  }

  async function printDeclaration() {
    if (!lastReport) return;
    const html = await buildStandaloneHtml();
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 3000);
  }

  function buildDeclarationCss() {
    return /* css */ `:root{--surface:#ffffff;--surface-2:#f8fafc;--surface-3:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--text-muted:#64748b;--text-dim:#94a3b8;--accent:#B30202;--accent-soft:#fee2e2;--info:#2563eb;}
body.print-body{font-family:'Segoe UI',Georgia,serif,sans-serif;color:#0f172a;background:#fff;margin:0;padding:36px;}
.dcl-render{max-width:820px;margin:0 auto;}
.dcl{position:relative;border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:30px 34px;}
.dcl::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#B30202,#2563eb);}
.dcl-head{position:relative;display:flex;align-items:center;justify-content:center;gap:16px;padding:0 96px;margin-bottom:14px;min-height:46px;}
.dcl-seal{position:absolute;left:0;top:50%;transform:translateY(-50%);flex-shrink:0;width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#B30202,#dc2626);}
.dcl-seal::after{content:'';position:absolute;inset:12px;border:2px solid #fff;border-radius:7px;}
.dcl-head-txt{text-align:center;min-width:0;}
.dcl-kicker{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#64748b;}
.dcl-title{margin:3px 0 2px;font-size:24px;font-weight:800;color:#0f172a;letter-spacing:.01em;}
.dcl-sub{margin:0;font-size:12.5px;color:#64748b;}
.dcl-band{display:flex;align-items:center;justify-content:center;gap:10px;font-size:11.5px;font-weight:800;letter-spacing:.22em;color:#991b1b;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;padding:9px 0;margin:0 0 18px;}
.dcl-band-tag{position:absolute;right:0;top:50%;transform:translateY(-50%);flex-shrink:0;font-size:10.5px;font-weight:800;letter-spacing:.1em;color:#fff;background:#B30202;padding:5px 12px;border-radius:999px;white-space:nowrap;}
.dcl-star{font-size:9px;}
.dcl-ident{border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;padding:16px 18px;margin-bottom:16px;}
.dcl-ident-main{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px dashed #e2e8f0;padding-bottom:10px;margin-bottom:12px;}
.dcl-ident-main h3{margin:0;font-size:19px;color:#0f172a;}
.dcl-ident-main p{margin:0;font-size:12px;color:#64748b;}
.dcl-ident-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px;}
.dcl-ident-grid span{display:flex;flex-direction:column;gap:2px;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;}
.dcl-ident-grid em{font-style:normal;font-size:12.5px;font-weight:700;color:#0f172a;text-transform:none;letter-spacing:0;}
.dcl-preamble{margin:0 0 18px;font-size:13.5px;line-height:1.6;color:#475569;}
.dcl-preamble strong{color:#0f172a;}
.dcl-block{margin-bottom:20px;}
.dcl-block-title{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#B30202;border-bottom:2px solid #B30202;padding-bottom:6px;margin-bottom:12px;}
.dcl-wrows{display:flex;flex-direction:column;gap:8px;}
.dcl-wrow{display:flex;align-items:center;gap:14px;padding:11px 14px;border:1px solid #e2e8f0;border-left:4px solid #B30202;border-radius:8px;background:#f8fafc;}
.dcl-wrow.tie{border-left-color:#2563eb;}
.dcl-wrow.none{border-left-color:#cbd5e1;opacity:.65;}
.dcl-wcat{flex:0 0 170px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;}
.dcl-wname{flex:1 1 auto;min-width:0;font-size:15px;font-weight:800;color:#0f172a;}
.dcl-wnum{flex:0 0 auto;font-size:12.5px;font-weight:700;color:#B30202;white-space:nowrap;}
.dcl-wrow.tie .dcl-wnum{color:#2563eb;}
.dcl-cats{display:flex;flex-direction:column;gap:12px;}
.dcl-cats>*{break-inside:avoid;}
.dcl-cat{border:1px solid #e2e8f0;border-radius:10px;background:#fff;overflow:hidden;}
.dcl-cat-btn{width:100%;display:flex;align-items:center;gap:12px;background:#f8fafc;border:0;cursor:pointer;padding:13px 16px;text-align:left;color:inherit;}
.dcl-cat-btn:hover{background:#f1f5f9;}
.dcl-cat-ico{flex-shrink:0;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:#fee2e2;color:#B30202;}
.dcl-cat-ico .icon{width:17px;height:17px;}
.dcl-cat-glyph{font-size:14px;line-height:1;color:#B30202;font-weight:800;}
.dcl-cat-name{flex:0 0 auto;font-size:15px;font-weight:800;color:#0f172a;}
.dcl-cat-meta{margin-left:auto;font-size:12px;color:#64748b;white-space:nowrap;}
.dcl-cat-arrow{flex-shrink:0;width:9px;height:9px;border-right:2px solid #64748b;border-bottom:2px solid #64748b;transform:rotate(45deg);margin:0 6px 4px 0;transition:transform .18s;}
.dcl-cat-btn.open .dcl-cat-arrow{transform:rotate(225deg) translate(-2px,-2px);}
.dcl-cat-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .32s cubic-bezier(.4,0,.2,1);}
.dcl-cat-btn.open+.dcl-cat-body{grid-template-rows:1fr;}
.dcl-cat-inner{overflow:hidden;min-height:0;padding:0 16px;transition:padding-top .32s cubic-bezier(.4,0,.2,1),padding-bottom .32s cubic-bezier(.4,0,.2,1);}
.dcl-cat-btn.open+.dcl-cat-body .dcl-cat-inner{border-top:1px solid #e2e8f0;padding-top:13px;padding-bottom:16px;}
.dcl-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:14px;}
.dcl-card{position:relative;display:flex;flex-direction:column;gap:7px;padding:12px 12px 14px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;cursor:pointer;user-select:none;transition:border-color .18s,box-shadow .18s,transform .18s;}
.dcl-card:hover{border-color:#cbd5e1;box-shadow:0 6px 16px rgba(15,23,42,.08);transform:translateY(-1px);}
.dcl-card.is-winner{border-color:#B30202;box-shadow:0 4px 14px rgba(179,2,2,.12);}
.dcl-card:focus-visible{outline:2px solid #B30202;outline-offset:2px;}
.dcl-media{position:relative;aspect-ratio:1/1;border-radius:9px;background:linear-gradient(135deg,#e2e8f0,#cbd5e1);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;color:#64748b;overflow:hidden;}
.dcl-media .dcl-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.dcl-card-name{display:flex;align-items:center;gap:5px;font-size:13.5px;font-weight:800;color:#0f172a;line-height:1.25;min-height:34px;}
.dcl-win-badge{flex-shrink:0;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:#B30202;color:#fff;font-size:10px;}
.dcl-card-arrow{position:absolute;bottom:10px;left:50%;width:8px;height:8px;border-right:2px solid #94a3b8;border-bottom:2px solid #94a3b8;transform:translateX(-50%) rotate(45deg);transition:transform .22s ease;}
.dcl-card.open .dcl-card-arrow{transform:translateX(-50%) rotate(225deg);}
.dcl-card-detail{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.4,0,.2,1);}
.dcl-card.open .dcl-card-detail{grid-template-rows:1fr;}
.dcl-detail-inner{overflow:hidden;min-height:0;margin-top:2px;}
.dcl-detail-rows{display:flex;flex-direction:column;}
.dcl-detail-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:5px 0;border-bottom:1px solid #e2e8f0;}
.dcl-detail-row:last-child{border-bottom:0;padding-bottom:0;}
.dcl-detail-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;line-height:1.3;color:#94a3b8;}
.dcl-detail-val{font-size:15px;font-weight:800;color:#0f172a;white-space:nowrap;flex-shrink:0;}
.dcl-detail-row:first-child .dcl-detail-val{color:#B30202;}
.dcl-bar{height:7px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin-bottom:8px;}
.dcl-bar-fill{height:100%;background:linear-gradient(90deg,#dc2626,#B30202);border-radius:999px;}
.dcl-detail-meta{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:#94a3b8;}
.dcl-detail-meta span{font-weight:700;}
.dcl-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;border-top:1px dashed #cbd5e1;padding-top:20px;margin-top:6px;}
.dcl-sig{display:flex;flex-direction:column;gap:4px;}
.dcl-sig-line{width:168px;height:2px;background:#94a3b8;margin-bottom:6px;}
.dcl-sig span{font-size:12.5px;font-weight:800;color:#0f172a;}
.dcl-sig em{font-style:normal;font-size:11.5px;color:#64748b;}
.dcl-declared{display:flex;flex-direction:column;gap:3px;align-items:flex-end;font-size:11px;color:#64748b;}
.dcl-declared strong{font-size:12px;color:#0f172a;}
.dcl-locked{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:40px 24px;}
.dcl-lock-ic{width:44px;height:44px;color:#94a3b8;margin-bottom:4px;}
.dcl-locked h3{margin:0;font-size:20px;color:#0f172a;}
.dcl-locked p{margin:0;font-size:14px;color:#64748b;max-width:460px;}
.dcl-lock-meta{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;justify-content:center;}
.dcl-lock-meta span{font-size:11.5px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:5px 12px;color:#64748b;}
@media print{body.print-body{padding:0;}@page{margin:18mm;}}`;
  }

  // ---------- Wire actions ----------
  $('back-btn').addEventListener('click', () => {
    window.location.href = 'results.html' + (currentElectionId ? '?id=' + encodeURIComponent(currentElectionId) : '');
  });
  $('print-btn').addEventListener('click', printDeclaration);
  $('export-html-btn').addEventListener('click', exportHtml);
  $('export-pdf-btn').addEventListener('click', exportPdf);

  // Clicking outside an open popover closes it.
  document.addEventListener('click', (e) => {
    if (!activePop) return;
    if (!activePop.contains(e.target) && !(activePop._card && activePop._card.contains(e.target))) {
      closeCardPop();
    }
  });

  // ---------- Init ----------
  const q = new URLSearchParams(window.location.search);
  const idFromUrl = q.get('id');
  document.title = 'Official Declaration \u00b7 Pulse Vote Hub';
  loadElections();
  if (idFromUrl) {
    currentElectionId = idFromUrl;
    loadDeclaration();
  }
})();