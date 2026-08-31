// Browser transport for the ballot page served by the LAN hub at /kiosk.
// Vote.js talks exclusively through window.pvh (the Electron preload bridge);
// in a plain browser this script re-implements the same surface on top of
// fetch() to THIS host, so the exact same ballot UI runs with no install.
// Votes still land in the hub's database through the desktop code path —
// identity checks, the vote/audit hash chain and LAN sync are unchanged.
(function () {
  // Served over http:// (the LAN hub /kiosk page): the fetch shim must ALWAYS
  // win, even inside the Electron window where a preload `window.pvh` already
  // exists — the preload bridge talks IPC to the desktop portal and cannot
  // serve the hub's own kiosk endpoints. Only the file:// portal page keeps
  // the preload bridge.
  const isHttp = !!window.location.host;
  if (!isHttp && (window.pvh || typeof fetch === 'undefined')) return; // Electron portal

  const json = async (url, opts) => {
    const res = await fetch(url, opts || {});
    let body = {};
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok && res.status >= 500) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  };
  const post = (url, payload) => json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const obj = (r, listKey, what) => {
    if (!r || r.ok === false) throw new Error((r && r.error) || `Could not load ${what}`);
    return r[listKey] || [];
  };

  window.pvh = {
    serverMode: true,
    listElections: async () => obj(await json('/api/kiosk/elections'), 'elections', 'elections'),
    listPositions: async (eid) => obj(await json(`/api/kiosk/positions/${encodeURIComponent(eid)}`), 'positions', 'categories'),
    listCandidates: async (eid) => obj(await json(`/api/kiosk/candidates/${encodeURIComponent(eid)}`), 'candidates', 'candidates'),
    candidatePhotoUrl: async (p) => (p ? `/api/kiosk/photo?p=${encodeURIComponent(p)}` : null),
    verifyVoter: (eid, vid, pwd) => post('/api/kiosk/verify', { electionId: eid, voterId: vid, password: pwd }),
    verifyVoterDetails: (eid, details) => post('/api/kiosk/verify-details', { electionId: eid, details: details || {} }),
    castVote: (eid, vid, sel, station) => post('/api/kiosk/cast', { electionId: eid, voterId: vid, selection: sel, station }),
    kioskEnter: async () => ({ ok: true }),
    kioskExit: async () => ({ ok: true }),
  };
})();