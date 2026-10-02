import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../lib/Logger.js';
import { makeTmpDir, waitFor } from './helpers/tmp.js';

beforeEach((t) => {
  // логгер дублирует каждую строку в консоль — в тестах это шум
  t.mock.method(console, 'log', () => {});
});

test('без configure логгер работает только в памяти', () => {
  const logger = new Logger();
  logger.info('hello');
  assert.equal(logger.logFile, '');
  assert.equal(logger.getRecentLogs().length, 1);
});

test('пишет строки с уровнем в файл в каталоге логов', async (t) => {
  const dir = path.join(makeTmpDir(t), 'logs');
  const logger = new Logger();
  logger.configure({ logDir: dir });
  logger.warn('something odd');

  assert.ok(fs.existsSync(dir), 'каталог логов создаётся автоматически');
  assert.match(path.basename(logger.logFile), /^app_.+\.log$/);
  await waitFor(() => fs.existsSync(logger.logFile)
    && fs.readFileSync(logger.logFile, 'utf8').includes('[WARN] something odd'));
});

test('хранит в памяти не больше maxRecentLogs записей', () => {
  const logger = new Logger();
  for (let i = 0; i < 250; i++) logger.info(`line ${i}`);
  const logs = logger.getRecentLogs();
  assert.equal(logs.length, 200);
  assert.equal(logs[0].message, 'line 50');
  assert.equal(logs.at(-1).level, 'INFO');
});

test('getRecentLogs возвращает копию, clearRecentLogs очищает память', () => {
  const logger = new Logger();
  logger.error('boom');
  logger.getRecentLogs().length = 0;
  assert.equal(logger.getRecentLogs().length, 1);
  logger.clearRecentLogs();
  assert.equal(logger.getRecentLogs().length, 0);
});

test('при старте оставляет не больше 4 старых лог-файлов', (t) => {
  const dir = makeTmpDir(t);
  for (let i = 0; i < 7; i++) {
    const file = path.join(dir, `app_old_${i}.log`);
    fs.writeFileSync(file, 'x');
    const time = new Date(Date.now() - (10 - i) * 60000);
    fs.utimesSync(file, time, time);
  }
  fs.writeFileSync(path.join(dir, 'other.txt'), 'не трогать');

  const logger = new Logger();
  logger.configure({ logDir: dir });
  logger.init();

  const remaining = fs.readdirSync(dir).filter(f => f.startsWith('app_')).sort();
  assert.deepEqual(remaining, ['app_old_3.log', 'app_old_4.log', 'app_old_5.log', 'app_old_6.log']);
  assert.ok(fs.existsSync(path.join(dir, 'other.txt')));
});

test('openFolder открывает каталог через переданную функцию', (t) => {
  const dir = makeTmpDir(t);
  const opened = [];
  const logger = new Logger();
  logger.configure({ logDir: dir, openPath: (p) => opened.push(p) });
  logger.openFolder();
  assert.deepEqual(opened, [dir]);
});

test('openFolder без configure ничего не делает', () => {
  assert.doesNotThrow(() => new Logger().openFolder());
});
