const { contextBridge, ipcRenderer } = require('electron');

// Resolve the currently signed-in officer id from the renderer session and
// thread it through IPC so the main process can enforce ownership isolation.
function sessionOfficerId() {
  try {
    const s = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
    return (s && s.id) || null;
  } catch (err) {
    return null;
  }
}
const oid = () => sessionOfficerId();

contextBridge.exposeInMainWorld('pvh', {
  platform: () => ipcRenderer.invoke('platform:info'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  dbInit: () => ipcRenderer.invoke('db:init'),
  dashboardStats: () => ipcRenderer.invoke('db:stats', oid()),
  activeElections: () => ipcRenderer.invoke('db:active-elections', oid()),

  listElections: () => ipcRenderer.invoke('election:list', oid()),
  getElection: (id) => ipcRenderer.invoke('election:get', id, oid()),
  createElection: (p) => ipcRenderer.invoke('election:create', p, oid()),
  updateElection: (id, p) => ipcRenderer.invoke('election:update', id, p, oid()),
  setElectionStatus: (id, s) => ipcRenderer.invoke('election:status', id, s, oid()),
  publishElection: (id, opts) => ipcRenderer.invoke('election:publish', id, opts, oid()),
  applySchedule: () => ipcRenderer.invoke('election:apply-schedule'),
  deleteElection: (id) => ipcRenderer.invoke('election:delete', id, oid()),

  listPositions: (eid) => ipcRenderer.invoke('election:positions', eid, oid()),
  addPosition: (eid, title, max) => ipcRenderer.invoke('election:position-add', eid, title, max, oid()),
  removePosition: (id) => ipcRenderer.invoke('election:position-remove', id, oid()),

  listCandidates: (eid) => ipcRenderer.invoke('election:candidates', eid, oid()),
  listCandidatesByPosition: (pid) => ipcRenderer.invoke('election:candidates-by-position', pid, oid()),
  addCandidate: (p) => ipcRenderer.invoke('election:candidate-add', p, oid()),
  removeCandidate: (id) => ipcRenderer.invoke('election:candidate-remove', id, oid()),
  pickCandidatePhoto: () => ipcRenderer.invoke('candidate:pick-photo'),
  candidatePhotoUrl: (p) => ipcRenderer.invoke('candidate:photo-url', p),

  listVoters: (eid, opts) => ipcRenderer.invoke('voter:list', eid, opts, oid()),
  getVoter: (eid, vid) => ipcRenderer.invoke('voter:get', eid, vid),
  addVoter: (p) => ipcRenderer.invoke('voter:add', p, oid()),
  importVoters: (eid, csv) => ipcRenderer.invoke('voter:import', eid, csv, oid()),
  autoGenerateVoters: (eid, opts) => ipcRenderer.invoke('voter:autogen', eid, opts, oid()),
  deleteVoter: (eid, vid) => ipcRenderer.invoke('voter:delete', eid, vid, oid()),
  clearVoters: (eid) => ipcRenderer.invoke('voter:clear', eid, oid()),
  unvoteVoter: (eid, vid) => ipcRenderer.invoke('voter:unvote', eid, vid, oid()),
  verifyVoter: (eid, vid, pwd) => ipcRenderer.invoke('voter:verify', eid, vid, pwd),
  verifyVoterDetails: (eid, details) => ipcRenderer.invoke('voter:verify-details', eid, details),
  castVote: (eid, vid, sel) => ipcRenderer.invoke('voter:cast', eid, vid, sel),
  exportVoters: (eid, format) => ipcRenderer.invoke('voter:export', { electionId: eid, format }, oid()),

  listStations: (eid) => ipcRenderer.invoke('station:list', eid, oid()),
  addStation: (p) => ipcRenderer.invoke('station:add', p, oid()),
  updateStation: (id, p) => ipcRenderer.invoke('station:update', id, p, oid()),
  removeStation: (id) => ipcRenderer.invoke('station:remove', id, oid()),
  openStationPolls: (id, opts) => ipcRenderer.invoke('station:open', id, opts, oid()),
  closeStationPolls: (id, opts) => ipcRenderer.invoke('station:close', id, opts, oid()),
  closeStationQueue: (id, opts) => ipcRenderer.invoke('station:close-queue-now', id, opts),
  submitStationPacket: (id, opts) => ipcRenderer.invoke('station:submit', id, opts),
  stationCheckin: (vid, opts) => ipcRenderer.invoke('station:checkin', vid, opts),
  stationBallotCast: (vid, opts) => ipcRenderer.invoke('station:ballot-cast', vid, opts),
  stationDashboard: (eid, sid) => ipcRenderer.invoke('station:dashboard', eid, sid, oid()),

  // Results report
  resultsReport: (eid, stationId) => ipcRenderer.invoke('result:report', eid, oid(), stationId),
  exportFile: (content, defaultName, ext) => ipcRenderer.invoke('result:export-file', { content, defaultName, ext }),
  exportPdf: (html, defaultName) => ipcRenderer.invoke('result:export-pdf', { html, defaultName }),

  setupCheck: () => ipcRenderer.invoke('auth:setup-check'),
  setupCoordinator: (payload) => ipcRenderer.invoke('auth:setup', payload),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),

  // Admin / superuser
  hasAdmin: () => ipcRenderer.invoke('auth:has-admin'),
  setupAdmin: (payload) => ipcRenderer.invoke('auth:setup-admin', payload),
  listOfficers: () => ipcRenderer.invoke('admin:officers'),
  addOfficer: (payload) => ipcRenderer.invoke('admin:add-officer', payload),
  removeOfficer: (id, actingId) => ipcRenderer.invoke('admin:remove-officer', { id, actingId }),
  setOfficerSuspended: (id, suspended) => ipcRenderer.invoke('admin:set-suspended', { id, suspended }),
  changePassword: (id, newPassword) => ipcRenderer.invoke('admin:change-password', { id, newPassword }),
  assignStationOfficer: (officerId, stationId, electionId) => ipcRenderer.invoke('admin:assign-station', { officerId, stationId, electionId }),

  // Backup / export
  backupDatabase: () => ipcRenderer.invoke('backup:database'),
  exportElection: (electionId) => ipcRenderer.invoke('backup:election', electionId, oid()),

  // Multi-location merge
  pickMergeFiles: () => ipcRenderer.invoke('merge:pick-files'),
  exportJson: (content, defaultName) => ipcRenderer.invoke('merge:export-json', { content, defaultName }),
});
