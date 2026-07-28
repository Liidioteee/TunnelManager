import { app, BrowserWindow, Tray, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import dns from 'dns';
import Tunnel from './lib/Tunnel.js';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotTheLock = app.requestSingleInstanceLock();

let mainWindow;
let tray = null;
const activeTunnels = {};
const startingTunnels = new Set(); 
const tunnelStatuses = {};

if (!gotTheLock) {
  app.quit();
} else {
  const store = new Store();

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  if (!store.has('configs')) {
    store.set('configs', []);
  }

  function getConfigsWithStatuses() {
    const configs = store.get('configs');
    return configs.map(c => {
      const status = tunnelStatuses[c.id] || (c.active 
        ? { type: 'success', message: 'Активен' } 
        : { type: 'info', message: 'Не активен' }
      );
      return { ...c, status };
    });
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 600,
      height: 700,
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
      if (!app.isQuiting) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Открыть настройки', click: () => mainWindow.show() },
      { label: 'Выход', click: () => {
          app.isQuiting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip('LocalTunnel Manager');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow.show());
  }

  function setupAutoLaunch() {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true
    });
  }

  async function startTunnel(configId) {
    if (activeTunnels[configId] || startingTunnels.has(configId)) {
      return;
    }

    const configs = store.get('configs');
    const config = configs.find(c => c.id === configId);
    if (!config) return;

    startingTunnels.add(configId);

    const tunnel = new Tunnel({
      port: parseInt(config.port),
      subdomain: config.subdomain || undefined
    });

    activeTunnels[configId] = tunnel;

    tunnel.on('status', (status) => {
      tunnelStatuses[configId] = status;
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('tunnel-status', { id: configId, status });
      }
    });

    try {
      await new Promise((resolve, reject) => {
        tunnel.open(err => {
          if (err) reject(err);
          else resolve();
        });
      });

      const currentConfigs = store.get('configs');
      const currentConfig = currentConfigs.find(c => c.id === configId);
      if (currentConfig) {
        currentConfig.url = tunnel.url;
        currentConfig.active = true;
        store.set('configs', currentConfigs);
      }
      
      tunnel.on('close', () => stopTunnel(configId));

      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('configs-updated', getConfigsWithStatuses());
      }
      
      return tunnel.url;
    } catch (err) {
      if (!tunnel.closed) {
        const currentConfigs = store.get('configs');
        const currentConfig = currentConfigs.find(c => c.id === configId);
        if (currentConfig) {
          currentConfig.active = false;
          currentConfig.url = '';
          store.set('configs', currentConfigs);
        }
        delete activeTunnels[configId];
        
        tunnelStatuses[configId] = { type: 'error', message: `Ошибка: ${err.message}` };
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('tunnel-status', { id: configId, status: tunnelStatuses[configId] });
          mainWindow.webContents.send('configs-updated', getConfigsWithStatuses());
        }
        throw err;
      }
    } finally {
      startingTunnels.delete(configId);
    }
  }

  function stopTunnel(configId) {
    const tunnel = activeTunnels[configId];
    if (tunnel) {
      delete activeTunnels[configId]; 
      try {
        tunnel.close(); 
      } catch (err) {
        console.error('Ошибка при закрытии туннеля:', err);
      }
    }
    
    tunnelStatuses[configId] = { type: 'info', message: 'Не активен' };
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('tunnel-status', { id: configId, status: tunnelStatuses[configId] });
    }

    const configs = store.get('configs');
    const config = configs.find(c => c.id === configId);
    if (config) {
      config.active = false;
      config.url = '';
      store.set('configs', configs);
    }
  }

  app.whenReady().then(() => {
    createWindow();
    createTray();
    setupAutoLaunch();

    const configs = store.get('configs');
    configs.forEach(config => {
      if (config.active) {
        startTunnel(config.id).catch(console.error);
      }
    });
  });

  ipcMain.handle('get-configs', () => getConfigsWithStatuses());

  ipcMain.handle('add-config', (event, { name, port, subdomain }) => {
    const configs = store.get('configs');
    const newConfig = {
      id: Date.now().toString(),
      name: name.trim() || `Порт ${port}`,
      port,
      subdomain: subdomain.trim(),
      active: false,
      url: ''
    };
    configs.push(newConfig);
    store.set('configs', configs);
    return getConfigsWithStatuses();
  });

  ipcMain.handle('update-config', (event, { id, name, port, subdomain }) => {
    stopTunnel(id);
    const configs = store.get('configs');
    const config = configs.find(c => c.id === id);
    if (config) {
      config.name = name.trim() || `Порт ${port}`;
      config.port = port;
      config.subdomain = subdomain.trim();
      config.active = false; 
      config.url = '';
      store.set('configs', configs);
    }
    return getConfigsWithStatuses();
  });

  ipcMain.handle('delete-config', (event, id) => {
    stopTunnel(id);
    let configs = store.get('configs');
    configs = configs.filter(c => c.id !== id);
    store.set('configs', configs);
    return getConfigsWithStatuses();
  });

  ipcMain.handle('toggle-tunnel', async (event, id, state) => {
    const configs = store.get('configs');
    const config = configs.find(c => c.id === id);
    if (config) {
      config.active = state;
      if (!state) {
        config.url = '';
      }
      store.set('configs', configs);
    }

    if (state) {
      startTunnel(id).catch(console.error);
    } else {
      stopTunnel(id);
    }
    return getConfigsWithStatuses();
  });
}