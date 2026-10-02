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
