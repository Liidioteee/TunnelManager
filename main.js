import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import Store from 'electron-store';
import QRCode from 'qrcode';
import dns from 'dns';
import net from 'net';
import Tunnel from './lib/Tunnel.js';
import CFTunnel from './lib/CFTunnel.js';
import logger from './lib/Logger.js';
import { sanitizeConfigInput } from './lib/configValidation.js';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_INDEX_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;

const gotTheLock = app.requestSingleInstanceLock();

let mainWindow;
let tray = null;
let isQuitting = false;
const activeTunnels = {};
const startingTunnels = new Set();
const tunnelStates = {};
const requestStats = {};

if (!gotTheLock) {
  app.quit();
} else {
  logger.configure({
    logDir: path.join(app.getPath('userData'), 'logs'),
    openPath: (dir) => shell.openPath(dir)
  });

  const store = new Store();

  if (!store.has('configs')) {
    store.set('configs', []);
  }

  const defaultSettings = {
    autoLaunch: false,
    startMinimized: false,
    closeToTray: true,
    defaultProvider: 'lt',
    notifications: true
  };

  if (!store.has('settings')) {
    store.set('settings', defaultSettings);
  }

  function getSettings() {
    return { ...defaultSettings, ...(store.get('settings') || {}) };
  }

  function applyAutoLaunch(settings) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!settings.autoLaunch,
        openAsHidden: !!settings.startMinimized
      });
    } catch (err) {
      logger.error(`Ошибка применения настроек автозапуска: ${err.message}`);
    }
  }

  function showNotification(title, body) {
    const settings = getSettings();
    if (settings.notifications && Notification.isSupported()) {
      try {
        new Notification({
          title,
          body,
          icon: path.join(__dirname, 'icon.png')
        }).show();
      } catch (err) {
        logger.warn(`Ошибка показа уведомления: ${err.message}`);
      }
    }
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

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
    const configs = store.get('configs') || [];
    return configs.map(c => {
      const status = computeStatus(c.id, c.active);
      return {
        ...c,
        status,
        stats: requestStats[c.id] || { count: 0, lastMethod: '', lastPath: '', lastTime: null }
      };
    });
  }

  function broadcastStatus(configId) {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      const config = (store.get('configs') || []).find(c => c.id === configId);
      const isActive = config ? config.active : false;
      const status = computeStatus(configId, isActive);
      mainWindow.webContents.send('tunnel-status', { id: configId, status });
    }
  }

  function broadcastConfigs() {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('configs-updated', getConfigsWithStatuses());
    }
  }

  function checkLocalPort(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(600);
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
      socket.connect(port, host === 'localhost' ? '127.0.0.1' : host);
    });
  }

  function handleTunnelRequest(configId, req) {
    if (!requestStats[configId]) {
      requestStats[configId] = { count: 0, lastMethod: '', lastPath: '', lastTime: null };
    }
    requestStats[configId].count++;

    // Данные приходят из строк внешних HTTP-запросов — оставляем только
    // известный метод и путь без query string (там могут быть токены)
    const rawMethod = String((req && req.method) || '').toUpperCase();
    requestStats[configId].lastMethod = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(rawMethod) ? rawMethod : 'REQ';
    requestStats[configId].lastPath = String((req && req.path) || '/').split('?')[0].slice(0, 120);
    requestStats[configId].lastTime = Date.now();

    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('request-stats', {
        id: configId,
        stats: requestStats[configId]
      });
    }
  }

  function createWindow() {
    const settings = getSettings();
    mainWindow = new BrowserWindow({
      width: 620,
      height: 740,
      minWidth: 480,
      minHeight: 500,
      icon: path.join(__dirname, 'icon.png'),
      show: !settings.startMinimized,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.loadFile('index.html');

    // Все window.open / target="_blank" отдаём системному браузеру,
    // новые Electron-окна с нашим preload не открываются
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const u = String(url || '');
      if (/^https?:\/\//i.test(u)) {
        shell.openExternal(u);
      }
      return { action: 'deny' };
    });

    // Блокируем любую навигацию рендерера, кроме собственного index.html —
    // разрешать произвольные file:// небезопасно (доступ к чужим локальным файлам)
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (String(url || '') !== APP_INDEX_URL) {
        event.preventDefault();
      }
    });

    mainWindow.on('close', (event) => {
      const currentSettings = getSettings();
      if (!isQuitting && currentSettings.closeToTray) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Открыть Tunnel Manager', click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      { label: 'Остановить все туннели', click: () => {
          const configs = store.get('configs') || [];
          configs.forEach(c => { if (c.active) stopTunnel(c.id); });
        }
      },
      { type: 'separator' },
      { label: 'Выход', click: () => {
          isQuitting = true;
          stopAllTunnels();
          app.quit();
        }
      }
    ]);
    tray.setToolTip('Tunnel Manager');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  async function startTunnel(configId) {
    if (activeTunnels[configId] || startingTunnels.has(configId)) {
      return;
    }

    const configs = store.get('configs') || [];
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
    const localHost = config.localHost || 'localhost';
    const localProtocol = config.localProtocol || 'http';
    let tunnel;

    if (provider === 'cf') {
      tunnel = new CFTunnel({
        binDir: app.getPath('userData'),
        port: parseInt(config.port, 10),
        localHost,
        localProtocol,
        skipTlsVerify: config.skipTlsVerify !== false
      });
    } else {
      tunnel = new Tunnel({
        port: parseInt(config.port, 10),
        subdomain: config.subdomain || undefined,
        local_host: localHost,
        local_https: localProtocol === 'https',
        allow_invalid_cert: config.skipTlsVerify !== false
      });
    }

    activeTunnels[configId] = tunnel;

    tunnel.on('request', (req) => {
      handleTunnelRequest(configId, req);
    });

    // Без обработчика событие 'error' у EventEmitter выбрасывает исключение
    // и роняет main-процесс. Статус ошибки туннель отправляет через 'status'.
    tunnel.on('error', (err) => {
      logger.error(`Ошибка туннеля ${configId}: ${err.message}`);
    });

    tunnel.on('status', async (status) => {
      const state = tunnelStates[configId];
      if (!state) return;

      if (status.type === 'success') {
        state.connectionState = 'connected';
        state.connectionMessage = status.message;
        const isPortOpen = await checkLocalPort(parseInt(config.port, 10), localHost);
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

      const currentConfigs = store.get('configs') || [];
      const currentConfig = currentConfigs.find(c => c.id === configId);
      if (currentConfig) {
        currentConfig.url = tunnel.url;
        currentConfig.active = true;
        store.set('configs', currentConfigs);
      }

      tunnel.on('close', () => {
        stopTunnel(configId);
      });

      // После переподключения localtunnel может выдать другой адрес
      // (если субдомен не закреплён) — обновляем сохранённую ссылку
      tunnel.on('reconnected', (url) => {
        if (activeTunnels[configId] !== tunnel || !url) return;
        const configsNow = store.get('configs') || [];
        const configNow = configsNow.find(c => c.id === configId);
        if (configNow && configNow.url !== url) {
          configNow.url = url;
          store.set('configs', configsNow);
          logger.info(`Туннель ${configId} переподключён с новым адресом: ${url}`);
          broadcastConfigs();
        }
      });

      showNotification('Туннель запущен', `${config.name}: ${tunnel.url}`);
      broadcastConfigs();
      return tunnel.url;
    } catch (err) {
      delete activeTunnels[configId];

      // Сбрасываем сохранённое состояние, даже если туннель был закрыт
      // принудительно (иначе config.active мог остаться true до перезапуска)
      const currentConfigs = store.get('configs') || [];
      const currentConfig = currentConfigs.find(c => c.id === configId);
      if (currentConfig) {
        currentConfig.active = false;
        currentConfig.url = '';
        store.set('configs', currentConfigs);
      }

      if (tunnel.closed) {
        // Запуск отменён (пользователь остановил туннель во время старта) —
        // stopTunnel уже выставил состояние, повторная ошибка не нужна
        if (!tunnelStates[configId] || tunnelStates[configId].connectionState !== 'stopped') {
          tunnelStates[configId] = {
            connectionState: 'stopped',
            connectionMessage: 'Не активен',
            localPortState: 'unknown'
          };
        }
        broadcastStatus(configId);
        broadcastConfigs();
        logger.warn(`Запуск туннеля ${configId} отменён до завершения`);
        return;
      }

      tunnelStates[configId] = {
        connectionState: 'error',
        connectionMessage: `Ошибка: ${err.message}`,
        localPortState: 'unknown'
      };
      broadcastStatus(configId);
      broadcastConfigs();
      throw err;
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

    const configs = store.get('configs') || [];
    const config = configs.find(c => c.id === configId);
    if (config) {
      config.active = false;
      config.url = '';
      store.set('configs', configs);
    }
    broadcastConfigs();
  }

  function stopAllTunnels() {
    for (const id of Object.keys(activeTunnels)) {
      try {
        stopTunnel(id);
      } catch (err) {
        logger.error(`Ошибка при остановке туннеля ${id} (stopAllTunnels): ${err.message}`);
      }
    }
  }

  app.on('before-quit', () => {
    isQuitting = true;
    stopAllTunnels();
  });

  app.on('will-quit', () => {
    stopAllTunnels();
  });

  app.whenReady().then(() => {
    logger.info('Приложение запущено и готово к работе');
    const settings = getSettings();
    applyAutoLaunch(settings);
    createWindow();
    createTray();

    const configs = store.get('configs') || [];
    configs.forEach(config => {
      if (config.active) {
        startTunnel(config.id).catch(err => logger.error(`Ошибка автозапуска туннеля ${config.id}: ${err.message}`));
      }
    });

    // Периодическое обновление времени работы
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

    // Параллельная неблокирующая проверка доступности локальных портов
    setInterval(async () => {
      const currentConfigs = store.get('configs') || [];
      const connectedConfigs = currentConfigs.filter(config => {
        const tunnelInstance = activeTunnels[config.id];
        const state = tunnelStates[config.id];
        return tunnelInstance && tunnelInstance.startTime && state && state.connectionState === 'connected';
      });

      if (connectedConfigs.length === 0) return;

      let hasChanges = false;
      await Promise.allSettled(connectedConfigs.map(async (config) => {
        const isPortOpen = await checkLocalPort(parseInt(config.port, 10), config.localHost || 'localhost');
        const newState = isPortOpen ? 'open' : 'closed';
        const state = tunnelStates[config.id];
        if (state && state.localPortState !== newState) {
          state.localPortState = newState;
          hasChanges = true;
          broadcastStatus(config.id);
        }
      }));

      if (hasChanges) {
        broadcastConfigs();
      }
    }, 3000);
  });

  // --- IPC ОБРАБОТЧИКИ ---

  ipcMain.handle('get-configs', () => getConfigsWithStatuses());

  ipcMain.handle('add-config', (event, rawConfig) => {
    const safe = sanitizeConfigInput(rawConfig);
    if (!safe) {
      throw new Error('Некорректные параметры конфигурации (порт, хост или протокол)');
    }

    const configs = store.get('configs') || [];
    const newConfig = {
      id: `${Date.now()}-${crypto.randomUUID()}`,
      ...safe,
      active: false,
      url: '',
      createdAt: Date.now()
    };
    configs.push(newConfig);
    store.set('configs', configs);
    logger.info(`Создана конфигурация: ${newConfig.name} (${newConfig.provider})`);
    return getConfigsWithStatuses();
  });

  ipcMain.handle('update-config', (event, rawConfig) => {
    if (!rawConfig || !rawConfig.id) {
      throw new Error('Некорректный запрос на обновление');
    }

    const safe = sanitizeConfigInput(rawConfig);
    if (!safe) {
      throw new Error('Некорректные параметры конфигурации (порт, хост или протокол)');
    }

    stopTunnel(rawConfig.id);
    const configs = store.get('configs') || [];
    const config = configs.find(c => c.id === rawConfig.id);
    if (config) {
      Object.assign(config, safe, { active: false, url: '' });
      store.set('configs', configs);
      logger.info(`Конфигурация ${rawConfig.id} обновлена: ${config.name}`);
    }
    return getConfigsWithStatuses();
  });

  ipcMain.handle('delete-config', (event, id) => {
    stopTunnel(id);
    delete requestStats[id];
    delete tunnelStates[id];
    let configs = store.get('configs') || [];
    configs = configs.filter(c => c.id !== id);
    store.set('configs', configs);
    logger.info(`Конфигурация ${id} удалена`);
    return getConfigsWithStatuses();
  });

  ipcMain.handle('toggle-tunnel', async (event, id, state) => {
    const configs = store.get('configs') || [];
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

  ipcMain.handle('batch-toggle', async (event, { ids, state }) => {
    logger.info(`Пакетное переключение состояния (${state ? 'Вкл' : 'Выкл'}) для: ${ids.join(', ')}`);
    const configs = store.get('configs') || [];

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
      delete requestStats[id];
      delete tunnelStates[id];
    }
    let configs = store.get('configs') || [];
    configs = configs.filter(c => !ids.includes(c.id));
    store.set('configs', configs);
    return getConfigsWithStatuses();
  });

  // Логи
  ipcMain.handle('get-logs', () => logger.getRecentLogs());
  ipcMain.handle('clear-logs', () => {
    logger.clearRecentLogs();
    return [];
  });
  ipcMain.handle('open-log-folder', () => logger.openFolder());

  // Настройки
  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', (event, newSettings) => {
    const updated = { ...getSettings(), ...newSettings };
    store.set('settings', updated);
    applyAutoLaunch(updated);
    logger.info('Настройки приложения обновлены');
    return updated;
  });

  // Экспорт / Импорт конфигураций
  ipcMain.handle('export-configs', async () => {
    const configs = store.get('configs') || [];
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт конфигураций туннелей',
      defaultPath: `tunnel-manager-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (canceled || !filePath) return { success: false };

    try {
      const data = {
        version: '1.1.0',
        exportedAt: new Date().toISOString(),
        configs: configs.map(c => ({
          name: c.name,
          port: c.port,
          subdomain: c.subdomain,
          provider: c.provider,
          localHost: c.localHost,
          localProtocol: c.localProtocol,
          skipTlsVerify: c.skipTlsVerify !== false
        }))
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`Конфигурации экспортированы в ${filePath}`);
      return { success: true, count: configs.length };
    } catch (err) {
      logger.error(`Ошибка экспорта: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('import-configs', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
      title: 'Импорт конфигураций туннелей',
      properties: ['openFile'],
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (canceled || !filePaths || filePaths.length === 0) return { success: false };

    try {
      const rawData = fs.readFileSync(filePaths[0], 'utf8');
      const parsed = JSON.parse(rawData);
      const incomingList = Array.isArray(parsed) ? parsed : (parsed.configs || []);

      if (!Array.isArray(incomingList) || incomingList.length === 0) {
        return { success: false, error: 'Файл не содержит корректных конфигураций' };
      }

      const currentConfigs = store.get('configs') || [];
      let importedCount = 0;
      let skippedCount = 0;

      for (const item of incomingList) {
        // Каждая запись проходит ту же валидацию, что и ручной ввод;
        // некорректные (в т.ч. чужеродные) записи пропускаем
        const safe = sanitizeConfigInput(item);
        if (!safe) {
          skippedCount++;
          continue;
        }
        currentConfigs.push({
          id: `${Date.now()}-${crypto.randomUUID()}`,
          ...safe,
          active: false,
          url: '',
          createdAt: Date.now()
        });
        importedCount++;
      }

      if (importedCount === 0) {
        return { success: false, error: 'Файл не содержит корректных конфигураций' };
      }

      store.set('configs', currentConfigs);
      logger.info(`Успешно импортировано ${importedCount} конфигураций (пропущено: ${skippedCount})`);
      return { success: true, count: importedCount, skipped: skippedCount, configs: getConfigsWithStatuses() };
    } catch (err) {
      logger.error(`Ошибка импорта: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('open-external', (event, url) => {
    const u = String(url || '');
    if (/^https?:\/\//i.test(u)) {
      shell.openExternal(u);
    }
  });

  // Оффлайн-генерация QR-кода в main-процессе (data URL)
  ipcMain.handle('generate-qrcode', async (event, text) => {
    const value = String(text || '');
    if (!value || value.length > 1000) {
      throw new Error('Некорректные данные для QR-кода');
    }
    try {
      return await QRCode.toDataURL(value, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
    } catch (err) {
      logger.error(`Ошибка генерации QR-кода: ${err.message}`);
      throw err;
    }
  });
}