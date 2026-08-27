const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pvh', {
  platform: () => ipcRenderer.invoke('platform:info'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  dbInit: () => ipcRenderer.invoke('db:init'),
  dashboardStats: () => ipcRenderer.invoke('db:stats'),
  activeElections: () => ipcRenderer.invoke('db:active-elections'),

  listElections: () => ipcRenderer.invoke('election:list'),
  getElection: (id) => ipcRenderer.invoke('election:get', id),
  createElection: (p) => ipcRenderer.invoke('election:create', p),
  updateElection: (id, p) => ipcRenderer.invoke('election:update', id, p),
  setElectionStatus: (id, s) => ipcRenderer.invoke('election:status', id, s),
  publishElection: (id, opts) => ipcRenderer.invoke('election:publish', id, opts),
  applySchedule: () => ipcRenderer.invoke('election:apply-schedule'),
  deleteElection: (id) => ipcRenderer.invoke('election:delete', id),

  listPositions: (eid) => ipcRenderer.invoke('election:positions', eid),
  addPosition: (eid, title, max) => ipcRenderer.invoke('election:position-add', eid, title, max),
  removePosition: (id) => ipcRenderer.invoke('election:position-remove', id),

  listCandidates: (eid) => ipcRenderer.invoke('election:candidates', eid),
  listCandidatesByPosition: (pid) => ipcRenderer.invoke('election:candidates-by-position', pid),
  addCandidate: (p) => ipcRenderer.invoke('election:candidate-add', p),
  removeCandidate: (id) => ipcRenderer.invoke('election:candidate-remove', id),
  pickCandidatePhoto: () => ipcRenderer.invoke('candidate:pick-photo'),
  candidatePhotoUrl: (p) => ipcRenderer.invoke('candidate:photo-url', p),

  listVoters: (eid, opts) => ipcRenderer.invoke('voter:list', eid, opts),
  getVoter: (eid, vid) => ipcRenderer.invoke('voter:get', eid, vid),
  addVoter: (p) => ipcRenderer.invoke('voter:add', p),
  importVoters: (eid, csv) => ipcRenderer.invoke('voter:import', eid, csv),
  autoGenerateVoters: (eid, opts) => ipcRenderer.invoke('voter:autogen', eid, opts),
  deleteVoter: (eid, vid) => ipcRenderer.invoke('voter:delete', eid, vid),
  clearVoters: (eid) => ipcRenderer.invoke('voter:clear', eid),
  unvoteVoter: (eid, vid) => ipcRenderer.invoke('voter:unvote', eid, vid),
  verifyVoter: (eid, vid, pwd) => ipcRenderer.invoke('voter:verify', eid, vid, pwd),
  castVote: (eid, vid, sel) => ipcRenderer.invoke('voter:cast', eid, vid, sel),

  listStations: (eid) => ipcRenderer.invoke('station:list', eid),
  addStation: (p) => ipcRenderer.invoke('station:add', p),
  updateStation: (id, p) => ipcRenderer.invoke('station:update', id, p),
  removeStation: (id) => ipcRenderer.invoke('station:remove', id),
  openStationPolls: (id, opts) => ipcRenderer.invoke('station:open', id, opts),
  closeStationPolls: (id, opts) => ipcRenderer.invoke('station:close', id, opts),
  closeStationQueue: (id, opts) => ipcRenderer.invoke('station:close-queue-now', id, opts),
  submitStationPacket: (id, opts) => ipcRenderer.invoke('station:submit', id, opts),
  stationCheckin: (vid, opts) => ipcRenderer.invoke('station:checkin', vid, opts),
  stationBallotCast: (vid, opts) => ipcRenderer.invoke('station:ballot-cast', vid, opts),
  stationDashboard: (eid, sid) => ipcRenderer.invoke('station:dashboard', eid, sid),

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
  exportElection: (electionId) => ipcRenderer.invoke('backup:election', electionId),
});
