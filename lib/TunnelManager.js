import { EventEmitter } from 'events';
import crypto from 'crypto';
import { sanitizeConfigInput, validateConfigInput } from './configValidation.js';

const ALLOWED_METHODS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/;

function emptyStats() {
  return { count: 0, lastMethod: '', lastPath: '', lastTime: null };
}

function newConfigId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

// Управляет конфигурациями и жизненным циклом туннелей.
//
// Модуль не зависит от electron: хранилище, создание туннелей, проверка
// локального порта и уведомления передаются в конструктор. main.js
// пересылает события менеджера в окно:
//   'status'        { id, status }  — статус одного туннеля
//   'configs'       [configs]       — полный список конфигураций со статусами
//   'request-stats' { id, stats }   — счётчик входящих запросов
export default class TunnelManager extends EventEmitter {
  constructor({ store, createTunnel, checkLocalPort, logger, notify = () => {}, restartBaseDelay = 2000 }) {
    super();
    this.store = store;
    this.createTunnel = createTunnel;
    this.checkLocalPort = checkLocalPort;
    this.logger = logger;
    this.notify = notify;

    // Текущий экземпляр туннеля каждой конфигурации — и работающий,
    // и ещё подключающийся. Выставляется синхронно в начале start(),
    // поэтому одновременно может быть только один запуск
    this.activeTunnels = {};
    this.tunnelStates = {};
    this.requestStats = {};
    this.shuttingDown = false;

    // Перезапуск туннелей, которые неожиданно завершились после запуска
    this.restartBaseDelay = restartBaseDelay;
    this.restartTimers = {};
    this.restartAttempts = {};
  }

  // --- Хранилище ---

  getConfigs() {
    return this.store.get('configs') || [];
  }

  _setConfigs(configs) {
    this.store.set('configs', configs);
  }

  // --- Статусы ---

  computeStatus(configId, isActiveInStore) {
    const state = this.tunnelStates[configId];

    if (!isActiveInStore) {
      // После неудачного запуска туннель выключен, но причину нужно
      // показывать, пока пользователь снова не включит или не выключит его
      if (state && state.connectionState === 'error') {
        return { type: 'error', message: state.connectionMessage || 'Ошибка запуска' };
      }
      return { type: 'info', message: 'Не активен' };
    }

    if (!state) {
      return { type: 'info', message: 'Запуск...' };
    }

    if (state.connectionState === 'error') {
      return { type: 'error', message: state.connectionMessage || 'Ошибка сети' };
    }

    if (state.connectionState === 'starting') {
      return { type: 'info', message: state.connectionMessage || 'Запуск...' };
    }

    // Туннель не подключён, но продолжает попытки (сервер недоступен,
    // субдомен занят, переподключение) — проблема, но не отказ
    if (state.connectionState === 'retrying') {
      return { type: 'warning', message: state.connectionMessage || 'Повторное подключение...' };
    }

    if (state.connectionState === 'connected') {
      if (state.localPortState === 'closed') {
        const config = this.getConfigs().find(c => c.id === configId);
        const port = config ? config.port : '';
        return { type: 'warning', message: `Локальный порт ${port} недоступен` };
      }
      return { type: 'success', message: 'Активен' };
    }

    return { type: 'info', message: 'Запуск...' };
  }

  getConfigsWithStatuses() {
    return this.getConfigs().map(c => ({
      ...c,
      status: this.computeStatus(c.id, c.active),
      stats: this.requestStats[c.id] || emptyStats()
    }));
  }

  _broadcastStatus(configId) {
    const config = this.getConfigs().find(c => c.id === configId);
    const isActive = config ? config.active : false;
    this.emit('status', { id: configId, status: this.computeStatus(configId, isActive) });
  }

  _broadcastConfigs() {
    this.emit('configs', this.getConfigsWithStatuses());
  }

  // --- Статистика запросов и время работы ---

  handleRequest(configId, req) {
    if (!this.requestStats[configId]) {
      this.requestStats[configId] = emptyStats();
    }
    const stats = this.requestStats[configId];
    stats.count++;

    // Данные приходят из строк внешних HTTP-запросов — оставляем только
    // известный метод и путь без query string (там могут быть токены)
    const rawMethod = String((req && req.method) || '').toUpperCase();
    stats.lastMethod = ALLOWED_METHODS.test(rawMethod) ? rawMethod : 'REQ';
    stats.lastPath = String((req && req.path) || '/').split('?')[0].slice(0, 120);
    stats.lastTime = Date.now();

    this.emit('request-stats', { id: configId, stats });
  }

  handleRequestCount(configId, count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n <= 0) return;
    if (!this.requestStats[configId]) {
      this.requestStats[configId] = emptyStats();
    }
    const stats = this.requestStats[configId];
    stats.count += n;
    stats.lastTime = Date.now();
    this.emit('request-stats', { id: configId, stats });
  }

  getUptimes(now = Date.now()) {
    const uptimes = {};
    for (const [id, tunnel] of Object.entries(this.activeTunnels)) {
      if (tunnel && tunnel.startTime) {
        uptimes[id] = Math.floor((now - tunnel.startTime) / 1000);
      }
    }
    return uptimes;
  }

  // Параллельная неблокирующая проверка доступности локальных портов
  async checkPorts() {
    const connectedConfigs = this.getConfigs().filter(config => {
      const tunnel = this.activeTunnels[config.id];
      const state = this.tunnelStates[config.id];
      return tunnel && tunnel.startTime && state && state.connectionState === 'connected';
    });

    if (connectedConfigs.length === 0) return;

    let hasChanges = false;
    await Promise.allSettled(connectedConfigs.map(async (config) => {
      const stateBefore = this.tunnelStates[config.id];
      const seqBefore = stateBefore.statusSeq;
      const isPortOpen = await this.checkLocalPort(parseInt(config.port, 10), config.localHost || 'localhost');
      const newState = isPortOpen ? 'open' : 'closed';
      const state = this.tunnelStates[config.id];
      // Пока шла проверка, туннель могли остановить или пришёл новый статус
      if (state !== stateBefore || state.statusSeq !== seqBefore) return;
      if (state.localPortState !== newState) {
        state.localPortState = newState;
        hasChanges = true;
        this._broadcastStatus(config.id);
      }
    }));

    if (hasChanges) {
      this._broadcastConfigs();
    }
  }

  // --- Жизненный цикл туннелей ---

  async start(configId) {
    if (this.shuttingDown || this.activeTunnels[configId]) {
      return;
    }
    this._cancelRestart(configId);

    const config = this.getConfigs().find(c => c.id === configId);
    if (!config) return;

    this.tunnelStates[configId] = {
      connectionState: 'starting',
      connectionMessage: 'Запуск...',
      localPortState: 'unknown',
      statusSeq: 0
    };
    this._broadcastStatus(configId);

    const localHost = config.localHost || 'localhost';
    const tunnel = this.createTunnel(config);
    this.activeTunnels[configId] = tunnel;

    tunnel.on('request', (req) => {
      this.handleRequest(configId, req);
    });
    // Cloudflare сообщает только число новых запросов, без метода и пути
    tunnel.on('requests', (count) => {
      this.handleRequestCount(configId, count);
    });

    // Без обработчика событие 'error' у EventEmitter выбрасывает исключение
    // и роняет main-процесс. Статус ошибки туннель отправляет через 'status'.
    tunnel.on('error', (err) => {
      this.logger.error(`Ошибка туннеля ${configId}: ${err.message}`);
    });

    tunnel.on('status', async (status) => {
      // Статусы остановленного или заменённого экземпляра не учитываем
      if (this.activeTunnels[configId] !== tunnel) return;
      const state = this.tunnelStates[configId];
      if (!state) return;

      // Порядковый номер статуса: результат асинхронной проверки порта
      // применяется, только если за время ожидания не пришло ничего новее
      const seq = ++state.statusSeq;

      if (status.type === 'success') {
        state.connectionState = 'connected';
        state.connectionMessage = status.message;
        const isPortOpen = await this.checkLocalPort(parseInt(config.port, 10), localHost);
        if (this.tunnelStates[configId] !== state || state.statusSeq !== seq) return;
        state.localPortState = isPortOpen ? 'open' : 'closed';
      } else if (status.type === 'error') {
        state.connectionState = 'error';
        state.connectionMessage = status.message;
      } else if (status.type === 'warning') {
        // Тип предупреждения определяется по коду: текст сообщения
        // предназначен для пользователя и может меняться
        if (status.code === 'LOCAL_PORT_CLOSED') {
          state.connectionState = 'connected';
          state.localPortState = 'closed';
        } else {
          state.connectionState = 'retrying';
          state.connectionMessage = status.message;
        }
      } else {
        state.connectionState = 'starting';
        state.connectionMessage = status.message;
      }

      this._broadcastStatus(configId);
    });

    try {
      await new Promise((resolve, reject) => {
        tunnel.open(err => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Пока шло подключение, туннель остановили или заменили новым —
      // stop() уже обновил состояние, результат этого запуска не нужен
      if (this.activeTunnels[configId] !== tunnel) {
        this.logger.warn(`Запуск туннеля ${configId} отменён до завершения`);
        return;
      }

      tunnel.startTime = Date.now();

      const currentConfigs = this.getConfigs();
      const currentConfig = currentConfigs.find(c => c.id === configId);
      if (currentConfig) {
        currentConfig.url = tunnel.url;
        currentConfig.active = true;
        this._setConfigs(currentConfigs);
      }

      // Туннель закрылся сам (например, упал процесс cloudflared) — он
      // остаётся включённым и перезапускается. Событие от уже остановленного
      // или заменённого экземпляра игнорируем: stop() сам вызывает
      // tunnel.close(), а запоздалый 'close' старого туннеля ни на что не влияет
      tunnel.on('close', () => {
        if (this.activeTunnels[configId] === tunnel) {
          this._handleUnexpectedClose(configId, tunnel);
        }
      });

      // После переподключения localtunnel может выдать другой адрес
      // (если субдомен не закреплён) — обновляем сохранённую ссылку
      tunnel.on('reconnected', (url) => {
        if (this.activeTunnels[configId] !== tunnel || !url) return;
        const configsNow = this.getConfigs();
        const configNow = configsNow.find(c => c.id === configId);
        if (configNow && configNow.url !== url) {
          configNow.url = url;
          this._setConfigs(configsNow);
          this.logger.info(`Туннель ${configId} переподключён с новым адресом: ${url}`);
          this._broadcastConfigs();
        }
      });

      this.notify('Туннель запущен', `${config.name}: ${tunnel.url}`);
      this._broadcastConfigs();
      return tunnel.url;
    } catch (err) {
      // Запуск отменён: туннель остановили (stop/shutdown уже обновили
      // состояние и хранилище) или вместо него уже запущен новый, который
      // нельзя затирать. Ошибка закрытого туннеля — следствие отмены.
      if (this.activeTunnels[configId] !== tunnel || tunnel.closed) {
        if (this.activeTunnels[configId] === tunnel) delete this.activeTunnels[configId];
        if (!this.shuttingDown) this.logger.warn(`Запуск туннеля ${configId} отменён до завершения`);
        return;
      }

      delete this.activeTunnels[configId];

      const currentConfigs = this.getConfigs();
      const currentConfig = currentConfigs.find(c => c.id === configId);
      if (currentConfig) {
        currentConfig.active = false;
        currentConfig.url = '';
        this._setConfigs(currentConfigs);
      }

      this.tunnelStates[configId] = {
        connectionState: 'error',
        connectionMessage: `Ошибка: ${err.message}`,
        localPortState: 'unknown'
      };
      this._broadcastStatus(configId);
      this._broadcastConfigs();
      throw err;
    }
  }

  // Пауза перед n-й попыткой перезапуска: base, 2·base, 4·base … не больше минуты
  _restartDelay(attempt) {
    return Math.min(this.restartBaseDelay * 2 ** (attempt - 1), 60000);
  }

  _cancelRestart(configId) {
    if (this.restartTimers[configId]) {
      clearTimeout(this.restartTimers[configId]);
      delete this.restartTimers[configId];
    }
  }

  _handleUnexpectedClose(configId, tunnel) {
    delete this.activeTunnels[configId];

    // Туннель проработал больше минуты — считаем это не серией падений
    const uptime = tunnel.startTime ? Date.now() - tunnel.startTime : 0;
    if (uptime > 60000) this.restartAttempts[configId] = 0;
    const attempt = (this.restartAttempts[configId] || 0) + 1;
    this.restartAttempts[configId] = attempt;
    const delay = this._restartDelay(attempt);

    const configs = this.getConfigs();
    const config = configs.find(c => c.id === configId);
    if (config) {
      config.url = ''; // адрес туннеля после перезапуска будет другим
      this._setConfigs(configs);
    }

    const seconds = Math.max(1, Math.round(delay / 1000));
    this.tunnelStates[configId] = {
      connectionState: 'retrying',
      connectionMessage: `Процесс туннеля завершился. Перезапуск через ${seconds} с...`,
      localPortState: 'unknown',
      statusSeq: 0
    };
    this.logger.warn(`Туннель ${configId} неожиданно завершился, перезапуск через ${delay} мс (попытка ${attempt})`);
    this.notify('Туннель перезапускается', `${config ? config.name : configId}: процесс туннеля неожиданно завершился`);
    this._broadcastStatus(configId);
    this._broadcastConfigs();

    this.restartTimers[configId] = setTimeout(() => {
      delete this.restartTimers[configId];
      this.start(configId).catch(err => this.logger.error(`Ошибка перезапуска туннеля ${configId}: ${err.message}`));
    }, delay);
  }

  stop(configId) {
    this._cancelRestart(configId);
    delete this.restartAttempts[configId];
    const tunnel = this.activeTunnels[configId];
    if (tunnel) {
      delete this.activeTunnels[configId];
      try {
        tunnel.close();
      } catch (err) {
        this.logger.error(`Ошибка при остановке туннеля ${configId}: ${err.message}`);
      }
    }

    this.tunnelStates[configId] = {
      connectionState: 'stopped',
      connectionMessage: 'Не активен',
      localPortState: 'unknown'
    };
    this._broadcastStatus(configId);

    const configs = this.getConfigs();
    const config = configs.find(c => c.id === configId);
    if (config) {
      config.active = false;
      config.url = '';
      this._setConfigs(configs);
    }
    this._broadcastConfigs();
  }

  stopAll() {
    for (const id of Object.keys(this.activeTunnels)) {
      try {
        this.stop(id);
      } catch (err) {
        this.logger.error(`Ошибка при остановке туннеля ${id} (stopAll): ${err.message}`);
      }
    }
  }

  // Выход из приложения: закрывает все туннели, но не трогает флаг active
  // в хранилище, чтобы при следующем запуске restoreActive() их восстановил.
  // (stop/stopAll — это действия пользователя «выключить туннель».)
  shutdown() {
    this.shuttingDown = true;
    for (const id of Object.keys(this.restartTimers)) this._cancelRestart(id);
    for (const [id, tunnel] of Object.entries(this.activeTunnels)) {
      delete this.activeTunnels[id];
      try {
        tunnel.close();
      } catch (err) {
        this.logger.error(`Ошибка при закрытии туннеля ${id} при выходе: ${err.message}`);
      }
    }
  }

  // Запуск туннелей, которые были активны при прошлом запуске приложения
  restoreActive() {
    for (const config of this.getConfigs()) {
      if (config.active) {
        this.start(config.id).catch(err => this.logger.error(`Ошибка автозапуска туннеля ${config.id}: ${err.message}`));
      }
    }
  }

  // --- Операции с конфигурациями (IPC) ---

  addConfig(rawConfig) {
    const { config: safe, error } = validateConfigInput(rawConfig);
    if (!safe) {
      throw new Error(error);
    }

    const configs = this.getConfigs();
    const newConfig = {
      id: newConfigId(),
      ...safe,
      active: false,
      url: '',
      createdAt: Date.now()
    };
    configs.push(newConfig);
    this._setConfigs(configs);
    this.logger.info(`Создана конфигурация: ${newConfig.name} (${newConfig.provider})`);
    return this.getConfigsWithStatuses();
  }

  updateConfig(rawConfig) {
    if (!rawConfig || !rawConfig.id) {
      throw new Error('Некорректный запрос на обновление');
    }

    const { config: safe, error } = validateConfigInput(rawConfig);
    if (!safe) {
      throw new Error(error);
    }

    const id = rawConfig.id;
    const existing = this.getConfigs().find(c => c.id === id);
    if (!existing) {
      return this.getConfigsWithStatuses();
    }

    // Работающий туннель перезапускается с новыми параметрами,
    // выключенный остаётся выключенным
    const wasActive = !!existing.active;
    this.stop(id);

    const configs = this.getConfigs();
    const config = configs.find(c => c.id === id);
    Object.assign(config, safe, { active: wasActive, url: '' });
    this._setConfigs(configs);
    this.logger.info(`Конфигурация ${id} обновлена: ${config.name}${wasActive ? ' (перезапуск)' : ''}`);

    if (wasActive) {
      this.start(id).catch(err => this.logger.error(`Ошибка перезапуска туннеля ${id}: ${err.message}`));
    }
    return this.getConfigsWithStatuses();
  }

  // --- Проверка аргументов из окна (IPC) ---

  _requireState(state) {
    if (typeof state !== 'boolean') {
      throw new Error('Некорректное состояние туннеля');
    }
  }

  _requireId(id) {
    if (typeof id !== 'string' || !id) {
      throw new Error('Туннель не найден');
    }
  }

  // Список id из окна: массив строк; повторы и неизвестные id отбрасываются
  _knownIds(ids) {
    if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(id => typeof id === 'string')) {
      throw new Error('Некорректный список туннелей');
    }
    const known = new Set(this.getConfigs().map(c => c.id));
    return [...new Set(ids)].filter(id => known.has(id));
  }

  deleteConfig(id) {
    this._requireId(id);
    this.stop(id);
    delete this.requestStats[id];
    delete this.tunnelStates[id];
    this._setConfigs(this.getConfigs().filter(c => c.id !== id));
    this.logger.info(`Конфигурация ${id} удалена`);
    return this.getConfigsWithStatuses();
  }

  toggle(id, state) {
    this._requireId(id);
    this._requireState(state);
    const configs = this.getConfigs();
    const config = configs.find(c => c.id === id);
    if (!config) {
      throw new Error('Туннель не найден');
    }
    config.active = state;
    if (!state) {
      config.url = '';
    }
    this._setConfigs(configs);

    if (state) {
      this.start(id).catch(err => this.logger.error(`Ошибка активации туннеля ${id}: ${err.message}`));
    } else {
      this.stop(id);
    }
    return this.getConfigsWithStatuses();
  }

  batchToggle(rawIds, state) {
    const ids = this._knownIds(rawIds);
    this._requireState(state);
    this.logger.info(`Пакетное переключение состояния (${state ? 'Вкл' : 'Выкл'}) для: ${ids.join(', ')}`);
    const configs = this.getConfigs();

    for (const id of ids) {
      const config = configs.find(c => c.id === id);
      if (config) {
        config.active = state;
        if (!state) {
          config.url = '';
        }
      }
    }
    this._setConfigs(configs);

    for (const id of ids) {
      if (state) {
        this.start(id).catch(err => this.logger.error(`Ошибка запуска в пакете ${id}: ${err.message}`));
      } else {
        this.stop(id);
      }
    }

    return this.getConfigsWithStatuses();
  }

  batchDelete(rawIds) {
    const ids = this._knownIds(rawIds);
    this.logger.info(`Пакетное удаление конфигураций: ${ids.join(', ')}`);
    for (const id of ids) {
      this.stop(id);
      delete this.requestStats[id];
      delete this.tunnelStates[id];
    }
    this._setConfigs(this.getConfigs().filter(c => !ids.includes(c.id)));
    return this.getConfigsWithStatuses();
  }

  // Данные для экспорта: только пользовательские поля, без состояния
  exportData(version) {
    const configs = this.getConfigs();
    return {
      version,
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
  }

  // Импорт уже разобранного JSON (массив или { configs: [...] })
  importConfigs(parsed) {
    const incomingList = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' ? parsed.configs : null);

    if (!Array.isArray(incomingList) || incomingList.length === 0) {
      return { success: false, error: 'Файл не содержит корректных конфигураций' };
    }

    const currentConfigs = this.getConfigs();
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
        id: newConfigId(),
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

    this._setConfigs(currentConfigs);
    this.logger.info(`Успешно импортировано ${importedCount} конфигураций (пропущено: ${skippedCount})`);
    return { success: true, count: importedCount, skipped: skippedCount, configs: this.getConfigsWithStatuses() };
  }
}
