import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import Tunnel from '../lib/Tunnel.js';
import { startFakeApi, startTcp, getClosedPort } from './helpers/fakeLocaltunnel.js';
import { waitFor } from './helpers/tmp.js';

test('после сбросов соединений их число остаётся равным max_conn', async (t) => {
  const remote = await startTcp(t);
  const local = await startTcp(t);
  const api = await startFakeApi(t, [
    { id: 'app', ip: '127.0.0.1', port: remote.port, max_conn_count: 2, url: 'https://app.loca.lt' }
  ]);

  const tunnel = new Tunnel({ host: api.host, port: local.port, local_host: '127.0.0.1' });
  t.after(() => tunnel.close());
  tunnel.on('error', () => {});

  await new Promise((resolve, reject) => tunnel.open(err => (err ? reject(err) : resolve())));
  await waitFor(() => remote.sockets.size === 2);

  for (let round = 0; round < 3; round++) {
    for (const socket of [...remote.sockets]) socket.resetAndDestroy();
    await waitFor(() => remote.sockets.size === 2, { timeout: 3000 });
  }
  await sleep(1000); // замены открываются через 500 мс — ждём возможные лишние

  assert.equal(remote.sockets.size, 2);
});

test('недоступный локальный порт сообщается статусом с кодом LOCAL_PORT_CLOSED', async (t) => {
  const remote = await startTcp(t);
  const api = await startFakeApi(t, [
    { id: 'app', ip: '127.0.0.1', port: remote.port, max_conn_count: 1, url: 'https://app.loca.lt' }
  ]);
  const tunnel = new Tunnel({ host: api.host, port: await getClosedPort(), local_host: '127.0.0.1' });
  t.after(() => tunnel.close());

  const statuses = [];
  tunnel.on('status', (s) => statuses.push(s));
  await new Promise((resolve, reject) => tunnel.open(err => (err ? reject(err) : resolve())));
  await waitFor(() => statuses.some(s => s.code === 'LOCAL_PORT_CLOSED'));

  const status = statuses.find(s => s.code === 'LOCAL_PORT_CLOSED');
  assert.equal(status.type, 'warning');
});
