const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pvh', {
  platform: () => ipcRenderer.invoke('platform:info'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  dbInit: () => ipcRenderer.invoke('db:init'),
  dashboardStats: () => ipcRenderer.invoke('db:stats'),

  listElections: () => ipcRenderer.invoke('election:list'),
  getElection: (id) => ipcRenderer.invoke('election:get', id),
  createElection: (p) => ipcRenderer.invoke('election:create', p),
  updateElection: (id, p) => ipcRenderer.invoke('election:update', id, p),
  setElectionStatus: (id, s) => ipcRenderer.invoke('election:status', id, s),
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

  setupCheck: () => ipcRenderer.invoke('auth:setup-check'),
  setupCoordinator: (payload) => ipcRenderer.invoke('auth:setup', payload),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
});
