import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, waitFor } from './helpers/tmp.js';

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cloudflaredSupervisor.cjs');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// «cloudflared» — Node-скрипт: записывает свой pid, печатает строку и работает до остановки
function fakeChildArgs(pidFile) {
  return [process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`
    + `process.stderr.write('child started\\n'); setInterval(() => {}, 1000);`];
}

test('надзиратель передаёт вывод процесса и завершается вместе с ним', async (t) => {
  const pidFile = path.join(makeTmpDir(t), 'pid');
  const sup = spawn(process.execPath, [SUPERVISOR, ...fakeChildArgs(pidFile)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => sup.kill('SIGKILL'));
  let stderr = '';
  sup.stderr.on('data', (d) => { stderr += d; });

  await waitFor(() => stderr.includes('child started'));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(childPid, 'SIGKILL'); // процесс «cloudflared» упал

  const [code] = await new Promise(resolve => sup.once('exit', (...args) => resolve(args)));
  assert.notEqual(code, 0);
});

test('закрытие stdin надзирателя останавливает процесс', async (t) => {
  const pidFile = path.join(makeTmpDir(t), 'pid');
  const sup = spawn(process.execPath, [SUPERVISOR, ...fakeChildArgs(pidFile)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => sup.kill('SIGKILL'));
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'));
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));

  sup.stdin.end();

  await waitFor(() => !isAlive(childPid), { timeout: 5000 });
  await waitFor(() => sup.exitCode !== null || sup.signalCode !== null, { timeout: 5000 });
});

test('если приложение убито, надзиратель останавливает процесс', async (t) => {
  const dir = makeTmpDir(t);
  const pidFile = path.join(dir, 'pid');
  // «приложение» запускает надзирателя и висит; мы убиваем его через SIGKILL
  const appScript = `
    const { spawn } = require('child_process');
    spawn(process.execPath, ${JSON.stringify([SUPERVISOR, ...fakeChildArgs(pidFile)])}, { stdio: ['pipe', 'ignore', 'ignore'] });
    setInterval(() => {}, 1000);`;
  const app = spawn(process.execPath, ['-e', appScript], { stdio: 'ignore' });
  t.after(() => { try { app.kill('SIGKILL'); } catch {} });
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), { timeout: 5000 });
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });

  app.kill('SIGKILL');

  await waitFor(() => !isAlive(childPid), { timeout: 5000 });
});

test('ошибка запуска процесса сообщается в stderr и кодом выхода', async () => {
  const sup = spawn(process.execPath, [SUPERVISOR, path.join('nonexistent', 'cloudflared')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  sup.stderr.on('data', (d) => { stderr += d; });
  const [code] = await new Promise(resolve => sup.once('exit', (...args) => resolve(args)));
  assert.equal(code, 127);
  assert.match(stderr, /ENOENT/);
});

// Регрессия: приложение шлёт SIGTERM, едва увидев первые строки cloudflared.
// Раньше надзиратель регистрировал обработчики сигналов после запуска процесса,
// и ранний сигнал завершал его, оставляя cloudflared сиротой
test('SIGTERM сразу после первых строк процесса останавливает процесс', { skip: process.platform === 'win32' }, async (t) => {
  const dir = makeTmpDir(t);
  for (let i = 0; i < 20; i++) {
    const pidFile = path.join(dir, `pid-${i}`);
    const script = `echo $$ > "${pidFile}"; echo started >&2; exec sleep 30`;
    const sup = spawn(process.execPath, [SUPERVISOR, '/bin/sh', '-c', script], { stdio: ['pipe', 'ignore', 'pipe'] });
    t.after(() => sup.kill('SIGKILL'));
    await new Promise(resolve => sup.stderr.once('data', resolve));
    sup.kill('SIGTERM');

    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });
    await waitFor(() => !isAlive(childPid), { timeout: 5000 });
  }
});
