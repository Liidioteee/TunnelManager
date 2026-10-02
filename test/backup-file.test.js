import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBackupFile, MAX_BACKUP_BYTES } from '../lib/backupFile.js';
import { makeTmpDir } from './helpers/tmp.js';

test('читает JSON из файла резервной копии', (t) => {
  const file = path.join(makeTmpDir(t), 'backup.json');
  fs.writeFileSync(file, JSON.stringify({ configs: [{ port: 80 }] }));
  assert.deepEqual(readBackupFile(file), { configs: [{ port: 80 }] });
});

test('слишком большой файл не читается', (t) => {
  const file = path.join(makeTmpDir(t), 'huge.json');
  fs.writeFileSync(file, Buffer.alloc(MAX_BACKUP_BYTES + 1, 0x20));
  assert.throws(() => readBackupFile(file), /слишком большой/);
});

test('не JSON — понятная ошибка', (t) => {
  const file = path.join(makeTmpDir(t), 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readBackupFile(file), /не является корректным JSON/);
});

test('JSON с BOM в начале читается', (t) => {
  const file = path.join(makeTmpDir(t), 'bom.json');
  fs.writeFileSync(file, '\uFEFF[{"port": 1}]');
  assert.deepEqual(readBackupFile(file), [{ port: 1 }]);
});
