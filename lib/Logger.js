import fs from 'fs';
import path from 'path';
import { app, shell } from 'electron';

class Logger {
  constructor() {
    this.initialized = false;
    this.logDir = '';
    this.logFile = '';
  }

  init() {
    if (this.initialized) return;
    this.logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    const files = fs.readdirSync(this.logDir)
      .filter(f => f.startsWith('app_') && f.endsWith('.log'))
      .map(f => ({ name: f, filePath: path.join(this.logDir, f), stat: fs.statSync(path.join(this.logDir, f)) }))
      .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

    if (files.length >= 5) {
      const toDelete = files.slice(4);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.filePath);
        } catch (e) {
          console.error(e);
        }
      }
    }

    const now = new Date();
    const dateStr = now.toISOString().replace('T', '_').substring(0, 19).replace(/:/g, '-');
    this.logFile = path.join(this.logDir, `app_${dateStr}.log`);
    this.initialized = true;
  }

  log(level, message) {
    this.init();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    fs.appendFileSync(this.logFile, logLine, 'utf8');
    console.log(logLine.trim());
  }

  info(message) {
    this.log('info', message);
  }

  error(message) {
    this.log('error', message);
  }

  openFolder() {
    this.init();
    shell.openPath(this.logDir);
  }
}

export default new Logger();