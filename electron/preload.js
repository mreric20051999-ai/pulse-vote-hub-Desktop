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

  setupCheck: () => ipcRenderer.invoke('auth:setup-check'),
  setupCoordinator: (payload) => ipcRenderer.invoke('auth:setup', payload),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
});
