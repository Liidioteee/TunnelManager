import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkLocalPort } from '../lib/localPort.js';
import { listen, close, getClosedPort } from './helpers/fakeLocaltunnel.js';

async function ipv6Available() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '::1', resolve));
    await close(server);
    return true;
  } catch {
    return false;
  }
}

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

test('сервер только на ::1 считается доступным по localhost', async (t) => {
  if (!(await ipv6Available())) {
    t.skip('IPv6 недоступен в этой среде');
    return;
  }
  const server = net.createServer();
  const port = await listen(server, '::1');
  t.after(() => close(server));
  assert.equal(await checkLocalPort(port, 'localhost'), true);
  assert.equal(await checkLocalPort(port, '::1'), true);
});

test('недоступный хост — false по тайм-ауту, без зависания', async () => {
  const started = Date.now();
  // 192.0.2.0/24 — TEST-NET-1, зарезервирован для документации и не маршрутизируется
  assert.equal(await checkLocalPort(80, '192.0.2.1', { timeout: 200 }), false);
  assert.ok(Date.now() - started < 3000);
});

test('для localhost проверяются и 127.0.0.1, и ::1', async (t) => {
  const hosts = [];
  t.mock.method(net.Socket.prototype, 'connect', function (port, host) {
    hosts.push(host);
    setImmediate(() => this.emit('error', new Error('ECONNREFUSED')));
    return this;
  });
  assert.equal(await checkLocalPort(3000, 'localhost'), false);
  assert.deepEqual(hosts.sort(), ['127.0.0.1', '::1']);
});
