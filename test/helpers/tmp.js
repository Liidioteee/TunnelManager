import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Временный каталог, который удаляется после теста
export function makeTmpDir(t, prefix = 'tm-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('waitFor: условие не выполнено за отведённое время');
}
