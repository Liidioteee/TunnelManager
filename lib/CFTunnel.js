import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { install } from 'cloudflared';
import logger from './Logger.js';

export default class CFTunnel extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.port = parseInt(opts.port);
    this.closed = false;
    this.child = null;
    this.url = '';
    this.startTime = null;
    
    const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    this.binPath = path.join(app.getPath('userData'), exeName);
  }

  async open(cb) {
    this.emit('status', { type: 'info', message: 'Проверка бинарного файла Cloudflare...' });
    logger.info(`Проверка наличия бинарного файла cloudflared в: ${this.binPath}`);

    try {
      if (!fs.existsSync(this.binPath)) {
        this.emit('status', { type: 'info', message: 'Скачивание cloudflared...' });
        logger.info('Бинарный файл не найден. Начинается скачивание...');
        await install(this.binPath);
        
        if (process.platform !== 'win32') {
          fs.chmodSync(this.binPath, 0o755);
        }
        logger.info('Бинарный файл cloudflared успешно установлен.');
      }

      this.emit('status', { type: 'info', message: 'Запуск туннеля Cloudflare...' });
      logger.info(`Запуск Quick Tunnel для порта ${this.port}...`);

      this.child = spawn(this.binPath, ['tunnel', '--url', `http://localhost:${this.port}`, '--protocol', 'http2']);

      let callbackCalled = false;

      this.child.stderr.on('data', (data) => {
        const text = data.toString();
        logger.info(`[cloudflared-stderr] ${text.trim()}`);

        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !this.url) {
          this.url = match[0];
          logger.info(`Получена ссылка trycloudflare: ${this.url}`);
          this.emit('status', { type: 'info', message: 'Подключение к сети...' });
        }

        if (text.includes('Registered tunnel connection') || text.includes('Registered connection')) {
          this.emit('status', { type: 'success', message: 'Активен' });
          if (cb && !callbackCalled) {
            cb(null);
            callbackCalled = true;
          }
        }

        if (text.includes('ERR Unable to establish connection') || text.includes('ERR Serve tunnel error') || text.includes('Failed to dial to edge')) {
          this.emit('status', { type: 'warning', message: 'Ошибка сети. Повтор...' });
        }
      });

      this.child.stdout.on('data', (data) => {
        const text = data.toString();
        logger.info(`[cloudflared-stdout] ${text.trim()}`);
      });

      this.child.on('close', (code) => {
        logger.info(`Процесс cloudflared завершился с кодом ${code}`);
        this.emit('status', { type: 'info', message: 'Не активен' });
        this.emit('close');
        if (cb && !callbackCalled) {
          cb(new Error(`Процесс завершился с кодом ${code}`));
        }
      });

      this.child.on('error', (err) => {
        logger.error(`Ошибка запуска процесса cloudflared: ${err.message}`);
        this.emit('status', { type: 'error', message: err.message });
        if (cb && !callbackCalled) {
          cb(err);
        }
      });
    } catch (err) {
      logger.error(`Не удалось запустить Cloudflare Tunnel: ${err.message}`);
      this.emit('status', { type: 'error', message: err.message });
      if (cb) cb(err);
    }
  }

  close() {
    this.closed = true;
    if (this.child) {
      try {
        this.child.kill();
        logger.info('Процесс cloudflared принудительно остановлен');
      } catch (e) {
        logger.error(`Ошибка при остановке процесса cloudflared: ${e.message}`);
      }
    }
    this.emit('status', { type: 'info', message: 'Не активен' });
    this.emit('close');
  }
}