const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfigs: () => ipcRenderer.invoke('get-configs'),
  addConfig: (config) => ipcRenderer.invoke('add-config', config),
  updateConfig: (config) => ipcRenderer.invoke('update-config', config),
  deleteConfig: (id) => ipcRenderer.invoke('delete-config', id),
  toggleTunnel: (id, state) => ipcRenderer.invoke('toggle-tunnel', id, state),
  batchToggle: (ids, state) => ipcRenderer.invoke('batch-toggle', { ids, state }),
  batchDelete: (ids) => ipcRenderer.invoke('batch-delete', ids),

  // Логи
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),

  // Настройки
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Экспорт / Импорт
  exportConfigs: () => ipcRenderer.invoke('export-configs'),
  importConfigs: () => ipcRenderer.invoke('import-configs'),

  // Внешний браузер
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // QR-код (генерация в main-процессе, оффлайн)
  generateQr: (text) => ipcRenderer.invoke('generate-qrcode', text),

  // Слушатели событий
  onTunnelStatus: (callback) => ipcRenderer.on('tunnel-status', (event, data) => callback(data)),
  onConfigsUpdated: (callback) => ipcRenderer.on('configs-updated', (event, data) => callback(data)),
  onUptimesUpdated: (callback) => ipcRenderer.on('uptimes-updated', (event, data) => callback(data)),
  onRequestStats: (callback) => ipcRenderer.on('request-stats', (event, data) => callback(data))
});