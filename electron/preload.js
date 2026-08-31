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

// contextBridge exports a read-only `window.pvh`, which would shadow the pure
// fetch shim that kiosk-server.js installs on hub-served pages (/kiosk). So the
// Electron IPC bridge is exposed ONLY on the file:// portal; http:// hub pages
// get no bridge and the page-level shim takes over cleanly.
if (!window.location.host) contextBridge.exposeInMainWorld('pvh', {
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
  updatePositionMax: (id, max) => ipcRenderer.invoke('election:position-update-max', id, max, oid()),

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
  castVote: (eid, vid, sel, station) => ipcRenderer.invoke('voter:cast', eid, vid, sel, station),
  exportVoters: (eid, format) => ipcRenderer.invoke('voter:export', { electionId: eid, format }, oid()),

  listStations: (eid) => ipcRenderer.invoke('station:list', eid, oid()),
  addStation: (p) => ipcRenderer.invoke('station:add', p, oid()),
  updateStation: (id, p) => ipcRenderer.invoke('station:update', id, p, oid()),
  removeStation: (id) => ipcRenderer.invoke('station:remove', id, oid()),
  openStationPolls: (id, opts) => ipcRenderer.invoke('station:open', id, opts, oid()),
  closeStationPolls: (id, opts) => ipcRenderer.invoke('station:close', id, opts, oid()),
  closeStationQueue: (id, opts) => ipcRenderer.invoke('station:close-queue-now', id, opts, oid()),
  submitStationPacket: (id, opts) => ipcRenderer.invoke('station:submit', id, opts, oid()),
  stationCheckin: (vid, opts) => ipcRenderer.invoke('station:checkin', vid, opts, oid()),
  stationBallotCast: (vid, opts) => ipcRenderer.invoke('station:ballot-cast', vid, opts, oid()),
  stationDashboard: (eid, sid) => ipcRenderer.invoke('station:dashboard', eid, sid, oid()),
  createCheckinLink: (p) => ipcRenderer.invoke('station:create-checkin-link', p, oid()),
  listCheckinLinks: (eid) => ipcRenderer.invoke('station:list-checkin-links', eid, oid()),
  revokeCheckinLink: (p) => ipcRenderer.invoke('station:revoke-checkin-link', p, oid()),

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
  listDeployments: () => ipcRenderer.invoke('dist:list', oid()),
  addDeployment: (fields) => ipcRenderer.invoke('dist:add', fields, oid()),
  removeDeployment: (id) => ipcRenderer.invoke('dist:remove', id, oid()),
  thisComputer: (fields) => ipcRenderer.invoke('dist:this-computer', fields, oid()),
  githubReleases: () => ipcRenderer.invoke('dist:github', oid()),
  githubToken: () => ipcRenderer.invoke('dist:get-token', oid()),
  setGithubToken: (token) => ipcRenderer.invoke('dist:set-token', token, oid()),
  exportDeployments: () => ipcRenderer.invoke('dist:export-csv', oid()),

  // Backup / export
  backupDatabase: () => ipcRenderer.invoke('backup:database'),
  exportElection: (electionId) => ipcRenderer.invoke('backup:election', electionId, oid()),

  // Multi-location runs ("Location Coordinator")
  listLocations: (electionId) => ipcRenderer.invoke('location:list', electionId),
  createRunPack: (opts) => ipcRenderer.invoke('location:create-run', opts, oid()),
  importRunPack: (opts) => ipcRenderer.invoke('location:import-run', opts, oid()),
  createResultPack: (electionId) => ipcRenderer.invoke('location:create-result', electionId, oid()),
  pickResultPacks: () => ipcRenderer.invoke('location:pick-result', oid()),
  compileResultPacks: (packs) => ipcRenderer.invoke('location:compile', { packs }, oid()),

  // Multi-location merge
  pickMergeFiles: () => ipcRenderer.invoke('merge:pick-files'),
  exportJson: (content, defaultName) => ipcRenderer.invoke('merge:export-json', { content, defaultName }),

  // Integrity verification
  verifyIntegrity: () => ipcRenderer.invoke('integrity:verify'),

  // Kiosk lockdown
  kioskEnter: () => ipcRenderer.invoke('kiosk:enter'),
  kioskExit: () => ipcRenderer.invoke('kiosk:exit'),

  // In-app messaging ("Speak to admin")
  sendMessage: (body) => ipcRenderer.invoke('messages:send', body, oid()),
  replyMessage: (id, body) => ipcRenderer.invoke('messages:reply', id, body, oid()),
  listMessages: () => ipcRenderer.invoke('messages:list', oid()),
  myMessages: () => ipcRenderer.invoke('messages:mine', oid()),
  unreadMessages: () => ipcRenderer.invoke('messages:unread', oid()),
  unreadMine: () => ipcRenderer.invoke('messages:mine-unread', oid()),
  markMessageRead: (id) => ipcRenderer.invoke('messages:mark-read', id, oid()),
  markMineRead: () => ipcRenderer.invoke('messages:mark-mine-read', oid()),
  deleteMessage: (id) => ipcRenderer.invoke('messages:delete', id, oid()),
  clearMessages: () => ipcRenderer.invoke('messages:clear', oid()),

  // External link (web version)
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // LAN networking
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  lanSetMode: (mode, opts) => ipcRenderer.invoke('lan:set-mode', Object.assign({ mode }, opts || {})),
  lanStop: () => ipcRenderer.invoke('lan:stop'),
  lanSetName: (name) => ipcRenderer.invoke('lan:set-name', name),
  lanDiscover: (ms) => ipcRenderer.invoke('lan:discover', ms),
  lanLocalAddresses: () => ipcRenderer.invoke('lan:local-addresses'),
  onLanStatus: (cb) => {
    ipcRenderer.removeAllListeners('lan:status');
    ipcRenderer.on('lan:status', (_e, s) => cb(s));
    return () => ipcRenderer.removeAllListeners('lan:status');
  },
});
