const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfigs: () => ipcRenderer.invoke('get-configs'),
  addConfig: (data) => ipcRenderer.invoke('add-config', data),
  updateConfig: (data) => ipcRenderer.invoke('update-config', data), // Новый метод!
  deleteConfig: (id) => ipcRenderer.invoke('delete-config', id),
  toggleTunnel: (id, state) => ipcRenderer.invoke('toggle-tunnel', id, state)
});