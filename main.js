import { app, BrowserWindow, Tray, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';
import dns from 'dns';
import net from 'net';
import Tunnel from './lib/Tunnel.js';
import CFTunnel from './lib/CFTunnel.js';
import logger from './lib/Logger.js';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotTheLock = app.requestSingleInstanceLock();

let mainWindow;
let tray = null;
const activeTunnels = {};
const startingTunnels = new Set(); 
const tunnelStates = {};

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

  function computeStatus(configId, isActiveInStore) {
    if (!isActiveInStore) {
      return { type: 'info', message: 'Не активен' };
    }

    const state = tunnelStates[configId];
    if (!state) {
      return { type: 'info', message: 'Запуск...' };
    }

    if (state.connectionState === 'error') {
      return { type: 'error', message: state.connectionMessage || 'Ошибка сети' };
    }

    if (state.connectionState === 'starting') {
      return { type: 'info', message: state.connectionMessage || 'Запуск...' };
    }

    if (state.connectionState === 'connected') {
      if (state.localPortState === 'closed') {
        const config = store.get('configs').find(c => c.id === configId);
        const port = config ? config.port : '';
        return { type: 'warning', message: `Локальный порт ${port} недоступен` };
      }
      return { type: 'success', message: 'Активен' };
    }

    return { type: 'info', message: 'Запуск...' };
  }

  function getConfigsWithStatuses() {
    const configs = store.get('configs');
    return configs.map(c => {
      const status = computeStatus(c.id, c.active);
      return { ...c, status };
    });
  }

  function broadcastStatus(configId) {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      const config = store.get('configs').find(c => c.id === configId);
      const isActive = config ? config.active : false;
      const status = computeStatus(configId, isActive);
      mainWindow.webContents.send('tunnel-status', { id: configId, status });
    }
  }

  function checkLocalPort(port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
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

    tunnelStates[configId] = {
      connectionState: 'starting',
      connectionMessage: 'Запуск...',
      localPortState: 'unknown'
    };
    broadcastStatus(configId);

    const provider = config.provider || 'lt';
    let tunnel;

    if (provider === 'cf') {
      tunnel = new CFTunnel({
        port: parseInt(config.port)
      });
    } else {
      tunnel = new Tunnel({
        port: parseInt(config.port),
        subdomain: config.subdomain || undefined
      });
    }

    activeTunnels[configId] = tunnel;

    tunnel.on('status', async (status) => {
      const state = tunnelStates[configId];
      if (!state) return;

      if (status.type === 'success') {
        state.connectionState = 'connected';
        state.connectionMessage = status.message;
        const isPortOpen = await checkLocalPort(parseInt(config.port));
        state.localPortState = isPortOpen ? 'open' : 'closed';
      } else if (status.type === 'error') {
        state.connectionState = 'error';
        state.connectionMessage = status.message;
      } else if (status.type === 'warning') {
        if (status.message.includes('Локальный порт')) {
          state.connectionState = 'connected';
          state.localPortState = 'closed';
        } else {
          state.connectionState = 'starting';
          state.connectionMessage = status.message;
        }
      } else {
        state.connectionState = 'starting';
        state.connectionMessage = status.message;
      }

      broadcastStatus(configId);
    });

    try {
      await new Promise((resolve, reject) => {
        tunnel.open(err => {
          if (err) reject(err);
          else resolve();
        });
      });

      tunnel.startTime = Date.now();

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
        
        tunnelStates[configId] = {
          connectionState: 'error',
          connectionMessage: `Ошибка: ${err.message}`,
          localPortState: 'unknown'
        };
        broadcastStatus(configId);

        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
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
        logger.error(`Ошибка при остановке туннеля ${configId}: ${err.message}`);
      }
    }
    
    tunnelStates[configId] = {
      connectionState: 'stopped',
      connectionMessage: 'Не активен',
      localPortState: 'unknown'
    };
    broadcastStatus(configId);

    const configs = store.get('configs');
    const config = configs.find(c => c.id === configId);
    if (config) {
      config.active = false;
      config.url = '';
      store.set('configs', configs);
    }
  }

  app.whenReady().then(() => {
    logger.info('Приложение запущено и готово к работе');
    createWindow();
    createTray();
    setupAutoLaunch();

    const configs = store.get('configs');
    configs.forEach(config => {
      if (config.active) {
        startTunnel(config.id).catch(err => logger.error(`Ошибка автозапуска туннеля ${config.id}: ${err.message}`));
      }
    });

    setInterval(() => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
      const uptimes = {};
      for (const [id, tunnel] of Object.entries(activeTunnels)) {
        if (tunnel && tunnel.startTime) {
          uptimes[id] = Math.floor((Date.now() - tunnel.startTime) / 1000);
        }
      }
      mainWindow.webContents.send('uptimes-updated', uptimes);
    }, 1000);

    setInterval(async () => {
      const configs = store.get('configs');
      let updated = false;

      for (const config of configs) {
        const tunnelInstance = activeTunnels[config.id];
        const state = tunnelStates[config.id];
        
        if (tunnelInstance && tunnelInstance.startTime && state && state.connectionState === 'connected') {
          const isPortOpen = await checkLocalPort(parseInt(config.port));
          const newState = isPortOpen ? 'open' : 'closed';
          
          if (state.localPortState !== newState) {
            state.localPortState = newState;
            updated = true;
            broadcastStatus(config.id);
          }
        }
      }

      if (updated && mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('configs-updated', getConfigsWithStatuses());
      }
    }, 3000);
  });

  ipcMain.handle('get-configs', () => getConfigsWithStatuses());

  ipcMain.handle('add-config', (event, { name, port, subdomain, provider }) => {
    const configs = store.get('configs');
    const newConfig = {
      id: Date.now().toString(),
      name: name.trim() || `Порт ${port}`,
      port,
      subdomain: subdomain ? subdomain.trim() : '',
      provider: provider || 'lt',
      active: false,
      url: ''
    };
    configs.push(newConfig);
    store.set('configs', configs);
    logger.info(`Создана конфигурация: ${newConfig.name} (${provider || 'lt'})`);
    return getConfigsWithStatuses();
  });

  ipcMain.handle('update-config', (event, { id, name, port, subdomain, provider }) => {
    stopTunnel(id);
    const configs = store.get('configs');
    const config = configs.find(c => c.id === id);
    if (config) {
      config.name = name.trim() || `Порт ${port}`;
      config.port = port;
      config.subdomain = subdomain ? subdomain.trim() : '';
      config.provider = provider || 'lt';
      config.active = false; 
      config.url = '';
      store.set('configs', configs);
      logger.info(`Конфигурация ${id} успешно обновлена: ${config.name}`);
    }
    return getConfigsWithStatuses();
  });

  ipcMain.handle('delete-config', (event, id) => {
    stopTunnel(id);
    let configs = store.get('configs');
    configs = configs.filter(c => c.id !== id);
    store.set('configs', configs);
    logger.info(`Конфигурация ${id} удалена`);
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
      startTunnel(id).catch(err => logger.error(`Ошибка активации туннеля ${id}: ${err.message}`));
    } else {
      stopTunnel(id);
    }
    return getConfigsWithStatuses();
  });

  ipcMain.handle('open-log-folder', () => {
    logger.openFolder();
  });

  ipcMain.handle('batch-toggle', async (event, { ids, state }) => {
    logger.info(`Пакетное переключение состояния (${state ? 'Вкл' : 'Выкл'}) для: ${ids.join(', ')}`);
    const configs = store.get('configs');
    
    for (const id of ids) {
      const config = configs.find(c => c.id === id);
      if (config) {
        config.active = state;
        if (!state) {
          config.url = '';
        }
      }
    }
    store.set('configs', configs);

    for (const id of ids) {
      if (state) {
        startTunnel(id).catch(err => logger.error(`Ошибка запуска в пакете ${id}: ${err.message}`));
      } else {
        stopTunnel(id);
      }
    }

    return getConfigsWithStatuses();
  });

  ipcMain.handle('batch-delete', (event, ids) => {
    logger.info(`Пакетное удаление конфигураций: ${ids.join(', ')}`);
    for (const id of ids) {
      stopTunnel(id);
    }
    let configs = store.get('configs');
    configs = configs.filter(c => !ids.includes(c.id));
    store.set('configs', configs);
    return getConfigsWithStatuses();
  });
}