import { EventEmitter } from 'events';
import debugModule from 'debug';
import fs from 'fs';
import net from 'net';
import tls from 'tls';
import HeaderHostTransformer from './HeaderHostTransformer.js';

const debug = debugModule('localtunnel:client');

export default class TunnelCluster extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.isClosed = false;
    this.activeSockets = new Set();
    this.activeTimers = new Set();
    this.localCertOpts = {};

    if (opts.local_https && !opts.allow_invalid_cert && opts.local_cert && opts.local_key) {
      try {
        this.localCertOpts = {
          cert: fs.readFileSync(opts.local_cert),
          key: fs.readFileSync(opts.local_key),
          ca: opts.local_ca
            ? [].concat(opts.local_ca).map(caPath => fs.readFileSync(caPath))
            : undefined,
        };
      } catch (err) {
        debug('Error reading local certificates:', err.message);
      }
    }
  }

  open() {
    if (this.isClosed) return;

    const opt = this.opts;
    const remoteHostOrIp = opt.remote_ip || opt.remote_host;
    const remotePort = opt.remote_port;
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;
    const localProtocol = opt.local_https ? 'https' : 'http';
    const allowInvalidCert = opt.allow_invalid_cert !== false;

    debug('establishing tunnel %s://%s:%s <> %s:%s', localProtocol, localHost, localPort, remoteHostOrIp, remotePort);

    const remote = net.connect({
      host: remoteHostOrIp,
      port: remotePort,
    });

    this.activeSockets.add(remote);
    remote.setKeepAlive(true);

    remote.on('error', err => {
      debug('got remote connection error', err.message);
      if (err.code === 'ECONNREFUSED') {
        // Tunnel распознаёт эту ошибку по коду (не по тексту) и переподключается
        const refused = new Error(`Ошибка сети: ${remoteHostOrIp}:${remotePort} недоступен`);
        refused.code = 'REMOTE_REFUSED';
        this.emit('error', refused);
      }
      this.emit('dead');
      remote.end();
    });

    remote.once('close', () => {
      this.activeSockets.delete(remote);
    });

    const connLocal = () => {
      if (this.isClosed) return;
      if (remote.destroyed) {
        debug('remote destroyed');
        this.emit('dead');
        return;
      }

      debug('connecting locally to %s://%s:%d', localProtocol, localHost, localPort);
      remote.pause();

      const getLocalCertOpts = () => allowInvalidCert ? { rejectUnauthorized: false } : this.localCertOpts;

      let local;
      try {
        local = opt.local_https
          ? tls.connect({ host: localHost, port: localPort, ...getLocalCertOpts() })
          : net.connect({ host: localHost, port: localPort });
      } catch (err) {
        debug('Failed to initiate local connection:', err.message);
        this.emit('local-error', err);
        return;
      }

      this.activeSockets.add(local);

      const remoteClose = () => {
        debug('remote close');
        this.emit('dead');
        local.end();
      };

      remote.once('close', remoteClose);

      local.once('error', err => {
        debug('local error %s', err.message);
        local.end();

        remote.removeListener('close', remoteClose);

        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
          this.emit('local-error', err);
        }

        if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
          this.emit('dead');
          return remote.end();
        }

        if (!this.isClosed) {
          const timer = setTimeout(() => {
            this.activeTimers.delete(timer);
            connLocal();
          }, 1000);
          this.activeTimers.add(timer);
        }
      });

      local.once('close', () => {
        this.activeSockets.delete(local);
      });

      local.once('connect', () => {
        debug('connected locally');
        this.emit('local-connect');
        remote.resume();

        let stream = remote;
        if (opt.local_host && opt.local_host !== 'localhost' && opt.local_host !== '127.0.0.1') {
          debug('transform Host header to %s', opt.local_host);
          stream = remote.pipe(new HeaderHostTransformer({ host: opt.local_host }));
        }

        stream.pipe(local).pipe(remote);
      });
    };

    remote.on('data', data => {
      const matches = data.toString().matchAll(/^([A-Za-z]+) (\S+) HTTP\/\d\.\d/gm);
      for (const match of matches) {
        this.emit('request', {
          method: match[1],
          path: match[2],
        });
      }
    });

    remote.once('connect', () => {
      this.emit('open', remote);
      connLocal();
    });
  }

  close() {
    this.isClosed = true;
    for (const timer of this.activeTimers) clearTimeout(timer);
    this.activeTimers.clear();
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch (e) {}
    }
    this.activeSockets.clear();
  }
}