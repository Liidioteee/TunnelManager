// Запуск настоящего приложения для сквозных тестов и управление его окном
// через Chrome DevTools Protocol (CDP). Без сторонних зависимостей:
// WebSocket встроен в Node.js 22.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCH_TIMEOUT = 30000;

// E2E_APP_EXECUTABLE — путь к собранному приложению (electron-builder):
// тогда тесты проверяют именно сборку, с кодом внутри app.asar
const PACKAGED_APP = process.env.E2E_APP_EXECUTABLE || '';

function killProcessGroup(proc) {
  if (process.platform === 'win32') return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // группа уже пуста
  }
}

// Очистка в обратном порядке (как defer): t.after выполняет хуки в порядке
// регистрации, а папку данных можно удалять только после остановки
// приложения, которое в неё пишет
const cleanupStacks = new WeakMap();
function defer(t, fn) {
  let stack = cleanupStacks.get(t);
  if (!stack) {
    stack = [];
    cleanupStacks.set(t, stack);
    t.after(async () => {
      while (stack.length) await stack.pop()();
    });
  }
  stack.push(fn);
}

export function makeUserDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-e2e-'));
  // процессы Chromium (например, crashpad) могут ещё мгновение писать
  // в папку после остановки приложения — удаляем с повторами
  defer(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Минимальный CDP-клиент для одной вкладки
class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const handler = this.pending.get(msg.id);
      if (handler) {
        this.pending.delete(msg.id);
        handler(msg);
      }
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP: не удалось подключиться к окну')), { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Выполняет функцию в окне приложения; аргументы передаются через JSON
  async evaluate(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const msg = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (msg.error) throw new Error(`CDP: ${msg.error.message}`);
    if (msg.result.exceptionDetails) {
      const details = msg.result.exceptionDetails;
      throw new Error(`Ошибка в окне приложения: ${details.exception?.description || details.text}`);
    }
    return msg.result.result.value;
  }

  // Ждёт, пока функция в окне вернёт истинное значение, и возвращает его
  async waitFor(fn, args = [], { timeout = 10000, interval = 100, message = '' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(fn, ...args);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`Условие не выполнилось за ${timeout} мс${message ? `: ${message}` : ''}. Последнее значение: ${JSON.stringify(last)}`);
  }

  close() {
    this.ws.close();
  }
}

// Запускает приложение с отдельной папкой данных (настоящие данные
// пользователя не затрагиваются) и возвращает управление его окном
export async function launchApp(t, { userDataDir, env = {} } = {}) {
  const dataDir = userDataDir || makeUserDataDir(t);
  const args = [
    // В контейнерах и на CI песочница Chromium часто недоступна
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${dataDir}`,
    '--remote-debugging-port=0'
  ];
  const proc = spawn(PACKAGED_APP || electronPath, PACKAGED_APP ? args : [...args, APP_ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Своя группа процессов: при очистке убиваем и потомков приложения
    // (например, cloudflared), иначе они переживают тест и держат его вывод
    detached: process.platform !== 'win32'
  });

  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));

  const app = {
    proc,
    userDataDir: dataDir,
    page: null,
    output: () => output,
    exited,
    // Штатное завершение (SIGTERM → before-quit → выход)
    async quit({ timeout = 10000 } = {}) {
      if (app.page) app.page.close();
      if (proc.exitCode !== null || proc.signalCode !== null) return exited;
      proc.kill('SIGTERM');
      const result = await Promise.race([exited, sleep(timeout).then(() => null)]);
      if (!result) {
        proc.kill('SIGKILL');
        throw new Error(`Приложение не завершилось за ${timeout} мс после SIGTERM`);
      }
      return result;
    }
  };
  defer(t, async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exited;
    }
    killProcessGroup(proc);
  });

  // Порт отладки выбирает сам Electron (--remote-debugging-port=0)
  const deadline = Date.now() + LAUNCH_TIMEOUT;
  let port;
  while (!port) {
    const match = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) port = Number(match[1]);
    else if (proc.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Приложение не запустилось.\n${output}`);
    } else await sleep(50);
  }

  let target;
  while (!target) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find(item => item.type === 'page' && item.url.endsWith('/index.html'));
    } catch {
      // DevTools ещё не готов
    }
    if (!target) {
      if (Date.now() > deadline) throw new Error(`Окно приложения не появилось.\n${output}`);
      await sleep(100);
    }
  }

  app.page = new Page(target.webSocketDebuggerUrl);
  await app.page.connect();
  // Ждём загрузки интерфейса и первого списка туннелей
  await app.page.waitFor(() => document.readyState === 'complete' && !!window.api
    && !!document.querySelector('#tunnels-list').children.length, [], { timeout: LAUNCH_TIMEOUT });
  return app;
}
