import { test } from 'node:test';
import assert from 'node:assert/strict';
import Tunnel from '../lib/Tunnel.js';

function makeTunnel(opts = {}) {
  return new Tunnel({ port: 3000, local_host: 'localhost', ...opts });
}

const validBody = {
  id: 'my-app',
  ip: '1.2.3.4',
  port: 41234,
  url: 'https://my-app.loca.lt',
  max_conn_count: 10
};

test('по умолчанию используется сервер https://loca.lt', () => {
  assert.equal(makeTunnel().opts.host, 'https://loca.lt');
});

test('субдомен нормализуется в конструкторе', () => {
  const t = makeTunnel({ subdomain: '  My_App!  ' });
  assert.equal(t.opts.subdomain, 'my-app');
});

test('_getInfo собирает параметры подключения из ответа сервера', () => {
  const info = makeTunnel()._getInfo(validBody);
  assert.equal(info.name, 'my-app');
  assert.equal(info.url, 'https://my-app.loca.lt');
  assert.equal(info.remote_host, 'loca.lt');
  assert.equal(info.remote_ip, '1.2.3.4');
  assert.equal(info.remote_port, 41234);
  assert.equal(info.local_port, 3000);
  assert.equal(info.max_conn, 10);
});

test('_getInfo: max_conn по умолчанию равен 1', () => {
  const info = makeTunnel()._getInfo({ ...validBody, max_conn_count: undefined });
  assert.equal(info.max_conn, 1);
});

test('_getInfo отклоняет URL туннеля с недопустимой схемой', () => {
  const t = makeTunnel();
  assert.throws(() => t._getInfo({ ...validBody, url: 'javascript:alert(1)' }), /недопустимый URL/);
  assert.throws(() => t._getInfo({ ...validBody, url: undefined }), /недопустимый URL/);
});

test('_getInfo отклоняет cached_url с недопустимой схемой', () => {
  assert.throws(
    () => makeTunnel()._getInfo({ ...validBody, cached_url: 'file:///etc/passwd' }),
    /cached_url/
  );
});

test('_getInfo отклоняет некорректный локальный порт', () => {
  assert.throws(() => makeTunnel({ port: '3000' })._getInfo(validBody), /локальный порт/);
  assert.throws(() => makeTunnel({ port: 70000 })._getInfo(validBody), /локальный порт/);
});

test('_getInfo ограничивает число соединений от недоверенного сервера', () => {
  const t = makeTunnel();
  assert.equal(t._getInfo({ ...validBody, max_conn_count: 100000 }).max_conn, 10);
  assert.equal(t._getInfo({ ...validBody, max_conn_count: 3 }).max_conn, 3);
});

test('_getInfo: некорректное max_conn_count заменяется на 1', () => {
  const t = makeTunnel();
  for (const max_conn_count of [0, -5, 2.5, 'abc', '10', null, Infinity]) {
    assert.equal(t._getInfo({ ...validBody, max_conn_count }).max_conn, 1, String(max_conn_count));
  }
});
