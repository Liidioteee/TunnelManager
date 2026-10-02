import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Tunnel from '../lib/Tunnel.js';
import TunnelCluster from '../lib/TunnelCluster.js';
import { startFakeApi, startTcp, getClosedPort } from './helpers/fakeLocaltunnel.js';

test('TunnelCluster: отказ удалённого сервера помечается кодом REMOTE_REFUSED', async () => {
  const cluster = new TunnelCluster({
    remote_ip: '127.0.0.1',
    remote_port: await getClosedPort(),
    local_port: 1
  });
  const errored = once(cluster, 'error');
  cluster.open();
  const [err] = await errored;
  cluster.close();
  assert.equal(err.code, 'REMOTE_REFUSED');
});

test('Tunnel переподключается при отказе туннельного порта, а не выбрасывает error', async (t) => {
  const closedPort = await getClosedPort();
  const live = await startTcp(t);
  const api = await startFakeApi(t, [
    { id: 'first', ip: '127.0.0.1', port: closedPort, max_conn_count: 1, url: 'https://first.loca.lt' },
    { id: 'second', ip: '127.0.0.1', port: live.port, max_conn_count: 1, url: 'https://second.loca.lt' }
  ]);

  const tunnel = new Tunnel({ host: api.host, port: 9, local_host: '127.0.0.1' });
  t.after(() => tunnel.close());

  const errors = [];
  tunnel.on('error', (err) => errors.push(err));

  await new Promise((resolve, reject) => tunnel.open(err => (err ? reject(err) : resolve())));
  assert.equal(tunnel.url, 'https://first.loca.lt');

  const [newUrl] = await once(tunnel, 'reconnected', { signal: AbortSignal.timeout(5000) });

  assert.deepEqual(errors, []);
  assert.equal(newUrl, 'https://second.loca.lt');
  assert.equal(tunnel.url, 'https://second.loca.lt');
  assert.equal(api.requests.length, 2);
});

test('недоступный сервер localtunnel — предупреждение о повторе, а не ошибка', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(503); res.end('<html>down</html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const tunnel = new Tunnel({ host: `http://127.0.0.1:${server.address().port}`, port: 9 });
  const statuses = [];
  tunnel.on('status', (s) => statuses.push(s));
  const opened = new Promise(resolve => tunnel.open(resolve));

  const retry = await new Promise(resolve => {
    const check = (s) => { if (/Повтор/.test(s.message)) resolve(s); };
    statuses.forEach(check);
    tunnel.on('status', check);
  });
  tunnel.close();
  await opened;

  assert.equal(retry.type, 'warning');
  assert.equal(retry.code, 'SERVER_RETRY');
  assert.ok(!statuses.some(s => s.type === 'error'), JSON.stringify(statuses));
});

test('сервер, приславший заголовки и замолчавший, не подвешивает запуск', async (t) => {
  const http = await import('node:http');
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"id":'); // тело так и не дописывается
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });

  const tunnel = new Tunnel({ host: `http://127.0.0.1:${server.address().port}`, port: 9, requestTimeout: 300 });
  t.after(() => tunnel.close());
  const retry = new Promise(resolve => tunnel.on('status', (s) => { if (s.code === 'SERVER_RETRY') resolve(s); }));
  tunnel.open(() => {});

  const status = await Promise.race([retry, new Promise(r => setTimeout(() => r(null), 3000))]);
  assert.ok(status, 'за 3 с нет повторной попытки — запрос завис на чтении тела');
});

function openResult(tunnel, timeoutMs = 3000) {
  return Promise.race([
    new Promise(resolve => tunnel.open(err => resolve(err || 'ok'))),
    new Promise(resolve => setTimeout(() => resolve('timeout'), timeoutMs))
  ]);
}

test('отказ сервера 4xx показывается ошибкой с текстом сервера, без бесконечных повторов', async (t) => {
  const api = await startFakeApi(t, [{
    status: 403,
    json: { message: 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.' }
  }]);
  const tunnel = new Tunnel({ host: api.host, port: 9, subdomain: 'ab' });
  t.after(() => tunnel.close());
  const statuses = [];
  tunnel.on('status', (s) => statuses.push(s));

  const err = await openResult(tunnel);
  assert.ok(err instanceof Error, `ожидалась ошибка, получено: ${err}`);
  assert.match(err.message, /Invalid subdomain/);
  assert.equal(api.requests.length, 1);
  assert.ok(statuses.some(s => s.type === 'error' && /Invalid subdomain/.test(s.message)));
});

test('некорректный ответ сервера (недопустимый адрес туннеля) — ошибка, а не повторы', async (t) => {
  const api = await startFakeApi(t, [{ id: 'x', ip: '127.0.0.1', port: 1, max_conn_count: 1, url: 'javascript:alert(1)' }]);
  const tunnel = new Tunnel({ host: api.host, port: 9 });
  t.after(() => tunnel.close());
  const err = await openResult(tunnel);
  assert.ok(err instanceof Error, `ожидалась ошибка, получено: ${err}`);
  assert.match(err.message, /недопустимый URL/);
  assert.equal(api.requests.length, 1);
});

for (const status of [429, 503]) {
  test(`ответ ${status} — временная проблема, клиент повторяет запрос`, async (t) => {
    const api = await startFakeApi(t, [{ status, json: { message: 'busy' } }]);
    const tunnel = new Tunnel({ host: api.host, port: 9 });
    t.after(() => tunnel.close());
    const retry = new Promise(resolve => tunnel.on('status', (s) => { if (s.code === 'SERVER_RETRY') resolve(s); }));
    tunnel.open(() => {});
    assert.equal((await retry).type, 'warning');
  });
}
