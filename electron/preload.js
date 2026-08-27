const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pvh', {
  platform: () => ipcRenderer.invoke('platform:info'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  dbInit: () => ipcRenderer.invoke('db:init'),
  dashboardStats: () => ipcRenderer.invoke('db:stats'),

  setupCheck: () => ipcRenderer.invoke('auth:setup-check'),
  setupCoordinator: (payload) => ipcRenderer.invoke('auth:setup', payload),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
});
