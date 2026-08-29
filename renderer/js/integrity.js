// Integrity check panel (Administration > Integrity check). Calls into the
// main process to recompute the vote + audit hash chains and run SQLite's
// PRAGMA integrity_check, then renders a compact pass/fail summary.
(function () {
  const $ = (id) => document.getElementById(id);
  const pill = (ok) => {
    const el = $('integrity-pill');
    el.classList.toggle('ok', ok === true);
    el.classList.toggle('bad', ok === false);
    el.classList.toggle('warn', ok == null);
    $('integrity-pill-text').textContent = ok === true ? 'Verified' : ok === false ? 'Compromised' : 'Unknown';
  };

  const fmt = (n) => Number(n || 0).toLocaleString();

  function render(check) {
    const report = $('integrity-report');
    report.style.display = 'block';
    const rows = (label, part) => {
      let body;
      if (part.ok) {
        const count = typeof part.rows === 'number' ? ` &middot; ${fmt(part.rows)} entries verified` : '';
        body = `<span class="integrity-row-ok">OK${count}</span>`;
      } else {
        const detail = part.at ? ` broken at row #${part.at} (${part.reason})` : ` failed — ${part.reason || part.result || 'unknown'}`;
        body = `<span class="integrity-row-bad">FAILED${detail}</span>`;
      }
      return `<div class="integrity-row"><span class="integrity-row-label">${label}</span>${body}</div>`;
    };
    report.innerHTML = `
      ${rows('Vote hash chain', check.voteChain)}
      ${rows('Audit hash chain', check.auditChain)}
      ${rows('SQLite integrity check', check.pragma)}
      <div class="integrity-row"><span class="integrity-row-label">Checked at</span>
        <span class="integrity-row-meta">${new Date(check.checkedAt).toLocaleString()} (${check.durationMs}ms)</span></div>
    `;
    $('integrity-msg').textContent = '';
  }

  async function run() {
    const btn = $('integrity-run-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    $('integrity-msg').textContent = '';
    const check = await window.pvh.verifyIntegrity();
    pill(check.ok);
    render(check);
    if (!check.ok) $('integrity-msg').textContent = 'Tampering detected — investigate immediately.';
    btn.disabled = false;
    btn.textContent = 'Verify now';
  }

  const btn = $('integrity-run-btn');
  if (btn) btn.addEventListener('click', run);

  // Refresh the pill automatically once on load so a pre-existing breach shows.
  window.pvh.verifyIntegrity().then((check) => {
    pill(check.ok);
    $('integrity-msg').textContent = '';
  }).catch(() => {});
})();