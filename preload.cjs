const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfigs: () => ipcRenderer.invoke('get-configs'),
  addConfig: (config) => ipcRenderer.invoke('add-config', config),
  updateConfig: (config) => ipcRenderer.invoke('update-config', config),
  deleteConfig: (id) => ipcRenderer.invoke('delete-config', id),
  toggleTunnel: (id, state) => ipcRenderer.invoke('toggle-tunnel', id, state),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  batchToggle: (ids, state) => ipcRenderer.invoke('batch-toggle', { ids, state }),
  batchDelete: (ids) => ipcRenderer.invoke('batch-delete', ids),
  onTunnelStatus: (callback) => ipcRenderer.on('tunnel-status', (event, data) => callback(data)),
  onConfigsUpdated: (callback) => ipcRenderer.on('configs-updated', (event, data) => callback(data)),
  onUptimesUpdated: (callback) => ipcRenderer.on('uptimes-updated', (event, data) => callback(data))
});