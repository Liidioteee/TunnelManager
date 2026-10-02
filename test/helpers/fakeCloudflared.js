import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Фейковый cloudflared — shell-скрипт; на Windows его нельзя запустить как .exe
export const fakeCloudflaredSkip = process.platform === 'win32'
  ? 'фейковый cloudflared — shell-скрипт'
  : false;

// Кладёт в каталог фейковый cloudflared вместе с файлом контрольной суммы,
// чтобы CFTunnel принял его за проверенный бинарник
export function installFakeCloudflared(dir, script) {
  const binPath = path.join(dir, 'cloudflared');
  fs.writeFileSync(binPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
  fs.writeFileSync(`${binPath}.sha256`, `${hash}\n`);
  return binPath;
}
