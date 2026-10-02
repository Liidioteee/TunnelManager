import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfigInput, parseLocaltunnelServer } from '../lib/configValidation.js';

const base = { name: 'API', port: '3000' };

test('корректная конфигурация нормализуется', () => {
  assert.deepEqual(
    sanitizeConfigInput({
      name: '  Backend  ',
      port: 8080,
      subdomain: 'My-App',
      provider: 'cf',
      localHost: ' Docker.Local ',
      localProtocol: 'https',
      skipTlsVerify: false
    }),
    {
      name: 'Backend',
      port: '8080',
      subdomain: 'my-app',
      provider: 'cf',
      localHost: 'docker.local',
      localProtocol: 'https',
      skipTlsVerify: false
    }
  );
});

test('значения по умолчанию', () => {
  assert.deepEqual(sanitizeConfigInput({ port: '3000' }), {
    name: 'Порт 3000',
    port: '3000',
    subdomain: '',
    provider: 'lt',
    localHost: 'localhost',
    localProtocol: 'http',
    skipTlsVerify: true
  });
});

test('порт вне диапазона 1..65535 или не число отклоняется', () => {
  for (const port of [0, -1, 65536, '', 'abc', undefined, null]) {
    assert.equal(sanitizeConfigInput({ ...base, port }), null, `port=${port}`);
  }
});

test('граничные значения порта принимаются', () => {
  assert.equal(sanitizeConfigInput({ ...base, port: 1 }).port, '1');
  assert.equal(sanitizeConfigInput({ ...base, port: '65535' }).port, '65535');
});

test('хосты: hostname, IPv4, IPv6 принимаются', () => {
  for (const localHost of ['localhost', '192.168.1.50', 'my-host.lan', '::1']) {
    assert.equal(sanitizeConfigInput({ ...base, localHost }).localHost, localHost);
  }
});

test('хосты с пробелами, слэшами, управляющими символами отклоняются', () => {
  for (const localHost of ['evil host', 'a/b', 'host\r\nX: y', 'user@host', 'a'.repeat(254)]) {
    assert.equal(sanitizeConfigInput({ ...base, localHost }), null, JSON.stringify(localHost));
  }
});

test('пустой хост превращается в localhost', () => {
  assert.equal(sanitizeConfigInput({ ...base, localHost: '   ' }).localHost, 'localhost');
});

test('неизвестные провайдер и протокол заменяются значениями по умолчанию', () => {
  const safe = sanitizeConfigInput({ ...base, provider: 'ngrok', localProtocol: 'ftp' });
  assert.equal(safe.provider, 'lt');
  assert.equal(safe.localProtocol, 'http');
});

test('субдомен очищается от недопустимых символов и крайних дефисов', () => {
  assert.equal(sanitizeConfigInput({ ...base, subdomain: '--My_App!!--' }).subdomain, 'myapp');
  assert.equal(sanitizeConfigInput({ ...base, subdomain: 'a'.repeat(100) }).subdomain.length, 63);
});

test('имя обрезается до 60 символов', () => {
  assert.equal(sanitizeConfigInput({ ...base, name: 'x'.repeat(100) }).name.length, 60);
});

test('лишние поля из импорта не попадают в результат', () => {
  const safe = sanitizeConfigInput({ ...base, id: 'evil', active: true, url: 'javascript:1', __proto__x: 1 });
  assert.deepEqual(Object.keys(safe).sort(), [
    'localHost', 'localProtocol', 'name', 'port', 'provider', 'skipTlsVerify', 'subdomain'
  ]);
});

test('skipTlsVerify отключается только явным false', () => {
  assert.equal(sanitizeConfigInput({ ...base, skipTlsVerify: 'false' }).skipTlsVerify, true);
  assert.equal(sanitizeConfigInput({ ...base, skipTlsVerify: false }).skipTlsVerify, false);
});

test('parseLocaltunnelServer принимает http(s)-адрес сервера и возвращает origin', () => {
  assert.equal(parseLocaltunnelServer('https://lt.example.com'), 'https://lt.example.com');
  assert.equal(parseLocaltunnelServer(' http://127.0.0.1:3000/ '), 'http://127.0.0.1:3000');
});

test('parseLocaltunnelServer отклоняет пустые и некорректные значения', () => {
  for (const value of [undefined, '', '   ', 'loca.lt', 'ftp://lt.example.com', 'javascript:alert(1)',
    'https://user:pass@lt.example.com', 'https://lt.example.com/path', 'https://lt.example.com/?x=1']) {
    assert.equal(parseLocaltunnelServer(value), null, String(value));
  }
});
