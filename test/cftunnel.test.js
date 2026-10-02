import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import CFTunnel from '../lib/CFTunnel.js';

test('без binDir конструктор сообщает об ошибке', () => {
  assert.throws(() => new CFTunnel({ port: 3000 }), /binDir/);
});

test('бинарник и файл с хэшем лежат в переданном каталоге', () => {
  const t = new CFTunnel({ port: 3000, binDir: '/data/app' });
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  assert.equal(t.binPath, path.join('/data/app', exe));
  assert.equal(t.sidecarPath, `${t.binPath}.sha256`);
});

test('параметры по умолчанию', () => {
  const t = new CFTunnel({ port: '8080', binDir: '/tmp' });
  assert.equal(t.port, 8080);
  assert.equal(t.localHost, 'localhost');
  assert.equal(t.localProtocol, 'http');
  assert.equal(t.skipTlsVerify, true);
  assert.equal(t.closed, false);
});

test('_stripAnsi удаляет цветовые escape-последовательности', () => {
  const t = new CFTunnel({ port: 3000, binDir: '/tmp' });
  assert.equal(t._stripAnsi('\u001b[90m2026\u001b[0m \u001b[32mINF\u001b[0m ok'), '2026 INF ok');
});

test('_sanitizeLogText скрывает query string', () => {
  const t = new CFTunnel({ port: 3000, binDir: '/tmp' });
  assert.equal(
    t._sanitizeLogText('GET /cb?token=secret&x=1 done'),
    'GET /cb? done'
  );
});

test('open сообщает об отмене, если туннель закрыли во время подготовки бинарника', async (t) => {
  const tunnel = new CFTunnel({ port: 3000, binDir: '/tmp' });
  let finishEnsure;
  t.mock.method(tunnel, '_ensureBinary', () => new Promise(resolve => { finishEnsure = resolve; }));

  const result = new Promise(resolve => tunnel.open(resolve));
  tunnel.close();
  finishEnsure();

  const err = await Promise.race([result, new Promise(r => setTimeout(() => r('колбэк не вызван'), 500))]);
  assert.ok(err instanceof Error, String(err));
  assert.equal(tunnel.child, null, 'процесс cloudflared не запускается');
});

test('аргументы запуска: локальный адрес, протокол http2 и отключённое самообновление', () => {
  const tunnel = new CFTunnel({ port: 3000, binDir: '/tmp' });
  const args = tunnel._buildArgs();
  assert.deepEqual(args.slice(0, 3), ['tunnel', '--url', 'http://localhost:3000']);
  assert.ok(args.includes('--no-autoupdate'), 'cloudflared не должен обновлять сам себя');
  assert.deepEqual(args.slice(args.indexOf('--protocol'), args.indexOf('--protocol') + 2), ['--protocol', 'http2']);
  assert.ok(!args.includes('--no-tls-verify'));
});

test('аргументы запуска: HTTPS без проверки сертификата', () => {
  const tunnel = new CFTunnel({ port: 8443, binDir: '/tmp', localProtocol: 'https', localHost: '192.168.1.5' });
  const args = tunnel._buildArgs();
  assert.equal(args[2], 'https://192.168.1.5:8443');
  assert.ok(args.includes('--no-tls-verify'));
  const strict = new CFTunnel({ port: 8443, binDir: '/tmp', localProtocol: 'https', skipTlsVerify: false });
  assert.ok(!strict._buildArgs().includes('--no-tls-verify'));
});

test('аргументы запуска: IPv6-адрес берётся в квадратные скобки', () => {
  const tunnel = new CFTunnel({ port: 3000, binDir: '/tmp', localHost: '::1' });
  assert.equal(tunnel._buildArgs()[2], 'http://[::1]:3000');
  const full = new CFTunnel({ port: 80, binDir: '/tmp', localHost: 'fe80::1:2' });
  assert.equal(full._buildArgs()[2], 'http://[fe80::1:2]:80');
});
