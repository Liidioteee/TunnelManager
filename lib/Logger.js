import fs from 'fs';
import path from 'path';

// Модуль не зависит от electron: каталог логов и способ открыть его
// передаются из main-процесса через configure(), что позволяет
// использовать и тестировать логгер в обычном Node.js
// Строки пишутся синхронно в заранее открытый файл: порядок гарантирован,
// и при падении приложения последние строки не теряются (именно они нужны
// для разбора падения). Файл ограничен по размеру; при превышении
// начинается новый, хранится не больше maxFiles файлов.
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export class Logger {
  constructor() {
    this.initialized = false;
    this.logDir = '';
    this.openPath = null;
    this.logFile = '';
    this.fd = null;
    this.fileSize = 0;
    this.fileSeq = 0;
    this.maxFileSize = DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = DEFAULT_MAX_FILES;
    this.recentLogs = [];
    this.maxRecentLogs = 200;
  }

  configure({ logDir, openPath, maxFileSize, maxFiles } = {}) {
    this.logDir = logDir || '';
    this.openPath = typeof openPath === 'function' ? openPath : null;
    if (maxFileSize > 0) this.maxFileSize = maxFileSize;
    if (maxFiles > 0) this.maxFiles = maxFiles;
  }

  init() {
    if (this.initialized || !this.logDir) return;
    this.initialized = true;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this._openNewFile();
    } catch (err) {
      console.error('Ошибка инициализации Logger:', err);
    }
  }

  _logFiles() {
    return fs.readdirSync(this.logDir)
      .filter(f => f.startsWith('app_') && f.endsWith('.log'))
      .map(f => {
        const filePath = path.join(this.logDir, f);
        return { name: f, filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      // новые первыми; при одинаковом времени — по имени (в нём дата и номер)
      .sort((a, b) => (b.mtime - a.mtime) || b.name.localeCompare(a.name));
  }

  // Закрывает текущий файл, удаляет лишние старые и открывает новый
  _openNewFile() {
    this._closeFile();
    for (const file of this._logFiles().slice(this.maxFiles - 1)) {
      try {
        fs.unlinkSync(file.filePath);
      } catch (e) {
        console.error('Ошибка при удалении старого лог-файла:', e);
      }
    }
    const dateStr = new Date().toISOString().replace('T', '_').substring(0, 19).replace(/:/g, '-');
    this.fileSeq++;
    const suffix = this.fileSeq > 1 ? `_${String(this.fileSeq).padStart(3, '0')}` : '';
    this.logFile = path.join(this.logDir, `app_${dateStr}${suffix}.log`);
    this.fd = fs.openSync(this.logFile, 'a');
    this.fileSize = fs.fstatSync(this.fd).size;
  }

  _closeFile() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // файл уже закрыт
      }
      this.fd = null;
    }
  }

  _writeToFile(line) {
    if (this.fd === null) return;
    try {
      const data = Buffer.from(line, 'utf8');
      if (this.fileSize > 0 && this.fileSize + data.length > this.maxFileSize) {
        this._openNewFile();
      }
      fs.writeSync(this.fd, data);
      this.fileSize += data.length;
    } catch (err) {
      console.error('Ошибка записи лога:', err);
    }
  }

  log(level, message) {
    this.init();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const upperLevel = level.toUpperCase();
    const logLine = `[${timestamp}] [${upperLevel}] ${message}\n`;

    this.recentLogs.push({
      timestamp,
      level: upperLevel,
      message: String(message)
    });
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs.shift();
    }

    this._writeToFile(logLine);
    console.log(logLine.trim());
  }

  close() {
    this._closeFile();
  }

  info(message) {
    this.log('info', message);
  }

  warn(message) {
    this.log('warn', message);
  }

  error(message) {
    this.log('error', message);
  }

  getRecentLogs() {
    return [...this.recentLogs];
  }

  clearRecentLogs() {
    this.recentLogs = [];
  }

  openFolder() {
    this.init();
    if (this.logDir && this.openPath) {
      this.openPath(this.logDir);
    }
  }
}

export default new Logger();