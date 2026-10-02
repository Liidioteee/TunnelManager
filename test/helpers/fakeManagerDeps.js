import { EventEmitter } from 'node:events';
import TunnelManager from '../../lib/TunnelManager.js';

// Хранилище с интерфейсом electron-store (get/set), данные — копии,
// как при чтении с диска
export class MemoryStore {
  constructor(data = {}) {
    this.data = structuredClone(data);
    this.writes = 0;
  }
  get(key) {
    return this.data[key] === undefined ? undefined : structuredClone(this.data[key]);
  }
  set(key, value) {
    this.writes++;
    this.data[key] = structuredClone(value);
  }
}

// Туннель с тем же контрактом событий, что Tunnel и CFTunnel: open(cb)
// ждёт, пока тест вызовет succeed()/fail(); close() шлёт status и close
export class FakeTunnel extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.closed = false;
    this.url = '';
    this.startTime = null;
    this.openCallback = null;
  }
  open(cb) {
    this.openCallback = cb;
  }
  succeed(url = `https://${this.config.id}.loca.lt`) {
    this.url = url;
    this.emit('status', { type: 'success', message: 'Активен' });
    this.openCallback(null);
  }
  fail(err = new Error('boom')) {
    this.openCallback(err);
  }
  close() {
    this.closed = true;
    this.emit('status', { type: 'info', message: 'Не активен' });
    this.emit('close');
    if (this.openCallback && !this.url) this.openCallback(new Error('closed'));
  }
}

export const silentLogger = { info() {}, warn() {}, error() {} };

export function makeConfig(overrides = {}) {
  return {
    id: 'c1', name: 'API', port: '3000', subdomain: '', provider: 'lt',
    localHost: 'localhost', localProtocol: 'http', skipTlsVerify: true,
    active: false, url: '', createdAt: 1, ...overrides
  };
}

// Менеджер с фейковыми зависимостями; tunnels — все созданные туннели
export function makeManager({ configs = [], portOpen = true, restartBaseDelay } = {}) {
  const store = new MemoryStore({ configs });
  const tunnels = [];
  const notifications = [];
  const events = { status: [], configs: [], 'request-stats': [] };
  const deps = {
    portOpen,
    checkLocalPort: async () => deps.portOpen
  };
  const manager = new TunnelManager({
    store,
    createTunnel: (config) => {
      const tunnel = new FakeTunnel(config);
      tunnels.push(tunnel);
      return tunnel;
    },
    checkLocalPort: (...args) => deps.checkLocalPort(...args),
    logger: silentLogger,
    notify: (title, body) => notifications.push({ title, body }),
    restartBaseDelay
  });
  for (const name of Object.keys(events)) {
    manager.on(name, (data) => events[name].push(data));
  }
  const storedConfig = (id = 'c1') => store.get('configs').find(c => c.id === id);
  const lastStatus = (id = 'c1') => events.status.filter(e => e.id === id).at(-1)?.status;
  return { manager, store, tunnels, notifications, events, deps, storedConfig, lastStatus };
}

// Даёт отработать промисам и асинхронным обработчикам событий
export const flush = () => new Promise(resolve => setImmediate(resolve));
