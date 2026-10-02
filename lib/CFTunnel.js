import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import logger from './Logger.js';

const LATEST_RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';

const PLATFORM_ASSET = {
  win32: { x64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe' },
  linux: {
    arm64: 'cloudflared-linux-arm64',
    arm: 'cloudflared-linux-arm',
    x64: 'cloudflared-linux-amd64',
    ia32: 'cloudflared-linux-386'
  },
  darwin: { arm64: 'cloudflared-darwin-arm64.tgz', x64: 'cloudflared-darwin-amd64.tgz' }
};

// Сколько ждать первого подключения cloudflared к сети Cloudflare
const DEFAULT_START_TIMEOUT = 60000;

// Одна проверка бинарника на сессию приложения, общая для всех CF-туннелей
// с одним и тем же путём к бинарнику
const binaryEnsurePromises = new Map();

export default class CFTunnel extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.port = parseInt(opts.port, 10);
    this.localHost = opts.localHost || 'localhost';
    this.localProtocol = opts.localProtocol || 'http';
    this.skipTlsVerify = opts.skipTlsVerify !== false;
    this.startTimeout = opts.startTimeout || DEFAULT_START_TIMEOUT;
    this.closed = false;
    this.child = null;
    this.url = '';
    this.startTime = null;

    // Каталог для бинарника cloudflared передаётся снаружи (в приложении —
    // userData), чтобы модуль не зависел от electron
    if (!opts.binDir) {
      throw new Error('CFTunnel: не указан каталог для бинарного файла cloudflared (binDir)');
    }
    const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    this.binPath = path.join(opts.binDir, exeName);
    this.sidecarPath = `${this.binPath}.sha256`;
  }

  _stripAnsi(str) {
    // Регулярное выражение для удаления ANSI управляющих последовательностей
    // eslint-disable-next-line no-control-regex
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  }

  // Скрывает query string (там могут быть токены) из текста, попадающего в логи
  _sanitizeLogText(text) {
    return text.replace(/\?[^\s"']+/g, '?');
  }

  _localUrl() {
    // IPv6-адрес в URL записывается в квадратных скобках: http://[::1]:3000
    const host = net.isIPv6(this.localHost) ? `[${this.localHost}]` : this.localHost;
    return `${this.localProtocol}://${host}:${this.port}`;
  }

  // Аргументы cloudflared; третий элемент — адрес локального сервиса
  _buildArgs() {
    const args = [
      'tunnel', '--url', this._localUrl(),
      '--protocol', 'http2',
      // Бинарник проверяется по контрольной сумме и обновляется приложением;
      // самообновление cloudflared подменило бы файл и сломало эту проверку
      '--no-autoupdate'
    ];
    if (this.localProtocol === 'https' && this.skipTlsVerify) {
      args.push('--no-tls-verify');
    }
    return args;
  }

  _sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      const hash = crypto.createHash('sha256');
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  // Метаданные последнего релиза: официальный sha256-digest ассета и ссылка
  // на него из того же ответа — иначе между запросом суммы и скачиванием
  // мог выйти новый релиз, и суммы бы не совпали
  async _fetchReleaseAsset(assetName) {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { 'User-Agent': 'TunnelManager', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      throw new Error(`Не удалось получить метаданные релиза cloudflared (HTTP ${res.status})`);
    }
    const data = await res.json();
    const asset = (data.assets || []).find(a => a.name === assetName);
    const digest = asset && asset.digest;
    const match = typeof digest === 'string' ? digest.match(/^sha256:([0-9a-fA-F]{64})$/) : null;
    if (!match) {
      throw new Error(`Для ассета ${assetName} не удалось получить sha256-сумму`);
    }

    // Скачиваем только с github.com по https
    let downloadUrl;
    try {
      downloadUrl = new URL(asset.browser_download_url);
    } catch {
      downloadUrl = null;
    }
    if (!downloadUrl || downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com') {
      throw new Error(`Релиз cloudflared содержит недопустимый адрес для скачивания ${assetName}`);
    }

    return {
      sha256: match[1].toLowerCase(),
      downloadUrl: downloadUrl.href,
      version: typeof data.tag_name === 'string' ? data.tag_name : ''
    };
  }

  async _downloadAsset(downloadUrl, toPath) {
    const res = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(600000)
    });
    if (!res.ok) {
      throw new Error(`Не удалось скачать cloudflared (HTTP ${res.status})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(toPath, buffer);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  _extractTgz(tgzPath, destinationDir) {
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', path.basename(tgzPath)], { cwd: destinationDir });
      let stderr = '';
      tar.stderr.on('data', d => { stderr += d.toString(); });
      tar.on('error', reject);
      tar.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Не удалось распаковать архив cloudflared: ${stderr.trim()}`));
      });
    });
  }

  async _installVerifiedBinary(assetName) {
    const downloadPath = `${this.binPath}.download`;

    // Сначала официальный digest из метаданных релиза, затем сам бинарник;
    // несовпадение хэша — отказ в установке, файл удаляется
    const { sha256: expectedHash, downloadUrl } = await this._fetchReleaseAsset(assetName);

    const actualHash = await this._downloadAsset(downloadUrl, downloadPath);
    if (actualHash !== expectedHash) {
      try { fs.unlinkSync(downloadPath); } catch (e) {}
      throw new Error('Контрольная сумма скачанного cloudflared не совпадает — установка прервана');
    }

    if (process.platform === 'darwin') {
      await this._extractTgz(downloadPath, path.dirname(this.binPath));
      fs.unlinkSync(downloadPath);
      fs.renameSync(path.join(path.dirname(this.binPath), 'cloudflared'), this.binPath);
    } else {
      fs.renameSync(downloadPath, this.binPath);
    }

    if (process.platform !== 'win32') {
      fs.chmodSync(this.binPath, 0o755);
    }

    // Сохраняем хэш установленного бинарника: при следующих запусках
    // он сверяется и подменённый файл переустанавливается
    const finalHash = await this._sha256File(this.binPath);
    fs.writeFileSync(this.sidecarPath, `${finalHash}\n`, 'utf8');
    logger.info('Бинарный файл cloudflared установлен и проверен по официальной контрольной сумме.');
  }

  async _ensureBinary() {
    const cached = binaryEnsurePromises.get(this.binPath);
    if (cached) return cached;

    const promise = (async () => {
      const platformAssets = PLATFORM_ASSET[process.platform];
      const assetName = platformAssets && platformAssets[process.arch];
      if (!assetName) {
        throw new Error(`Неподдерживаемая платформа: ${process.platform}/${process.arch}`);
      }

      if (fs.existsSync(this.binPath)) {
        if (fs.existsSync(this.sidecarPath)) {
          const expected = fs.readFileSync(this.sidecarPath, 'utf8').trim().toLowerCase();
          const actual = await this._sha256File(this.binPath);
          if (expected && actual === expected) {
            return;
          }
          logger.warn('Целостность cloudflared нарушена (хэш не совпадает) — переустановка');
        } else {
          // бинарник от старой версии приложения без сохранённого хэша
          logger.warn('Отсутствует контрольная сумма cloudflared — переустановка с проверкой');
        }
        try { fs.unlinkSync(this.binPath); } catch (e) {}
        try { fs.unlinkSync(this.sidecarPath); } catch (e) {}
      }

      this.emit('status', { type: 'info', message: 'Скачивание cloudflared...' });
      logger.info('Бинарный файл не найден. Начинается скачивание...');
      await this._installVerifiedBinary(assetName);
    })().catch(err => {
      // сбрасываем кэш, чтобы следующая попытка могла повторить установку
      binaryEnsurePromises.delete(this.binPath);
      throw err;
    });

    binaryEnsurePromises.set(this.binPath, promise);
    return promise;
  }

  async open(cb) {
    this.emit('status', { type: 'info', message: 'Проверка бинарного файла Cloudflare...' });

    try {
      await this._ensureBinary();

      // Туннель закрыли, пока проверялся или скачивался бинарник: сообщаем
      // об отмене, иначе вызывающий код вечно ждал бы результата open()
      if (this.closed) {
        if (cb) cb(new Error('Запуск отменён: туннель закрыт'));
        return;
      }

      this.emit('status', { type: 'info', message: 'Запуск туннеля Cloudflare...' });
      const spawnArgs = this._buildArgs();
      logger.info(`Запуск Cloudflare Quick Tunnel для ${this._sanitizeLogText(spawnArgs[2])}...`);

      this.child = spawn(this.binPath, spawnArgs, {
        windowsHide: true
      });

      let callbackCalled = false;

      // cloudflared может так и не подключиться (заблокирована сеть,
      // недоступен Cloudflare) — не держим туннель в «Запуске» вечно
      const startTimer = setTimeout(() => {
        if (callbackCalled || this.closed) return;
        callbackCalled = true;
        const err = new Error(`cloudflared не подключился к Cloudflare за ${Math.round(this.startTimeout / 1000)} с`);
        logger.error(err.message);
        this.emit('status', { type: 'error', message: err.message });
        this._killChild();
        if (cb) cb(err);
      }, this.startTimeout);

      const handleOutput = (data) => {
        const rawText = data.toString();
        const text = this._stripAnsi(rawText);
        logger.info(`[cloudflared] ${this._sanitizeLogText(text).trim()}`);

        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match && !this.url) {
          this.url = match[0];
          logger.info(`Получена ссылка trycloudflare: ${this.url}`);
          this.emit('status', { type: 'info', message: 'Подключение к сети...' });
        }

        if (text.includes('Registered tunnel connection') || text.includes('Registered connection')) {
          this.emit('status', { type: 'success', message: 'Активен' });
          if (!callbackCalled) {
            callbackCalled = true;
            clearTimeout(startTimer);
            if (cb) cb(null);
          }
        }

        if (text.includes('ERR Unable to establish connection') || text.includes('ERR Serve tunnel error') || text.includes('Failed to dial to edge')) {
          this.emit('status', { type: 'warning', message: 'Ошибка сети. Повтор...' });
        }

        // Детекция входящих запросов в логах cloudflared
        const reqMatches = text.matchAll(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/gi);
        for (const reqMatch of reqMatches) {
          this.emit('request', {
            method: reqMatch[1].toUpperCase(),
            path: reqMatch[2].split('?')[0]
          });
        }
      };

      this.child.stderr.on('data', handleOutput);
      this.child.stdout.on('data', handleOutput);

      this.child.on('close', (code) => {
        clearTimeout(startTimer);
        logger.info(`Процесс cloudflared завершился с кодом ${code}`);
        if (!this.closed) {
          this.emit('status', { type: 'info', message: 'Не активен' });
          this.emit('close');
          if (cb && !callbackCalled) {
            callbackCalled = true;
            cb(new Error(`Процесс cloudflared завершился с кодом ${code}`));
          }
        }
      });

      this.child.on('error', (err) => {
        clearTimeout(startTimer);
        logger.error(`Ошибка запуска процесса cloudflared: ${err.message}`);
        if (!this.closed) {
          this.emit('status', { type: 'error', message: err.message });
          if (cb && !callbackCalled) {
            callbackCalled = true;
            cb(err);
          }
        }
      });
    } catch (err) {
      logger.error(`Не удалось запустить Cloudflare Tunnel: ${err.message}`);
      if (!this.closed) {
        this.emit('status', { type: 'error', message: err.message });
      }
      if (cb) cb(err);
    }
  }

  close() {
    this.closed = true;
    this._killChild();
    this.emit('status', { type: 'info', message: 'Не активен' });
    this.emit('close');
  }

  // Завершает процесс cloudflared (на Windows — вместе с деревом процессов)
  _killChild() {
    const child = this.child;
    this.child = null;
    if (child) {
      const pid = child.pid;
      try {
        if (process.platform === 'win32' && pid) {
          // Принудительное завершение дерева процессов на Windows
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          const fallbackKill = () => {
            try { child.kill('SIGKILL'); } catch (e) {}
          };
          killer.on('error', fallbackKill);
          killer.on('close', (code) => {
            if (code !== 0) fallbackKill();
          });
        } else {
          child.kill('SIGKILL');
        }
        logger.info(`Процесс cloudflared (PID: ${pid}) остановлен`);
      } catch (e) {
        logger.error(`Ошибка при остановке процесса cloudflared: ${e.message}`);
      }
    }
  }
}
