import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import CFTunnel from '../lib/CFTunnel.js';
import { makeTmpDir, waitFor } from './helpers/tmp.js';
import { installFakeCloudflared, installFakeCloudflaredWithMetrics, fakeCloudflaredSkip } from './helpers/fakeCloudflared.js';

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

// Установленный бинарник + подменённый GitHub с «последним релизом»
function setupInstalled(t, { sidecar, release }) {
  const dir = makeTmpDir(t);
  const tunnel = new CFTunnel({ port: 1, binDir: dir });
  fs.writeFileSync(tunnel.binPath, 'installed binary');
  const sha = crypto.createHash('sha256').update('installed binary').digest('hex');
  fs.writeFileSync(tunnel.sidecarPath, typeof sidecar === 'function' ? sidecar(sha) : sidecar);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const href = String(input);
    requests.push(href);
    if (release instanceof Error) throw release;
    if (href.startsWith('https://api.github.com/')) {
      const digest = crypto.createHash('sha256').update(release.body).digest('hex');
      return new Response(JSON.stringify({
        tag_name: release.version,
        assets: [{
          name: PLATFORM_ASSET_NAME,
          digest: `sha256:${digest}`,
          browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/${release.version}/${PLATFORM_ASSET_NAME}`
        }]
      }), { status: 200 });
    }
    return new Response(release.body, { status: 200 });
  });
  return { tunnel, sha, requests };
}

const PLATFORM_ASSET_NAME = {
  win32: { x64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe' },
  linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' }
}[process.platform]?.[process.arch];
const updateSkip = PLATFORM_ASSET_NAME ? false : 'тест обновления рассчитан на Linux и Windows';
const DAY = 24 * 60 * 60 * 1000;

test('недавно проверенный бинарник используется без обращения к GitHub', { skip: updateSkip }, async (t) => {
  const { tunnel, requests } = setupInstalled(t, {
    sidecar: (sha) => JSON.stringify({ sha256: sha, assetSha256: sha, version: '2026.9.3', checkedAt: Date.now() - DAY }),
    release: { version: '2026.9.9', body: 'new binary' }
  });
  await tunnel._ensureBinary();
  assert.deepEqual(requests, []);
  assert.equal(fs.readFileSync(tunnel.binPath, 'utf8'), 'installed binary');
});

test('раз в неделю бинарник обновляется до нового релиза', { skip: updateSkip }, async (t) => {
  const { tunnel } = setupInstalled(t, {
    sidecar: (sha) => JSON.stringify({ sha256: sha, assetSha256: sha, version: '2026.1.0', checkedAt: Date.now() - 8 * DAY }),
    release: { version: '2026.9.9', body: 'new binary' }
  });
  await tunnel._ensureBinary();
  assert.equal(fs.readFileSync(tunnel.binPath, 'utf8'), 'new binary');
  const meta = JSON.parse(fs.readFileSync(tunnel.sidecarPath, 'utf8'));
  assert.equal(meta.version, '2026.9.9');
  assert.ok(Date.now() - meta.checkedAt < 60000);
});

test('если релиз не изменился, запоминается время проверки, файл не скачивается', { skip: updateSkip }, async (t) => {
  const { tunnel, requests } = setupInstalled(t, {
    sidecar: (sha) => JSON.stringify({ sha256: sha, assetSha256: sha, version: '2026.9.3', checkedAt: 0 }),
    release: { version: '2026.9.3', body: 'installed binary' }
  });
  await tunnel._ensureBinary();
  assert.equal(requests.length, 1, 'только запрос метаданных');
  assert.ok(Date.now() - JSON.parse(fs.readFileSync(tunnel.sidecarPath, 'utf8')).checkedAt < 60000);
});

test('без сети при проверке обновлений используется установленный бинарник', { skip: updateSkip }, async (t) => {
  const { tunnel } = setupInstalled(t, {
    sidecar: (sha) => JSON.stringify({ sha256: sha, assetSha256: sha, version: '2026.1.0', checkedAt: 0 }),
    release: new TypeError('fetch failed')
  });
  await tunnel._ensureBinary();
  assert.equal(fs.readFileSync(tunnel.binPath, 'utf8'), 'installed binary');
});

test('старый формат файла контрольной суммы (только хэш) по-прежнему принимается', { skip: updateSkip }, async (t) => {
  const { tunnel } = setupInstalled(t, {
    sidecar: (sha) => `${sha}\n`,
    release: { version: '2026.9.3', body: 'installed binary' }
  });
  await tunnel._ensureBinary();
  assert.equal(fs.readFileSync(tunnel.binPath, 'utf8'), 'installed binary');
  assert.equal(JSON.parse(fs.readFileSync(tunnel.sidecarPath, 'utf8')).version, '2026.9.3');
});

test('close останавливает процесс cloudflared', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  const pidFile = path.join(dir, 'pid');
  installFakeCloudflared(dir, [
    `echo $$ > "${pidFile}"`,
    'echo "INF |  https://close-test.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0" >&2',
    'exec sleep 30'
  ].join('\n'));

  const tunnel = new CFTunnel({ port: 1, binDir: dir });
  const err = await new Promise(resolve => tunnel.open(resolve));
  assert.equal(err, null, `open завершился ошибкой: ${err && err.message}`);
  assert.equal(tunnel.url, 'https://close-test.trycloudflare.com');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(isAlive(pid), `cloudflared (pid ${pid}) должен работать до close()`);

  tunnel.close();
  await waitFor(() => !isAlive(pid), { timeout: 5000 }).catch(() => {
    throw new Error(`cloudflared (pid ${pid}) жив через 5 с после close(); `
      + `надзиратель: exitCode=${tunnel.child ? tunnel.child.exitCode : 'отсоединён'}`);
  });
});

test('_parseTotalRequests читает счётчик запросов из метрик Prometheus', () => {
  const tunnel = new CFTunnel({ port: 1, binDir: '/tmp' });
  const text = [
    '# HELP cloudflared_tunnel_total_requests Amount of requests proxied through all the tunnels',
    '# TYPE cloudflared_tunnel_total_requests counter',
    'cloudflared_tunnel_total_requests 42',
    'cloudflared_tunnel_request_errors 3'
  ].join('\n');
  assert.equal(tunnel._parseTotalRequests(text), 42);
  assert.equal(tunnel._parseTotalRequests('cloudflared_tunnel_total_requests 1.5e+06'), 1500000);
  assert.equal(tunnel._parseTotalRequests('something_else 1'), null);
});

test('аргументы запуска: метрики на свободном порту localhost', () => {
  const args = new CFTunnel({ port: 3000, binDir: '/tmp' })._buildArgs();
  assert.deepEqual(args.slice(args.indexOf('--metrics'), args.indexOf('--metrics') + 2), ['--metrics', '127.0.0.1:0']);
});

test('строки лога с GET/POST не считаются запросами', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  installFakeCloudflared(dir, [
    'echo "INF |  https://words.trycloudflare.com  |" >&2',
    'echo "INF Registered tunnel connection connIndex=0" >&2',
    'echo "INF budget output for GET /api and POST /x" >&2',
    'exec sleep 30'
  ].join('\n'));
  const tunnel = new CFTunnel({ port: 1, binDir: dir });
  t.after(() => tunnel.close());
  const requests = [];
  tunnel.on('request', (r) => requests.push(r));
  tunnel.on('requests', (n) => requests.push(n));
  await new Promise(resolve => tunnel.open(resolve));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(requests, []);
});

test('число запросов берётся из метрик cloudflared и передаётся приращениями', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  const { requestsFile } = installFakeCloudflaredWithMetrics(dir);
  process.env.FAKE_CLOUDFLARED_NODE = process.execPath;
  const tunnel = new CFTunnel({ port: 1, binDir: dir, metricsInterval: 50 });
  t.after(() => tunnel.close());
  const increments = [];
  tunnel.on('requests', (n) => increments.push(n));

  assert.equal(await new Promise(resolve => tunnel.open(resolve)), null);
  fs.writeFileSync(requestsFile, '3');
  await waitFor(() => increments.reduce((a, b) => a + b, 0) === 3);
  fs.writeFileSync(requestsFile, '5');
  await waitFor(() => increments.reduce((a, b) => a + b, 0) === 5);
  assert.ok(increments.every(n => n > 0));
});

test('при завершении cloudflared до подключения в ошибке указана его причина', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  installFakeCloudflared(dir, [
    'echo "2026-10-02T16:47:42Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
    'echo "quick tunnel provisioning failed with status 429" >&2',
    'exit 1'
  ].join('\n'));
  const tunnel = new CFTunnel({ port: 1, binDir: dir });
  const err = await new Promise(resolve => tunnel.open(resolve));
  assert.match(err.message, /кодом 1/);
  assert.match(err.message, /quick tunnel provisioning failed with status 429/);
});

test('строка ERR из лога cloudflared попадает в текст ошибки без даты', { skip: fakeCloudflaredSkip }, async (t) => {
  const dir = makeTmpDir(t);
  installFakeCloudflared(dir, 'echo "2026-10-02T16:47:42Z ERR Failed to fetch features error=\\"timeout\\"" >&2\nexit 1');
  const tunnel = new CFTunnel({ port: 1, binDir: dir });
  const err = await new Promise(resolve => tunnel.open(resolve));
  assert.match(err.message, /: ERR Failed to fetch features error="timeout"$/);
});
