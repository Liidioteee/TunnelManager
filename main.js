import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import Store from 'electron-store';
import QRCode from 'qrcode';
import dns from 'dns';
import Tunnel from './lib/Tunnel.js';
import CFTunnel from './lib/CFTunnel.js';
import logger from './lib/Logger.js';
import TunnelManager from './lib/TunnelManager.js';
import { parseLocaltunnelServer } from './lib/configValidation.js';
import { checkLocalPort } from './lib/localPort.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './lib/settings.js';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_INDEX_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;

const gotTheLock = app.requestSingleInstanceLock();

let mainWindow;
let tray = null;
let isQuitting = false;

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

  if (!store.has('settings')) {
    store.set('settings', { ...DEFAULT_SETTINGS });
  }

  function getSettings() {
    return sanitizeSettings(undefined, store.get('settings'));
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

  function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  // Необязательный собственный сервер localtunnel вместо https://loca.lt
  // (также используется сквозными тестами с фейковым сервером)
  const ltServerEnv = process.env.TUNNEL_MANAGER_LT_SERVER;
  const ltServer = parseLocaltunnelServer(ltServerEnv);
  if (ltServerEnv && !ltServer) {
    logger.warn('TUNNEL_MANAGER_LT_SERVER проигнорирована: ожидается адрес вида https://host[:port]');
  } else if (ltServer) {
    logger.info(`Используется сервер localtunnel: ${ltServer}`);
  }

  function createTunnel(config) {
    const localHost = config.localHost || 'localhost';
    const localProtocol = config.localProtocol || 'http';

    if ((config.provider || 'lt') === 'cf') {
      return new CFTunnel({
        binDir: app.getPath('userData'),
        port: parseInt(config.port, 10),
        localHost,
        localProtocol,
        skipTlsVerify: config.skipTlsVerify !== false
      });
    }
    return new Tunnel({
      host: ltServer || undefined,
      port: parseInt(config.port, 10),
      subdomain: config.subdomain || undefined,
      local_host: localHost,
      local_https: localProtocol === 'https',
      allow_invalid_cert: config.skipTlsVerify !== false
    });
  }

  const manager = new TunnelManager({
    store,
    createTunnel,
    checkLocalPort,
    logger,
    notify: showNotification
  });

  manager.on('status', (data) => sendToWindow('tunnel-status', data));
  manager.on('configs', (configs) => sendToWindow('configs-updated', configs));
  manager.on('request-stats', (data) => sendToWindow('request-stats', data));

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
          manager.getConfigs().forEach(c => { if (c.active) manager.stop(c.id); });
        }
      },
      { type: 'separator' },
      { label: 'Выход', click: () => {
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

  // При выходе туннели закрываются, но остаются активными в хранилище —
  // при следующем запуске restoreActive() поднимет их снова
  app.on('before-quit', () => {
    isQuitting = true;
    manager.shutdown();
  });

  app.whenReady().then(() => {
    logger.info('Приложение запущено и готово к работе');
    const settings = getSettings();
    applyAutoLaunch(settings);
    createWindow();
    createTray();

    manager.restoreActive();

    // Периодическое обновление времени работы
    setInterval(() => {
      sendToWindow('uptimes-updated', manager.getUptimes());
    }, 1000);

    // Параллельная неблокирующая проверка доступности локальных портов
    setInterval(() => {
      manager.checkPorts().catch(err => logger.error(`Ошибка проверки портов: ${err.message}`));
    }, 3000);
  });

  // --- IPC ОБРАБОТЧИКИ ---

  ipcMain.handle('get-configs', () => manager.getConfigsWithStatuses());
  ipcMain.handle('add-config', (event, rawConfig) => manager.addConfig(rawConfig));
  ipcMain.handle('update-config', (event, rawConfig) => manager.updateConfig(rawConfig));
  ipcMain.handle('delete-config', (event, id) => manager.deleteConfig(id));
  ipcMain.handle('toggle-tunnel', (event, id, state) => manager.toggle(id, state));
  ipcMain.handle('batch-toggle', (event, { ids, state }) => manager.batchToggle(ids, state));
  ipcMain.handle('batch-delete', (event, ids) => manager.batchDelete(ids));

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
    // только известные настройки нужных типов
    const updated = sanitizeSettings(newSettings, getSettings());
    store.set('settings', updated);
    applyAutoLaunch(updated);
    logger.info('Настройки приложения обновлены');
    return updated;
  });

  // Экспорт / Импорт конфигураций
  ipcMain.handle('export-configs', async () => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт конфигураций туннелей',
      defaultPath: `tunnel-manager-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (canceled || !filePath) return { success: false };

    try {
      const data = manager.exportData('1.1.0');
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`Конфигурации экспортированы в ${filePath}`);
      return { success: true, count: data.configs.length };
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
      return manager.importConfigs(parsed);
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