import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import TunnelCluster from '../lib/TunnelCluster.js';
import { startTcp } from './helpers/fakeLocaltunnel.js';

async function openConnectedCluster(t) {
  const remote = await startTcp(t);
  const local = await startTcp(t);
  const cluster = new TunnelCluster({
    remote_ip: '127.0.0.1',
    remote_port: remote.port,
    local_host: '127.0.0.1',
    local_port: local.port
  });
  t.after(() => cluster.close());

  const localConnected = once(cluster, 'local-connect');
  const remoteAccepted = once(remote.server, 'connection');
  cluster.open();
  const [serverSide] = await remoteAccepted;
  await localConnected;
  return { cluster, serverSide };
}

test('сброс соединения сервером порождает ровно одно событие dead', async (t) => {
  const { cluster, serverSide } = await openConnectedCluster(t);
  let dead = 0;
  cluster.on('dead', () => dead++);
  cluster.on('error', () => {});

  serverSide.resetAndDestroy();
  await once(cluster, 'dead');
  await sleep(100); // даём дойти возможному повторному событию

  assert.equal(dead, 1);
});

test('штатное закрытие соединения сервером порождает ровно одно событие dead', async (t) => {
  const { cluster, serverSide } = await openConnectedCluster(t);
  let dead = 0;
  cluster.on('dead', () => dead++);

  serverSide.end();
  await once(cluster, 'dead');
  await sleep(100);

  assert.equal(dead, 1);
});
