// Pure merge algorithm for the Multi-Location Merge tool (Phase 10).
// No DOM / electron dependencies so it can be unit-tested under Node and
// reused by the renderer (Administration > Merge results).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MergeCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normVid = (s) => String(s || '').trim().toUpperCase();

  // Reconcile N election snapshots into a single workspace. Positions and
  // candidates are unified by *name* (each device assigns its own UUIDs, so
  // ids cannot be matched across files). Voters are keyed by Voter ID.
  // Returns { files, positions, candidates, voterMap, rawVotes, duplicates, election }.
  function buildWork(files) {
    const positions = [];
    const posByKey = new Map();
    const candidates = [];
    const candByKey = new Map();
    const filePos = new Map();
    const fileCand = new Map();
    const voterMap = new Map();
    const rawVotes = [];

    const candListOf = (snap) => {
      const direct = Array.isArray(snap.candidates) ? snap.candidates : [];
      const nested = [];
      for (const p of Array.isArray(snap.positions) ? snap.positions : []) {
        if (Array.isArray(p.candidates)) {
          for (const c of p.candidates) nested.push(Object.assign({}, c, { position_id: c.position_id || p.id }));
        }
      }
      return nested.length ? nested : direct;
    };

    for (let f = 0; f < files.length; f++) {
      const snap = files[f];
      for (const p of Array.isArray(snap.positions) ? snap.positions : []) {
        const key = normKey(p.title);
        if (!key) continue;
        if (!posByKey.has(key)) { const pos = { key, title: String(p.title) }; positions.push(pos); posByKey.set(key, pos); }
        filePos.set(f + '::' + p.id, key);
      }
      for (const c of candListOf(snap)) {
        const posKey = filePos.get(f + '::' + c.position_id);
        if (!posKey) continue;
        const nk = normKey(c.name);
        if (!nk) continue;
        const ckey = posKey + '|' + nk;
        if (!candByKey.has(ckey)) { const cand = { key: ckey, posKey, name: String(c.name) }; candidates.push(cand); candByKey.set(ckey, cand); }
        fileCand.set(f + '::' + c.id, ckey);
      }
    }

    const makeVoter = (vid) => ({ vid, name: null, station: null, regFiles: new Set(), ballots: new Map(), ballCount: new Map() });

    for (let f = 0; f < files.length; f++) {
      const snap = files[f];
      for (const r of Array.isArray(snap.votes) ? snap.votes : []) {
        const posKey = filePos.get(f + '::' + r.position_id);
        const ckey = fileCand.get(f + '::' + r.candidate_id);
        if (!posKey || !ckey) continue;
        const vid = normVid(r.voter_id);
        if (!vid) continue;
        const ent = voterMap.get(vid) || (voterMap.set(vid, makeVoter(vid)), voterMap.get(vid));
        const ts = Number(r.timestamp) || 0;
        rawVotes.push({ f, vid, posKey, ckey, ts });
        if (!ent.ballots.has(f)) ent.ballots.set(f, ts);
        ent.ballCount.set(f, (ent.ballCount.get(f) || 0) + 1);
      }
    }

    for (let f = 0; f < files.length; f++) {
      const snap = files[f];
      for (const v of Array.isArray(snap.voters) ? snap.voters : []) {
        const vid = normVid(v.voter_id);
        if (!vid) continue;
        const ent = voterMap.get(vid) || (voterMap.set(vid, makeVoter(vid)), voterMap.get(vid));
        ent.regFiles.add(f);
        if (!ent.name && v.name) ent.name = String(v.name);
        if (!ent.station && v.assigned_station) ent.station = String(v.assigned_station);
      }
    }

    const duplicates = [];
    for (const ent of voterMap.values()) {
      const ballotFiles = [...ent.ballots.keys()];
      if (ent.regFiles.size > 1 || ballotFiles.length > 1) {
        duplicates.push({
          vid: ent.vid, name: ent.name, station: ent.station,
          regFiles: [...ent.regFiles].sort((a, b) => a - b),
          ballotFiles: ballotFiles.sort((a, b) => a - b),
          ballots: [...ent.ballots.entries()].map(([f, ts]) => ({ f, ts })),
          dbl: ballotFiles.length > 1,
        });
      }
    }
    duplicates.sort((a, b) => (Number(b.dbl) - Number(a.dbl)) || a.vid.localeCompare(b.vid));

    const first = (files[0] && files[0].election) || {};
    return {
      files,
      positions,
      candidates,
      voterMap,
      rawVotes,
      duplicates,
      election: { title: first.title, type: first.type, start_date: first.start_date, end_date: first.end_date },
    };
  }

  // Default resolution: keep each double voter's earliest-cast ballot; voters
  // with a single ballot keep it automatically.
  function defaultResolutions(work) {
    const out = {};
    for (const d of work.duplicates) {
      if (!d.ballotFiles.length) continue;
      let minF = d.ballots[0].f, minT = d.ballots[0].ts;
      for (const { f, ts } of d.ballots) if (ts < minT) { minT = ts; minF = f; }
      out[d.vid] = minF;
    }
    return out;
  }

  function chosenFile(ent, resolutions) {
    const ballotFiles = [...ent.ballots.keys()];
    if (resolutions[ent.vid] === '_exclude') return null;
    if (ballotFiles.length === 0) return null;
    if (ballotFiles.length === 1) return ballotFiles[0];
    const res = resolutions[ent.vid];
    return (typeof res === 'number' && ballotFiles.includes(res)) ? res : ballotFiles[0];
  }

  // Raw tally: per-candidate counts + turnout numbers + kept ballots per file.
  function applyTally(work, resolutions) {
    const candVotes = new Map();
    let registered = 0, cast = 0, votesCast = 0;
    const keptByFile = new Map();

    for (const ent of work.voterMap.values()) {
      if (resolutions[ent.vid] === '_exclude') continue;
      registered++;
      if (ent.ballots.size && chosenFile(ent, resolutions) !== null) cast++;
    }

    for (const rv of work.rawVotes) {
      const ent = work.voterMap.get(rv.vid);
      if (rv.f === chosenFile(ent, resolutions)) {
        votesCast++;
        candVotes.set(rv.ckey, (candVotes.get(rv.ckey) || 0) + 1);
        keptByFile.set(rv.f, (keptByFile.get(rv.f) || 0) + 1);
      }
    }
    return { candVotes, registered, cast, votesCast, keptByFile };
  }

  // Full results report (mirrors results.buildReport shape so the shared
  // report markup in results.css can render it).
  function buildReport(work, resolutions) {
    const { candVotes, registered, cast, votesCast, keptByFile } = applyTally(work, resolutions);
    const totalVotes = votesCast;
    const categories = [];
    for (const p of work.positions) {
      const list = work.candidates
        .filter((c) => c.posKey === p.key)
        .map((c) => ({ key: c.key, name: c.name, votes: candVotes.get(c.key) || 0 }))
        .sort((a, b) => b.votes - a.votes);
      const catVotes = list.reduce((s, c) => s + c.votes, 0);
      categories.push({ name: p.title, votes: catVotes, candidates: list });
    }
    categories.sort((a, b) => b.votes - a.votes);

    for (const cat of categories) {
      for (const c of cat.candidates) {
        c.percentage = cat.votes > 0 ? Number(((c.votes / cat.votes) * 100).toFixed(1)) : 0;
        c.overallPct = totalVotes > 0 ? Number(((c.votes / totalVotes) * 100).toFixed(1)) : 0;
      }
    }

    const categoryWinners = categories.map((cat) => {
      const top = cat.candidates.filter((c) => c.votes > 0);
      if (!top.length) return { id: cat.name, name: cat.name, mode: 'none', votes: 0 };
      const leaders = top.filter((c) => c.votes === top[0].votes);
      if (leaders.length > 1) return { id: cat.name, name: cat.name, mode: 'tie', names: leaders.map((c) => c.name), votes: leaders[0].votes };
      return { id: cat.name, name: cat.name, mode: 'win', votes: leaders[0].votes, winner: leaders[0] };
    });

    const allCandidates = [];
    for (const cat of categories) for (const c of cat.candidates) allCandidates.push(c);
    allCandidates.sort((a, b) => b.votes - a.votes);
    let winner = null, tie = null;
    if (allCandidates.length && totalVotes > 0) {
      const top = allCandidates[0];
      const second = allCandidates[1];
      let topCat = '';
      for (const cat of categories) if (cat.candidates.indexOf(top) !== -1) topCat = cat.name;
      if (second && second.votes === top.votes) {
        tie = { name: `${top.name} & ${second.name}`, votes: top.votes };
      } else {
        winner = { id: top.key, name: top.name, votes: top.votes, percentage: top.overallPct, catName: topCat };
      }
    }

    const turnoutPct = registered > 0 ? Number(((cast / registered) * 100).toFixed(1)) : 0;
    return {
      ok: true,
      election: work.election,
      status: 'closed',
      effectivelyClosed: true,
      totalVotes,
      categories,
      winner,
      tie,
      categoryWinners,
      registered,
      cast,
      turnoutPct,
      keptByFile,
      stats: { votes: totalVotes, candidates: work.candidates.length, categories: categories.length },
      filesCount: work.files.length,
      duplicatesCount: work.duplicates.length,
      doubleCount: work.duplicates.filter((d) => d.dbl).length,
    };
  }

  // Merged JSON artifact for audit / future re-import.
  // `fileNames` — display names per file; `sourcesMeta` — optional per-file
  // { exported_at, title, type } used by the UI (files carry richer metadata).
  function buildSnapshotExport(work, resolutions, fileNames, sourcesMeta) {
    const report = buildReport(work, resolutions);
    const positionByName = new Map(work.positions.map((p) => [p.key, p.title]));
    const ballots = [];
    for (const rv of work.rawVotes) {
      const ent = work.voterMap.get(rv.vid);
      if (rv.f !== chosenFile(ent, resolutions)) continue;
      ballots.push({
        voter_id: rv.vid,
        file: fileNames ? fileNames[rv.f] : null,
        category: positionByName.get(rv.posKey),
        candidate: work.candidates.find((c) => c.key === rv.ckey).name,
        timestamp: rv.ts || null,
      });
    }
    return {
      schema: 'pulse-vote-hub-merged-election',
      schema_version: 1,
      merged_at: Date.now(),
      exporter: 'pulse-vote-hub-desktop',
      election: {
        title: work.election.title,
        type: work.election.type,
        start_date: work.election.start_date,
        end_date: work.election.end_date,
        status: 'closed',
      },
      sources: fileNames
        ? fileNames.map((file, f) => {
            const m = sourcesMeta && sourcesMeta[f];
            return {
              file,
              exported_at: (m && m.exported_at) || null,
              title: (m && m.title) || null,
              type: (m && m.type) || null,
            };
          })
        : [],
      positions: work.positions.map((p) => ({ title: p.title })),
      candidates: work.candidates.map((c) => ({ category: positionByName.get(c.posKey), candidate: c.name })),
      duplicates: work.duplicates.map((d) => ({
        voter_id: d.vid,
        name: d.name,
        is_double: d.dbl,
        registered_in: d.regFiles.map((f) => (fileNames ? fileNames[f] : null)),
        voted_in: d.ballotFiles.map((f) => (fileNames ? fileNames[f] : null)),
        resolution: null,
      })),
      counts: { registered: report.registered, cast: report.cast, votes: report.totalVotes },
      ballots,
    };
  }

  return { normKey, normVid, buildWork, defaultResolutions, buildReport, applicationTally: applyTally, buildSnapshotExport };
});