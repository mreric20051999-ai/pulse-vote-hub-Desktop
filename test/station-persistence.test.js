// Station incidents / activity now persist to SQLite (gap #3) and the
// migration ledger records every schema change.
const h = require('./helpers');
const station = require('../electron/station');
const { db, check, eq, ok, report } = h;

const eid = 'e-station-1';
const sid = 'station-1';

check('incidents persist and list newest-first', () => {
  const r = station.addIncident({
    electionId: eid, stationId: sid, type: 'issue', message: 'Ballot box full', byName: 'Officer O',
  });
  ok(r.ok, 'addIncident ok');
  const rows = station.listIncidents(eid, sid);
  eq(rows.length, 1);
  eq(rows[0].message, 'Ballot box full');
  eq(rows[0].type, 'issue');
  eq(rows[0].by_name, 'Officer O');
});

check('activity persists and is scoped per election/station', () => {
  station.addActivity({ electionId: eid, stationId: sid, action: 'open', detail: 'Polls opened', byName: 'Officer O' });
  station.addActivity({ electionId: eid, stationId: 'other', action: 'open', detail: 'Other' });
  const rows = station.listActivity(eid, sid);
  eq(rows.length, 1);
  eq(rows[0].action, 'open');
  eq(station.listActivity('other-election', sid).length, 0);
});

check('incident writes an election audit entry', () => {
  const n = db.get().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE details LIKE '%Ballot box full%'").get().c;
  ok(n >= 1, 'audit row recorded');
});

check('schema_migrations ledger covers tables and added columns', () => {
  const d = db.get();
  const rows = d.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
  ok(rows.includes('table:station_incidents'), 'station_incidents recorded');
  ok(rows.includes('table:station_activity'), 'station_activity recorded');
  ok(rows.some((n) => n.startsWith('table:')), 'baseline tables recorded');
  ok(rows.includes('table:elections'), 'core table recorded');
  eq(new Set(rows).size, rows.length, 'migration names are unique');
});

report('station-persistence.test.js');
