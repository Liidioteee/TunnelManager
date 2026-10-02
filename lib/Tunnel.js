import { EventEmitter } from 'events';
import debugModule from 'debug';
import TunnelCluster from './TunnelCluster.js';

const debug = debugModule('localtunnel:client');

// Сколько соединений держать с сервером туннеля. Значение приходит от
// недоверенного сервера, поэтому ограничиваем его (сервер localtunnel
// по умолчанию выдаёт 10)
const MAX_CONNECTIONS = 10;

function normalizeMaxConn(value) {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_CONNECTIONS);
}

export default class Tunnel extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = { ...opts };
    this.closed = false;
    this.reconnecting = false;
    if (!this.opts.host) {
      this.opts.host = 'https://loca.lt';
    }
    if (this.opts.subdomain) {
      this.opts.subdomain = this.opts.subdomain
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '');
    }
    this.abortController = new AbortController();
  }

  _getInfo(body) {
    const { id, ip, port, url, cached_url, max_conn_count } = body;
    const { host, port: local_port, local_host, local_https, local_cert, local_key, local_ca, allow_invalid_cert } = this.opts;

    if (typeof local_port !== 'number' || local_port < 0 || local_port > 65535) {
      throw new Error('Некорректный локальный порт сервера');
    }

    let remote_host;
    try {
      remote_host = new URL(host).hostname;
    } catch (err) {
      throw new Error(`Недопустимый URL хоста: ${host}`);
    }

    // Сервер туннеля не доверенный: публичный URL попадёт напрямую в href
    // рендерера, поэтому схема должна быть только http/https
    if (!/^https?:\/\//i.test(String(url || ''))) {
      throw new Error('Сервер localtunnel вернул недопустимый URL туннеля');
    }
    if (cached_url && !/^https?:\/\//i.test(String(cached_url))) {
      throw new Error('Сервер localtunnel вернул недопустимый cached_url');
    }

    return {
      name: id,
      url,
      cached_url,
      max_conn: normalizeMaxConn(max_conn_count),
      remote_host,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
    };
  }

  async _init() {
    const opt = this.opts;
    const baseUri = `${opt.host}/`;
    const assignedDomain = opt.subdomain;
    const uri = baseUri + (assignedDomain || '?new');

    let retryDelay = 1000;

    while (!this.closed) {
      let timeout = null;

      try {
        const signal = this.abortController.signal;
        const msgPrefix = this.reconnecting ? 'Переподключение: ' : '';
        this.emit('status', { type: 'info', message: `${msgPrefix}запрос параметров...` });

        timeout = setTimeout(() => {
          if (!this.closed) this.abortController.abort();
        }, 15000);

        const res = await fetch(uri, {
          headers: { accept: 'application/json' },
          signal
        });

        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        if (this.closed) break;

        const body = await res.json();
        debug('got tunnel information', body);

        if (!res.ok) {
          throw new Error((body && body.message) || 'Сервер localtunnel вернул ошибку');
        }

        if (assignedDomain && (!body.id || body.id.toLowerCase() !== assignedDomain.toLowerCase())) {
          const offered = body.id || 'random';
          this.emit('status', {
            type: 'warning',
            message: `Занят. Предложен "${offered}". Повтор через 15с...`
          });

          try {
            await new Promise((resolve, reject) => {
              const sleepTimeout = setTimeout(resolve, 15000);
              signal.addEventListener('abort', () => {
                clearTimeout(sleepTimeout);
                reject(new Error('aborted'));
              }, { once: true });
            });
          } catch (e) {
            if (this.closed) break;
            if (this.abortController.signal.aborted) {
              this.abortController = new AbortController();
            }
          }
          continue;
        }

        return this._getInfo(body);
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }

        if (this.closed) break;

        if (this.abortController.signal.aborted) {
          this.abortController = new AbortController();
        }

        debug(`tunnel server offline: ${err.message}, retry in ${retryDelay}ms`);

        // Туннель продолжает попытки подключиться, поэтому это предупреждение,
        // а не ошибка: ошибка означает, что запуск окончательно не удался
        this.emit('status', {
          type: 'warning',
          code: 'SERVER_RETRY',
          message: `Ошибка сервера. Повтор через ${Math.round(retryDelay / 1000)}с...`
        });

        try {
          const signal = this.abortController.signal;
          await new Promise((resolve, reject) => {
            const sleepTimeout = setTimeout(resolve, retryDelay);
            signal.addEventListener('abort', () => {
              clearTimeout(sleepTimeout);
              reject(new Error('aborted'));
            }, { once: true });
          });
        } catch (e) {
          if (this.closed) break;
        }

        retryDelay = Math.min(retryDelay * 2, 10000) + (Math.random() * 500);
      }
    }
    throw new Error('Подключение отменено или закрыто');
  }

  _establish(info) {
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info);

    let firstOpen = true;
    this.tunnelCluster.on('open', () => {
      this.emit('status', { type: 'success', message: 'Активен' });
      if (firstOpen) {
        firstOpen = false;
        this.emit('url', info.url);
      }
    });

    this.tunnelCluster.on('local-error', () => {
      this.emit('status', {
        type: 'warning',
        code: 'LOCAL_PORT_CLOSED',
        message: `Локальный порт ${info.local_port} недоступен`
      });
    });

    this.tunnelCluster.on('local-connect', () => {
      this.emit('status', { type: 'success', message: 'Активен' });
    });

    this.tunnelCluster.on('error', err => {
      debug('got socket error', err.message);

      if (err.code === 'REMOTE_REFUSED') {
        if (!this.reconnecting && !this.closed) {
          this.reconnecting = true;
          this.emit('status', { type: 'warning', message: 'Переподключение...' });
          this.emit('reconnecting');
          this.tunnelCluster.close();

          setTimeout(() => {
            if (this.closed) return;
            this.open(openErr => {
              this.reconnecting = false;
              if (openErr && !this.closed) {
                this.emit('status', { type: 'error', message: 'Ошибка переподключения' });
                this.emit('error', openErr);
              } else if (!this.closed) {
                this.emit('reconnected', this.url);
              }
            });
          }, 1000);
        }
      } else {
        if (!this.closed) {
          this.emit('status', { type: 'error', message: err.message });
          this.emit('error', err);
        }
      }
    });

    let tunnelCount = 0;

    this.tunnelCluster.on('open', tunnel => {
      tunnelCount++;
      debug('tunnel open [total: %d]', tunnelCount);

      const closeHandler = () => {
        try { tunnel.destroy(); } catch (e) {}
      };

      if (this.closed) {
        return closeHandler();
      }

      this.once('close', closeHandler);
      tunnel.once('close', () => {
        this.removeListener('close', closeHandler);
      });
    });

    this.tunnelCluster.on('dead', () => {
      tunnelCount--;
      debug('tunnel dead [total: %d]', tunnelCount);
      if (this.closed) return;

      setTimeout(() => {
        if (!this.closed && this.tunnelCluster) {
          this.tunnelCluster.open();
        }
      }, 500);
    });

    this.tunnelCluster.on('request', req => {
      this.emit('request', req);
    });

    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open();
    }
  }

  async open(cb) {
    try {
      const msgPrefix = this.reconnecting ? 'Переподключение: ' : '';
      this.emit('status', { type: 'info', message: `${msgPrefix}запуск...` });
      const info = await this._init();
      if (this.closed) return;

      this.clientId = info.name;
      this.url = info.url;

      if (info.cached_url) {
        this.cachedUrl = info.cached_url;
      }

      this._establish(info);
      if (cb) cb();
    } catch (err) {
      if (!this.closed) {
        this.emit('status', { type: 'error', message: err.message });
        if (cb) cb(err);
        else this.emit('error', err);
      } else {
        if (cb) cb(new Error('closed'));
      }
    }
  }

  close() {
    this.closed = true;
    try {
      this.abortController.abort();
    } catch (e) {}
    if (this.tunnelCluster) {
      this.tunnelCluster.close();
    }
    this.emit('status', { type: 'info', message: 'Не активен' });
    this.emit('close');
  }
}