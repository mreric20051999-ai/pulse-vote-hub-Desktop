const { contextBridge, ipcRenderer } = require('electron');

// Resolve the signed-in session token from the renderer session and thread it
// through IPC. The token — NOT the officer id — is the identity credential: it
// is minted at login, unguessable, and expires, so the main process never
// trusts a caller-supplied officer id when deciding who is acting.
function sessionOfficerId() {
  try {
    const s = JSON.parse(window.localStorage.getItem('pvh_session') || 'null');
    return (s && s.token) || null;
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
  onSessionExpired: (cb) => {
    const listener = () => { try { cb(); } catch (e) { /* noop */ } };
    ipcRenderer.on('auth:session-expired', listener);
    return () => ipcRenderer.removeListener('auth:session-expired', listener);
  },

  dbInit: () => ipcRenderer.invoke('db:init'),
  dashboardStats: () => ipcRenderer.invoke('db:stats', oid()),
  activeElections: () => ipcRenderer.invoke('db:active-elections', oid()),

  listElections: () => ipcRenderer.invoke('election:list', oid()),
  getElection: (id) => ipcRenderer.invoke('election:get', id, oid()),
  createElection: (p) => ipcRenderer.invoke('election:create', p, oid()),
  updateElection: (id, p) => ipcRenderer.invoke('election:update', id, p, oid()),
  setElectionStatus: (id, s) => ipcRenderer.invoke('election:status', id, s, oid()),
  publishElection: (id, opts) => ipcRenderer.invoke('election:publish', id, opts, oid()),
  applySchedule: () => ipcRenderer.invoke('election:apply-schedule', oid()),
  deleteElection: (id, permanent) => ipcRenderer.invoke('election:delete', id, !!permanent, oid()),
  listDeletedElections: () => ipcRenderer.invoke('election:list-deleted', oid()),
  recoverElection: (id) => ipcRenderer.invoke('election:recover', id, oid()),
  purgeDeletedElection: (id) => ipcRenderer.invoke('election:purge-deleted', id, oid()),

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
  getVoter: (eid, vid) => ipcRenderer.invoke('voter:get', eid, vid, oid()),
  addVoter: (p) => ipcRenderer.invoke('voter:add', p, oid()),
  importVoters: (eid, csv) => ipcRenderer.invoke('voter:import', eid, csv, oid()),
  autoGenerateVoters: (eid, opts) => ipcRenderer.invoke('voter:autogen', eid, opts, oid()),
  deleteVoter: (eid, vid) => ipcRenderer.invoke('voter:delete', eid, vid, oid()),
  clearVoters: (eid) => ipcRenderer.invoke('voter:clear', eid, oid()),
  unvoteVoter: (eid, vid) => ipcRenderer.invoke('voter:unvote', eid, vid, oid()),
  verifyVoter: (eid, vid, pwd) => ipcRenderer.invoke('voter:verify', eid, vid, pwd),
  verifyVoterDetails: (eid, details) => ipcRenderer.invoke('voter:verify-details', eid, details),
  castVote: (eid, vid, sel, tkt, station) => ipcRenderer.invoke('voter:cast', eid, vid, sel, tkt, station),
  exportVoters: (eid, format) => ipcRenderer.invoke('voter:export', { electionId: eid, format }, oid()),
  exportVoterCredentials: (eid) => ipcRenderer.invoke('voter:export-credentials', { electionId: eid }, oid()),

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

  // Developer bootstrap (separate from the admin setup code)
  setupDeveloper: (payload) => ipcRenderer.invoke('auth:setup-developer', payload),
  developmentKeyStatus: () => ipcRenderer.invoke('dev:development-key-status', oid()),

  // Login audit log (developer-only)
  listLoginAudit: () => ipcRenderer.invoke('dev:list-login-audit', oid()),
  clearLoginAudit: () => ipcRenderer.invoke('dev:clear-login-audit', oid()),

  // Admin / superuser
  hasAdmin: () => ipcRenderer.invoke('auth:has-admin'),
  hasDeveloper: () => ipcRenderer.invoke('auth:has-developer'),
  canDeveloperBootstrap: () => ipcRenderer.invoke('auth:can-developer-bootstrap'),
  hasDeveloperKey: () => ipcRenderer.invoke('auth:has-dev-key'),
  hasSetupCode: () => ipcRenderer.invoke('auth:has-setup-code'),
  hasRecoveryCode: () => ipcRenderer.invoke('auth:has-recovery-code'),
  recoverPassword: (officerId, recoveryCode, newPassword) =>
    ipcRenderer.invoke('auth:recover-password', { officerId, recoveryCode, newPassword }),
  setupAdmin: (payload) => ipcRenderer.invoke('auth:setup-admin', payload),
  listOfficers: () => ipcRenderer.invoke('admin:officers', oid()),
  addOfficer: (payload) => ipcRenderer.invoke('admin:add-officer', payload, oid()),
  removeOfficer: (id, actingId) => ipcRenderer.invoke('admin:remove-officer', { id, actingId }, oid()),
  setOfficerSuspended: (id, suspended) => ipcRenderer.invoke('admin:set-suspended', { id, suspended }, oid()),
  changePassword: (id, newPassword) => ipcRenderer.invoke('admin:change-password', { id, newPassword }, oid()),
  assignStationOfficer: (officerId, stationId, electionId) => ipcRenderer.invoke('admin:assign-station', { officerId, stationId, electionId }, oid()),
  listSetupCodes: () => ipcRenderer.invoke('admin:list-codes', oid()),
  issueSetupCode: (privilege) => ipcRenderer.invoke('admin:issue-code', privilege, oid()),
  redeemSetupCode: (payload) => ipcRenderer.invoke('auth:redeem-code', payload),
  issueDeveloperCode: (name) => ipcRenderer.invoke('dev:issue-developer-code', name, oid()),
  listDeveloperCodes: () => ipcRenderer.invoke('dev:list-developer-codes', oid()),
  revokeDeveloperCode: (id) => ipcRenderer.invoke('dev:revoke-developer-code', id, oid()),
  redeemDeveloperCode: (payload) => ipcRenderer.invoke('auth:redeem-developer-code', payload),
  terminateApp: () => ipcRenderer.invoke('dev:terminate-app', oid()),

  // Software licensing (per-site activation codes)
  licenseStatus: () => ipcRenderer.invoke('lic:status'),
  activateLicense: (code) => ipcRenderer.invoke('lic:redeem', { code }),
  issueLicense: (siteName) => ipcRenderer.invoke('lic:issue', siteName, oid()),
  listLicenses: () => ipcRenderer.invoke('lic:list', oid()),
  revokeLicense: (id) => ipcRenderer.invoke('lic:revoke', id, oid()),
  getLicenseServerConfig: () => ipcRenderer.invoke('lic:server-config', oid()),
  setLicenseServerConfig: (payload) => ipcRenderer.invoke('lic:server-config-set', payload, oid()),
  mintDeveloperKey: () => ipcRenderer.invoke('lic:devkey', oid()),
  listDeployments: () => ipcRenderer.invoke('dist:list', oid()),
  addDeployment: (fields) => ipcRenderer.invoke('dist:add', fields, oid()),
  removeDeployment: (id) => ipcRenderer.invoke('dist:remove', id, oid()),
  thisComputer: (fields) => ipcRenderer.invoke('dist:this-computer', fields, oid()),
  githubReleases: () => ipcRenderer.invoke('dist:github', oid()),
  githubToken: () => ipcRenderer.invoke('dist:get-token', oid()),
  setGithubToken: (token) => ipcRenderer.invoke('dist:set-token', token, oid()),
  exportDeployments: () => ipcRenderer.invoke('dist:export-csv', oid()),

  // Backup / export (admin + developer data operations)
  backupDatabase: () => ipcRenderer.invoke('backup:database', oid()),
  exportElection: (electionId) => ipcRenderer.invoke('backup:election', electionId, oid()),

  // Automatic backup & restore
  backupAutoGet: () => ipcRenderer.invoke('backup:auto-get', oid()),
  backupAutoSave: (settings) => ipcRenderer.invoke('backup:auto-save', settings, oid()),
  backupAutoNow: () => ipcRenderer.invoke('backup:auto-now', oid()),
  backupAutoRestore: (filePath) => ipcRenderer.invoke('backup:auto-restore', filePath, oid()),
  backupAutoPickDir: () => ipcRenderer.invoke('backup:auto-pick-dir', oid()),

  // Restore the database from an arbitrary backup file (admin/developer)
  restoreDatabaseFromFile: () => ipcRenderer.invoke('backup:restore-file', oid()),
  // Import a previously-exported election snapshot JSON (developer)
  importElection: () => ipcRenderer.invoke('backup:election-import', oid()),

  // Multi-location runs ("Location Coordinator")
  listLocations: (electionId) => ipcRenderer.invoke('location:list', electionId, oid()),
  createRunPack: (opts) => ipcRenderer.invoke('location:create-run', opts, oid()),
  importRunPack: (opts) => ipcRenderer.invoke('location:import-run', opts, oid()),
  createResultPack: (electionId) => ipcRenderer.invoke('location:create-result', electionId, oid()),
  pickResultPacks: () => ipcRenderer.invoke('location:pick-result', oid()),
  compileResultPacks: (packs) => ipcRenderer.invoke('location:compile', { packs }, oid()),

  // Offline result-pack verification (distance hand-off)
  createPackReceipt: (electionId) => ipcRenderer.invoke('exchange:create-receipt', electionId, oid()),
  verifyPackReceipt: (receipt) => ipcRenderer.invoke('exchange:verify-receipt', { receipt }, oid()),
  listPackExchanges: (electionId) => ipcRenderer.invoke('exchange:list', electionId, oid()),
  listPackReceipts: (electionId) => ipcRenderer.invoke('exchange:receipts', electionId, oid()),

  // Over-the-internet sealed-pack relay
  sendPackOverInternet: (electionId, passphrase) => ipcRenderer.invoke('relay:send', electionId, passphrase, oid()),
  receivePackOverInternet: (code, passphrase) => ipcRenderer.invoke('relay:receive', { code, passphrase }, oid()),

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

  // LAN networking (controls require an admin/developer session)
  lanStatus: () => ipcRenderer.invoke('lan:status', oid()),
  lanSetMode: (mode, opts) => ipcRenderer.invoke('lan:set-mode', Object.assign({ mode }, opts || {}), oid()),
  lanStop: () => ipcRenderer.invoke('lan:stop', oid()),
  lanSetName: (name) => ipcRenderer.invoke('lan:set-name', name, oid()),
  lanSetSecret: (value) => ipcRenderer.invoke('lan:set-secret', value, oid()),
  lanDiscover: (ms) => ipcRenderer.invoke('lan:discover', ms, oid()),
  lanLocalAddresses: () => ipcRenderer.invoke('lan:local-addresses', oid()),
  onLanStatus: (cb) => {
    ipcRenderer.removeAllListeners('lan:status');
    ipcRenderer.on('lan:status', (_e, s) => cb(s));
    return () => ipcRenderer.removeAllListeners('lan:status');
  },
});
