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

  // 4 самых новых старых файла + текущий, открытый при инициализации
  const remaining = fs.readdirSync(dir).filter(f => f.startsWith('app_old_')).sort();
  assert.deepEqual(remaining, ['app_old_3.log', 'app_old_4.log', 'app_old_5.log', 'app_old_6.log']);
  assert.ok(fs.existsSync(logger.logFile));
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('app_')).length, 5);
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

test('строки попадают в файл сразу и в порядке записи', (t) => {
  const dir = makeTmpDir(t);
  const logger = new Logger();
  logger.configure({ logDir: dir });
  for (let i = 0; i < 2000; i++) logger.info(`line ${i}`);

  const lines = fs.readFileSync(logger.logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2000);
  lines.forEach((line, i) => assert.ok(line.endsWith(`] [INFO] line ${i}`), line));
});

test('большой лог делится на файлы ограниченного размера, старые удаляются', (t) => {
  const dir = makeTmpDir(t);
  const logger = new Logger();
  logger.configure({ logDir: dir, maxFileSize: 2000, maxFiles: 3 });
  for (let i = 0; i < 300; i++) logger.info(`message number ${i}`);

  const files = fs.readdirSync(dir).filter(f => f.startsWith('app_') && f.endsWith('.log'));
  assert.equal(files.length, 3);
  for (const f of files) {
    assert.ok(fs.statSync(path.join(dir, f)).size <= 2000, `${f} больше лимита`);
  }
  const current = fs.readFileSync(logger.logFile, 'utf8');
  assert.match(current, /message number 299\n$/);
  const all = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!all.includes('message number 0\n'), 'самые старые строки удалены вместе со старыми файлами');
});

test('ошибка записи в файл не ломает логирование в память', (t) => {
  const dir = makeTmpDir(t);
  const logger = new Logger();
  logger.configure({ logDir: path.join(dir, 'file-not-dir') });
  fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x'); // каталог создать нельзя
  t.mock.method(console, 'error', () => {});
  assert.doesNotThrow(() => logger.info('still works'));
  assert.equal(logger.getRecentLogs().at(-1).message, 'still works');
});
