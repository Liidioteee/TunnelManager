import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkLocalPort } from '../lib/localPort.js';
import { listen, close, getClosedPort } from './helpers/fakeLocaltunnel.js';

test('открытый порт на 127.0.0.1 доступен по localhost и по адресу', async (t) => {
  const server = net.createServer();
  const port = await listen(server, '127.0.0.1');
  t.after(() => close(server));
  assert.equal(await checkLocalPort(port, 'localhost'), true);
  assert.equal(await checkLocalPort(port, '127.0.0.1'), true);
});

test('закрытый порт недоступен', async () => {
  const port = await getClosedPort();
  assert.equal(await checkLocalPort(port, 'localhost'), false);
  assert.equal(await checkLocalPort(port, '127.0.0.1'), false);
});

test('недоступный хост — false по тайм-ауту, без зависания', async () => {
  const started = Date.now();
  // 192.0.2.0/24 — TEST-NET-1, зарезервирован для документации и не маршрутизируется
  assert.equal(await checkLocalPort(80, '192.0.2.1', { timeout: 200 }), false);
  assert.ok(Date.now() - started < 3000);
});
