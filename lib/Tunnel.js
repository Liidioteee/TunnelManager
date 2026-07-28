import { EventEmitter } from 'events';
import debugModule from 'debug';
import TunnelCluster from './TunnelCluster.js';

const debug = debugModule('localtunnel:client');

export default class Tunnel extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.closed = false;
    this.reconnecting = false;
    if (!this.opts.host) {
      this.opts.host = 'https://loca.lt';
    }
    this.abortController = new AbortController();
  }

  _getInfo(body) {
    const { id, ip, port, url, cached_url, max_conn_count } = body;
    const { host, port: local_port, local_host } = this.opts;
    const { local_https, local_cert, local_key, local_ca, allow_invalid_cert } = this.opts;
    
    if (typeof local_port !== 'number' || local_port < 0 || local_port > 65535) {
      throw new Error('Некорректный локальный порт сервера');
    }

    let remote_host;
    try {
      remote_host = new URL(host).hostname;
    } catch (err) {
      throw new Error(`Недопустимый URL хоста: ${host}`);
    }

    return {
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
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
        
        timeout = setTimeout(() => this.abortController.abort(), 15000);
        
        const res = await fetch(uri, {
          headers: { accept: 'application/json' },
          signal
        });
        
        clearTimeout(timeout);
        timeout = null;
        
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
        
        this.emit('status', { 
          type: 'error', 
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
      this.emit('status', { type: 'warning', message: `Локальный порт ${info.local_port} недоступен` });
    });

    this.tunnelCluster.on('local-connect', () => {
      this.emit('status', { type: 'success', message: 'Активен' });
    });

    this.tunnelCluster.on('error', err => {
      debug('got socket error', err.message);
      
      if (err.message.includes('connection refused')) {
        if (!this.reconnecting && !this.closed) {
          this.reconnecting = true;
          this.emit('status', { type: 'warning', message: 'Переподключение...' });
          this.emit('reconnecting');
          this.tunnelCluster.close();
          
          setTimeout(() => {
            this.open(openErr => {
              this.reconnecting = false;
              if (openErr) {
                this.emit('status', { type: 'error', message: 'Ошибка переподключения' });
                this.emit('error', openErr);
              } else {
                this.emit('reconnected', this.url);
              }
            });
          }, 1000);
        }
      } else {
        this.emit('status', { type: 'error', message: err.message });
        this.emit('error', err);
      }
    });

    let tunnelCount = 0;

    this.tunnelCluster.on('open', tunnel => {
      tunnelCount++;
      debug('tunnel open [total: %d]', tunnelCount);

      const closeHandler = () => tunnel.destroy();

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
      
      this.emit('status', { type: 'warning', message: 'Соединение разорвано. Восстановление...' });

      setTimeout(() => {
        if (!this.closed) this.tunnelCluster.open();
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
      }
      if (cb) cb(err);
      else if (!this.closed) this.emit('error', err);
    }
  }

  close() {
    this.closed = true;
    this.abortController.abort();
    if (this.tunnelCluster) this.tunnelCluster.close();
    this.emit('status', { type: 'info', message: 'Не активен' });
    this.emit('close');
  }
}