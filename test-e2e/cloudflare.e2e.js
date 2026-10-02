import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchApp, makeUserDataDir } from './helpers/app.js';
import { createTunnel, toggleTunnel, waitForCard, installFakeCloudflared } from './helpers/ui.js';
import { listen, close } from '../test/helpers/fakeLocaltunnel.js';
import { fakeCloudflaredSkip, installFakeCloudflaredWithMetrics } from '../test/helpers/fakeCloudflared.js';

const skip = fakeCloudflaredSkip;

test('Cloudflare: туннель запускается и показывает адрес trycloudflare', { skip }, async (t) => {
  const local = http.createServer((req, res) => res.end('ok'));
  const port = await listen(local);
  t.after(() => close(local));

  const userDataDir = makeUserDataDir(t);
  // Печатает в stderr то же, что настоящий cloudflared, и работает до остановки
  installFakeCloudflared(userDataDir, [
    'echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
    'echo "INF |  https://fake-e2e-tunnel.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0 location=e2e protocol=http2" >&2',
    'exec sleep 600'
  ].join('\n'));

  const app = await launchApp(t, { userDataDir });
  const id = await createTunnel(app.page, { name: 'CF app', port, provider: 'cf' });
  await toggleTunnel(app.page, id);

  const info = await waitForCard(app.page, id, c => c.statusText === 'Активен', { message: 'CF-туннель активен' });
  assert.equal(info.switchOn, true);
  assert.equal(info.url, 'https://fake-e2e-tunnel.trycloudflare.com');
  assert.match(info.meta, /Порт:/);
});

test('Cloudflare: причина неудачного запуска остаётся на карточке', { skip }, async (t) => {
  const userDataDir = makeUserDataDir(t);
  installFakeCloudflared(userDataDir, 'echo "ERR failed to start" >&2\nexit 1');

  const app = await launchApp(t, { userDataDir });
  const id = await createTunnel(app.page, { name: 'CF broken', port: 3000, provider: 'cf' });
  await toggleTunnel(app.page, id);

  const info = await waitForCard(app.page, id, c => c.statusType === 'error', { message: 'ошибка запуска' });
  assert.match(info.statusText, /завершился с кодом 1/);
  assert.equal(info.switchOn, false);

  // ошибка не сменяется на «Не активен» через секунду
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await waitForCard(app.page, id, Boolean)).statusType, 'error');
});

test('Cloudflare: упавший процесс перезапускается, туннель остаётся включённым', { skip }, async (t) => {
  const local = http.createServer((req, res) => res.end('ok'));
  const port = await listen(local);
  t.after(() => close(local));

  const userDataDir = makeUserDataDir(t);
  // Первый запуск подключается и через секунду падает, второй работает
  installFakeCloudflared(userDataDir, [
    'COUNT_FILE="$(dirname "$0")/fake-runs"',
    'n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$COUNT_FILE"',
    'echo "INF |  https://run$n.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0" >&2',
    'if [ "$n" = 1 ]; then sleep 1; exit 1; fi',
    'exec sleep 600'
  ].join('\n'));

  const app = await launchApp(t, { userDataDir });
  const id = await createTunnel(app.page, { name: 'CF crash', port, provider: 'cf' });
  await toggleTunnel(app.page, id);
  await waitForCard(app.page, id, c => c.url === 'https://run1.trycloudflare.com', { message: 'первый запуск' });

  const restarting = await waitForCard(app.page, id, c => /Перезапуск/.test(c.statusText), { message: 'ожидание перезапуска' });
  assert.equal(restarting.switchOn, true);
  assert.equal(restarting.statusType, 'warning');

  const info = await waitForCard(app.page, id, c => c.url === 'https://run2.trycloudflare.com' && c.statusText === 'Активен',
    { message: 'после перезапуска' });
  assert.equal(info.switchOn, true);
});

test('Cloudflare: если приложение аварийно завершилось, cloudflared не остаётся работать', { skip }, async (t) => {
  const local = http.createServer((req, res) => res.end('ok'));
  const port = await listen(local);
  t.after(() => close(local));

  const userDataDir = makeUserDataDir(t);
  const pidFile = path.join(userDataDir, 'fake-cloudflared.pid');
  installFakeCloudflared(userDataDir, [
    `echo $$ > "${pidFile}"`,
    'echo "INF |  https://orphan-test.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0" >&2',
    'exec sleep 600'
  ].join('\n'));

  const app = await launchApp(t, { userDataDir });
  const id = await createTunnel(app.page, { name: 'CF orphan', port, provider: 'cf' });
  await toggleTunnel(app.page, id);
  await waitForCard(app.page, id, c => c.statusText === 'Активен');
  const cloudflaredPid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(cloudflaredPid, 'SIGKILL'); } catch {} });

  // Аварийное завершение: SIGKILL только главному процессу Electron,
  // без штатного выхода и без очистки группы процессов
  app.proc.kill('SIGKILL');
  await app.exited;

  const deadline = Date.now() + 5000;
  while (isAlive(cloudflaredPid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(cloudflaredPid), false, 'cloudflared должен завершиться вместе с приложением');
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Cloudflare: число запросов берётся из метрик cloudflared', { skip }, async (t) => {
  const local = http.createServer((req, res) => res.end('ok'));
  const port = await listen(local);
  t.after(() => close(local));

  const userDataDir = makeUserDataDir(t);
  const { requestsFile } = installFakeCloudflaredWithMetrics(userDataDir);
  const app = await launchApp(t, { userDataDir, env: { FAKE_CLOUDFLARED_NODE: process.execPath } });
  const id = await createTunnel(app.page, { name: 'CF metrics', port, provider: 'cf' });
  await toggleTunnel(app.page, id);
  await waitForCard(app.page, id, c => c.statusText === 'Активен');

  fs.writeFileSync(requestsFile, '3');
  const info = await waitForCard(app.page, id, c => c.requests === '3 req', { message: 'счётчик из метрик' });
  assert.equal(info.lastRequest, 'Запросов через туннель: 3');
});
