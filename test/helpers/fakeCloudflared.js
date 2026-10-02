import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Фейковый cloudflared — shell-скрипт; на Windows его нельзя запустить как .exe
export const fakeCloudflaredSkip = process.platform === 'win32'
  ? 'фейковый cloudflared — shell-скрипт'
  : false;

// Кладёт в каталог фейковый cloudflared вместе с файлом контрольной суммы,
// чтобы CFTunnel принял его за проверенный и недавно обновлённый бинарник
// (иначе он пошёл бы проверять обновления в настоящий GitHub)
export function installFakeCloudflared(dir, script, meta = {}) {
  const binPath = path.join(dir, 'cloudflared');
  fs.writeFileSync(binPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
  fs.writeFileSync(`${binPath}.sha256`, JSON.stringify({
    sha256, assetSha256: sha256, version: 'fake', checkedAt: Date.now(), ...meta
  }));
  return binPath;
}

// Фейковый cloudflared с эндпоинтом метрик: Node-скрипт поднимает HTTP-сервер
// на свободном порту и отдаёт cloudflared_tunnel_total_requests из файла
// requests (тест меняет число в файле). Печатает то же, что настоящий cloudflared.
export function installFakeCloudflaredWithMetrics(dir, { url = 'https://metrics-test.trycloudflare.com' } = {}) {
  const requestsFile = path.join(dir, 'requests');
  fs.writeFileSync(requestsFile, '0');
  const script = path.join(dir, 'fake-cloudflared.cjs');
  fs.writeFileSync(script, `
    const http = require('http');
    const fs = require('fs');
    const server = http.createServer((req, res) => {
      const total = fs.readFileSync(${JSON.stringify(requestsFile)}, 'utf8').trim();
      res.end('# HELP cloudflared_tunnel_total_requests Amount of requests proxied through all the tunnels\\n'
        + '# TYPE cloudflared_tunnel_total_requests counter\\n'
        + 'cloudflared_tunnel_total_requests ' + total + '\\n');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      process.stderr.write('INF Starting metrics server on 127.0.0.1:' + port + '/metrics\\n');
      process.stderr.write('INF |  ${url}  |\\n');
      process.stderr.write('INF Registered tunnel connection connIndex=0\\n');
    });
  `);
  // путь к node передаётся через окружение (в приложении это Electron)
  installFakeCloudflared(dir, `exec "$FAKE_CLOUDFLARED_NODE" "${script}"`);
  return { requestsFile };
}
