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
