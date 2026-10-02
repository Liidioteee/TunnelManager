// Подключает хуки из .githooks к локальному git-репозиторию.
// Запускается из `npm install` (prepare); вне git-репозитория (например,
// при установке из архива) молча ничего не делает.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

if (fs.existsSync('.git')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch {
    console.warn('Не удалось подключить git-хуки: git недоступен');
  }
}
