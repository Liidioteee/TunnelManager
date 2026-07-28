const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfigs: () => ipcRenderer.invoke('get-configs'),
  addConfig: (data) => ipcRenderer.invoke('add-config', data),
  updateConfig: (data) => ipcRenderer.invoke('update-config', data),
  deleteConfig: (id) => ipcRenderer.invoke('delete-config', id),
  toggleTunnel: (id, state) => ipcRenderer.invoke('toggle-tunnel', id, state),
  onTunnelStatus: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('tunnel-status', subscription);
    return () => ipcRenderer.removeListener('tunnel-status', subscription);
  },
  onConfigsUpdated: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('configs-updated', subscription);
    return () => ipcRenderer.removeListener('configs-updated', subscription);
  }
});