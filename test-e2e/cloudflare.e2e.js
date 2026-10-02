import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchApp, makeUserDataDir } from './helpers/app.js';
import { createTunnel, toggleTunnel, waitForCard, installFakeCloudflared } from './helpers/ui.js';
import { listen, close } from '../test/helpers/fakeLocaltunnel.js';
import { fakeCloudflaredSkip } from '../test/helpers/fakeCloudflared.js';

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
