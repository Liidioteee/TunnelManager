import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import CFTunnel from '../lib/CFTunnel.js';
import { makeTmpDir, waitFor } from './helpers/tmp.js';
import { installFakeCloudflared, fakeCloudflaredSkip } from './helpers/fakeCloudflared.js';

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

test('проверка бинарника кэшируется отдельно для каждого пути', { skip: fakeCloudflaredSkip }, async (t) => {
  const good = makeTmpDir(t);
  installFakeCloudflared(good, 'exit 0');
  const broken = makeTmpDir(t);
  installFakeCloudflared(broken, 'exit 0');
  fs.writeFileSync(path.join(broken, 'cloudflared.sha256'), '0'.repeat(64)); // подменённый бинарник

  await new CFTunnel({ port: 1, binDir: good })._ensureBinary();

  const other = new CFTunnel({ port: 1, binDir: broken });
  const install = t.mock.method(other, '_installVerifiedBinary', async () => {});
  await other._ensureBinary();
  assert.equal(install.mock.callCount(), 1, 'бинарник в другом каталоге проверяется и переустанавливается');
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('если cloudflared не подключился за отведённое время — ошибка и остановка процесса', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  const pidFile = path.join(dir, 'pid');
  installFakeCloudflared(dir, `echo $$ > "${pidFile}"\nexec sleep 30`);

  const tunnel = new CFTunnel({ port: 1, binDir: dir, startTimeout: 300 });
  t.after(() => tunnel.close());
  const statuses = [];
  tunnel.on('status', (s) => statuses.push(s));

  const err = await new Promise(resolve => tunnel.open(resolve));

  assert.match(String(err && err.message), /не подключился/);
  assert.ok(statuses.some(s => s.type === 'error' && /не подключился/.test(s.message)));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !isAlive(pid));
});

// Ответы «GitHub» для установки cloudflared: метаданные релиза и сам файл
function mockGithub(t, { assetUrl, body = Buffer.from('fake cloudflared binary'), digest } = {}) {
  const tunnel = new CFTunnel({ port: 1, binDir: makeTmpDir(t) });
  const assetName = 'cloudflared-test-asset';
  const sha = digest || crypto.createHash('sha256').update(body).digest('hex');
  const url = assetUrl || `https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/${assetName}`;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const href = String(input);
    requested.push(href);
    if (href.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        tag_name: '2026.9.3',
        assets: [{ name: assetName, digest: `sha256:${sha}`, browser_download_url: url }]
      }), { status: 200 });
    }
    return new Response(body, { status: 200 });
  });
  return { tunnel, assetName, requested, url };
}

test('бинарник скачивается по ссылке из того же ответа API, что и контрольная сумма', async (t) => {
  const { tunnel, assetName, requested, url } = mockGithub(t);
  await tunnel._installVerifiedBinary(assetName);

  assert.equal(requested.length, 2);
  assert.equal(requested[1], url, 'файл берётся из конкретного релиза, а не latest/download');
  assert.equal(fs.readFileSync(tunnel.binPath, 'utf8'), 'fake cloudflared binary');
});

test('ссылка на бинарник вне github.com отклоняется', async (t) => {
  const { tunnel, assetName, requested } = mockGithub(t, { assetUrl: 'https://evil.example.com/cloudflared' });
  await assert.rejects(tunnel._installVerifiedBinary(assetName), /недопустимый адрес/);
  assert.equal(requested.length, 1, 'файл не скачивается');
  assert.ok(!fs.existsSync(tunnel.binPath));
});

test('бинарник с неверной контрольной суммой не устанавливается', async (t) => {
  const { tunnel, assetName } = mockGithub(t, { digest: 'a'.repeat(64) });
  await assert.rejects(tunnel._installVerifiedBinary(assetName), /не совпадает/);
  assert.ok(!fs.existsSync(tunnel.binPath));
  assert.ok(!fs.existsSync(`${tunnel.binPath}.download`));
});
