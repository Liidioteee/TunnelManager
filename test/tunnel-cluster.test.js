import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import TunnelCluster from '../lib/TunnelCluster.js';
import { startTcp } from './helpers/fakeLocaltunnel.js';
import { waitFor } from './helpers/tmp.js';

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

test('Host подменяется во всех запросах keep-alive соединения до локального сервера', async (t) => {
  const seenHosts = [];
  const localServer = http.createServer((req, res) => {
    seenHosts.push(req.headers.host);
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  // 127.0.0.2 — тоже loopback, но не «localhost», поэтому включается подмена Host
  await new Promise(resolve => localServer.listen(0, '0.0.0.0', resolve));
  t.after(() => new Promise(resolve => localServer.close(resolve)));

  const remote = await startTcp(t);
  const cluster = new TunnelCluster({
    remote_ip: '127.0.0.1',
    remote_port: remote.port,
    local_host: '127.0.0.2',
    local_port: localServer.address().port
  });
  t.after(() => cluster.close());

  const accepted = once(remote.server, 'connection');
  const localConnected = once(cluster, 'local-connect');
  cluster.open();
  const [serverSide] = await accepted;
  await localConnected;

  const body = 'x'.repeat(50);
  serverSide.write(
    'GET /1 HTTP/1.1\r\nHost: app.loca.lt\r\n\r\n'
    + `POST /2 HTTP/1.1\r\nHost: app.loca.lt\r\nContent-Length: ${body.length}\r\n\r\n${body}`
    + 'GET /3 HTTP/1.1\r\nHost: app.loca.lt\r\n\r\n'
  );

  await waitFor(() => seenHosts.length === 3);
  assert.deepEqual(seenHosts, ['127.0.0.2', '127.0.0.2', '127.0.0.2']);
});

test('после сброса локального соединения данные идут в новое соединение без зависания', async (t) => {
  let connections = 0;
  const received = [];
  const local = await startTcp(t, (socket) => {
    connections++;
    if (connections === 1) {
      // первое соединение локальный сервер сбрасывает сразу при получении данных
      socket.once('data', () => socket.resetAndDestroy());
    } else {
      socket.on('data', (d) => received.push(d));
    }
  });
  local.server.close(); // startTcp слушает 127.0.0.1 — перезапускаем на всех интерфейсах
  await new Promise(resolve => local.server.listen(local.port, '0.0.0.0', resolve));

  const remote = await startTcp(t);
  const cluster = new TunnelCluster({
    remote_ip: '127.0.0.1',
    remote_port: remote.port,
    local_host: '127.0.0.2',
    local_port: local.port
  });
  t.after(() => cluster.close());
  cluster.on('local-error', () => {});

  const accepted = once(remote.server, 'connection');
  cluster.open();
  const [serverSide] = await accepted;
  await once(cluster, 'local-connect');

  serverSide.write('GET /first HTTP/1.1\r\nHost: app.loca.lt\r\n\r\n');
  await once(cluster, 'local-error');
  await once(cluster, 'local-connect'); // повторное подключение через 1 с

  const body = 'y'.repeat(256 * 1024);
  const request = `POST /big HTTP/1.1\r\nHost: app.loca.lt\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
  serverSide.write(request);

  const expected = request.replace('app.loca.lt', '127.0.0.2');
  await waitFor(() => Buffer.concat(received).length >= expected.length, { timeout: 5000 });
  assert.equal(Buffer.concat(received).toString(), expected);
});
