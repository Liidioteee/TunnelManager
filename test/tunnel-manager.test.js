import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, makeConfig, flush } from './helpers/fakeManagerDeps.js';

test('addConfig сохраняет очищенную конфигурацию в неактивном состоянии', () => {
  const { manager, store } = makeManager();
  const list = manager.addConfig({ name: ' Site ', port: '8080', subdomain: 'My-App', id: 'evil', active: true });
  const [saved] = store.get('configs');
  assert.equal(saved.name, 'Site');
  assert.equal(saved.subdomain, 'my-app');
  assert.equal(saved.active, false);
  assert.equal(saved.url, '');
  assert.notEqual(saved.id, 'evil');
  assert.deepEqual(list[0].status, { type: 'info', message: 'Не активен' });
});

test('addConfig отклоняет некорректную конфигурацию', () => {
  const { manager, store } = makeManager();
  assert.throws(() => manager.addConfig({ port: 0 }), /Порт должен быть числом от 1 до 65535/);
  assert.deepEqual(store.get('configs'), []);
});

test('успешный запуск: active, url, уведомление, статус «Активен»', async () => {
  const { manager, tunnels, storedConfig, notifications, lastStatus } = makeManager({ configs: [makeConfig()] });
  const started = manager.start('c1');
  assert.deepEqual(lastStatus(), { type: 'info', message: 'Не активен' }); // в хранилище ещё не active
  tunnels[0].succeed('https://api.loca.lt');
  assert.equal(await started, 'https://api.loca.lt');
  await flush();

  assert.equal(storedConfig().active, true);
  assert.equal(storedConfig().url, 'https://api.loca.lt');
  assert.deepEqual(notifications, [{ title: 'Туннель запущен', body: 'API: https://api.loca.lt' }]);
  assert.deepEqual(manager.getConfigsWithStatuses()[0].status, { type: 'success', message: 'Активен' });
});

test('повторный start во время запуска не создаёт второй туннель', () => {
  const { manager, tunnels } = makeManager({ configs: [makeConfig()] });
  manager.start('c1');
  manager.start('c1');
  assert.equal(tunnels.length, 1);
});

test('ошибка запуска: active сбрасывается, статус ошибки, промис отклоняется', async () => {
  const { manager, tunnels, storedConfig } = makeManager({ configs: [makeConfig({ active: true })] });
  const started = manager.start('c1');
  tunnels[0].fail(new Error('нет сети'));
  await assert.rejects(started, /нет сети/);
  assert.equal(storedConfig().active, false);
  assert.equal(manager.tunnelStates.c1.connectionState, 'error');
  assert.equal(manager.tunnelStates.c1.connectionMessage, 'Ошибка: нет сети');
});

test('остановка во время запуска отменяет запуск без ошибки', async () => {
  const { manager, tunnels, storedConfig } = makeManager({ configs: [makeConfig({ active: true })] });
  const started = manager.start('c1');
  manager.stop('c1');
  assert.equal(await started, undefined);
  assert.equal(tunnels[0].closed, true);
  assert.equal(storedConfig().active, false);
  assert.equal(manager.tunnelStates.c1.connectionState, 'stopped');
});

test('stop закрывает туннель и сбрасывает active и url', async () => {
  const { manager, tunnels, storedConfig } = makeManager({ configs: [makeConfig()] });
  const started = manager.start('c1');
  tunnels[0].succeed();
  await started;
  manager.stop('c1');
  assert.equal(tunnels[0].closed, true);
  assert.equal(storedConfig().active, false);
  assert.equal(storedConfig().url, '');
  assert.deepEqual(manager.getUptimes(), {});
});

test('закрытый локальный порт после подключения даёт предупреждение', async () => {
  const { manager, tunnels } = makeManager({ configs: [makeConfig()], portOpen: false });
  const started = manager.start('c1');
  tunnels[0].succeed();
  await started;
  await flush();
  assert.deepEqual(manager.getConfigsWithStatuses()[0].status,
    { type: 'warning', message: 'Локальный порт 3000 недоступен' });
});

test('checkPorts отслеживает открытие и закрытие локального порта', async () => {
  const { manager, tunnels, deps, lastStatus } = makeManager({ configs: [makeConfig()] });
  const started = manager.start('c1');
  tunnels[0].succeed();
  await started;
  await flush();

  deps.portOpen = false;
  await manager.checkPorts();
  assert.equal(lastStatus().type, 'warning');

  deps.portOpen = true;
  await manager.checkPorts();
  assert.deepEqual(lastStatus(), { type: 'success', message: 'Активен' });
});

test('событие error туннеля не роняет процесс', async () => {
  const { manager, tunnels } = makeManager({ configs: [makeConfig()] });
  manager.start('c1');
  assert.doesNotThrow(() => tunnels[0].emit('error', new Error('socket hang up')));
});

test('после переподключения сохраняется новый адрес туннеля', async () => {
  const { manager, tunnels, storedConfig, events } = makeManager({ configs: [makeConfig()] });
  const started = manager.start('c1');
  tunnels[0].succeed('https://old.loca.lt');
  await started;
  const before = events.configs.length;

  tunnels[0].emit('reconnected', 'https://new.loca.lt');
  assert.equal(storedConfig().url, 'https://new.loca.lt');
  assert.equal(events.configs.length, before + 1);
});

test('статистика запросов: только известные методы и путь без query string', () => {
  const { manager, events } = makeManager();
  manager.handleRequest('c1', { method: 'get', path: '/api?token=secret' });
  assert.equal(events['request-stats'].at(-1).stats.lastMethod, 'GET');
  assert.equal(events['request-stats'].at(-1).stats.lastPath, '/api');

  manager.handleRequest('c1', { method: '<script>', path: '/x' });
  const { stats } = events['request-stats'].at(-1);
  assert.equal(stats.count, 2);
  assert.equal(stats.lastMethod, 'REQ');
});

test('getUptimes считает секунды с момента запуска', async () => {
  const { manager, tunnels } = makeManager({ configs: [makeConfig()] });
  const started = manager.start('c1');
  tunnels[0].succeed();
  await started;
  tunnels[0].startTime = 1_000;
  assert.deepEqual(manager.getUptimes(62_500), { c1: 61 });
});

test('toggle включает и выключает туннель', async () => {
  const { manager, tunnels, storedConfig } = makeManager({ configs: [makeConfig()] });
  manager.toggle('c1', true);
  assert.equal(storedConfig().active, true);
  tunnels[0].succeed();
  await flush();
  manager.toggle('c1', false);
  assert.equal(tunnels[0].closed, true);
  assert.equal(storedConfig().active, false);
});

test('deleteConfig останавливает туннель и удаляет конфигурацию', async () => {
  const { manager, tunnels, store } = makeManager({ configs: [makeConfig(), makeConfig({ id: 'c2' })] });
  manager.start('c1');
  manager.deleteConfig('c1');
  assert.equal(tunnels[0].closed, true);
  assert.deepEqual(store.get('configs').map(c => c.id), ['c2']);
});

test('batchToggle и batchDelete работают с несколькими конфигурациями', async () => {
  const configs = [makeConfig(), makeConfig({ id: 'c2' }), makeConfig({ id: 'c3' })];
  const { manager, tunnels, store } = makeManager({ configs });
  manager.batchToggle(['c1', 'c2'], true);
  assert.deepEqual(tunnels.map(t => t.config.id), ['c1', 'c2']);
  manager.batchDelete(['c1', 'c3']);
  assert.deepEqual(store.get('configs').map(c => c.id), ['c2']);
  assert.equal(tunnels[0].closed, true);
});

test('restoreActive запускает туннели, активные в хранилище', () => {
  const configs = [makeConfig({ active: true }), makeConfig({ id: 'c2' })];
  const { manager, tunnels } = makeManager({ configs });
  manager.restoreActive();
  assert.deepEqual(tunnels.map(t => t.config.id), ['c1']);
});

test('exportData содержит только пользовательские поля', () => {
  const { manager } = makeManager({ configs: [makeConfig({ active: true, url: 'https://x.loca.lt' })] });
  const data = manager.exportData('9.9.9');
  assert.equal(data.version, '9.9.9');
  assert.deepEqual(Object.keys(data.configs[0]).sort(),
    ['localHost', 'localProtocol', 'name', 'port', 'provider', 'skipTlsVerify', 'subdomain']);
});

test('importConfigs добавляет корректные записи и пропускает некорректные', () => {
  const { manager, store } = makeManager({ configs: [makeConfig()] });
  const res = manager.importConfigs({ configs: [{ port: 80, active: true }, { port: 'bad' }] });
  assert.equal(res.success, true);
  assert.equal(res.count, 1);
  assert.equal(res.skipped, 1);
  const imported = store.get('configs')[1];
  assert.equal(imported.port, '80');
  assert.equal(imported.active, false);
});

test('importConfigs без корректных записей ничего не меняет', () => {
  const { manager, store } = makeManager();
  assert.equal(manager.importConfigs([]).success, false);
  assert.equal(manager.importConfigs([{ port: -1 }]).success, false);
  assert.deepEqual(store.get('configs'), []);
});

test('число запросов от Cloudflare накапливается и не обнуляется при перезапуске туннеля', async () => {
  const { manager, tunnels, events } = makeManager({ configs: [makeConfig({ provider: 'cf' })] });
  manager.toggle('c1', true);
  tunnels[0].succeed();
  await flush();

  tunnels[0].emit('requests', 3);
  manager.stop('c1');
  manager.toggle('c1', true);
  tunnels[1].succeed();
  await flush();
  tunnels[1].emit('requests', 2);
  tunnels[1].emit('requests', 0);   // некорректные значения игнорируются
  tunnels[1].emit('requests', -1);

  const { stats } = events['request-stats'].at(-1);
  assert.equal(stats.count, 5);
  assert.equal(stats.lastPath, '');
  assert.equal(events['request-stats'].length, 2);
});

test('importConfigs пропускает null и другие не-объекты, не прерывая импорт', () => {
  const { manager, store } = makeManager();
  const res = manager.importConfigs({ configs: [null, 5, 'x', { port: 8080 }] });
  assert.equal(res.success, true);
  assert.equal(res.count, 1);
  assert.equal(res.skipped, 3);
  assert.equal(store.get('configs')[0].port, '8080');
});

test('importConfigs: файл с null или не тем типом в корне — понятная ошибка', () => {
  const { manager } = makeManager();
  for (const parsed of [null, 42, 'text', { configs: 'nope' }]) {
    const res = manager.importConfigs(parsed);
    assert.equal(res.success, false, JSON.stringify(parsed));
    assert.match(res.error, /не содержит корректных конфигураций/);
  }
});

test('addConfig и updateConfig сообщают конкретную причину отказа', () => {
  const { manager } = makeManager({ configs: [makeConfig()] });
  assert.throws(() => manager.addConfig({ port: 80, subdomain: 'ab' }), /Субдомен/);
  assert.throws(() => manager.updateConfig({ id: 'c1', port: 99999 }), /Порт/);
});

test('toggle принимает только булево состояние и существующий туннель', () => {
  const { manager, store, tunnels } = makeManager({ configs: [makeConfig()] });
  for (const state of ['true', 1, null, undefined, {}]) {
    assert.throws(() => manager.toggle('c1', state), /состояние/, String(state));
  }
  assert.throws(() => manager.toggle('missing', true), /не найден/);
  assert.throws(() => manager.toggle({ id: 'c1' }, true), /не найден/);
  assert.equal(store.get('configs')[0].active, false);
  assert.equal(tunnels.length, 0);
});

test('batchToggle и batchDelete проверяют список и пропускают неизвестные id', () => {
  const configs = [makeConfig(), makeConfig({ id: 'c2' })];
  const { manager, store, tunnels } = makeManager({ configs });
  for (const ids of ['c1', null, 5, { 0: 'c1' }, [1, 2]]) {
    assert.throws(() => manager.batchToggle(ids, true), /список/, JSON.stringify(ids));
    assert.throws(() => manager.batchDelete(ids), /список/, JSON.stringify(ids));
  }
  assert.throws(() => manager.batchToggle(['c1'], 'yes'), /состояние/);

  manager.batchToggle(['c1', 'c1', 'missing'], true);
  assert.deepEqual(tunnels.map(t => t.config.id), ['c1'], 'повторы и неизвестные id не запускаются');
  manager.batchDelete(['missing', 'c2']);
  assert.deepEqual(store.get('configs').map(c => c.id), ['c1']);
});

test('deleteConfig: некорректный id — ошибка, хранилище не меняется', () => {
  const { manager, store } = makeManager({ configs: [makeConfig()] });
  assert.throws(() => manager.deleteConfig(null), /не найден/);
  assert.equal(store.get('configs').length, 1);
});

test('importConfigs: не больше 1000 записей за раз', () => {
  const { manager, store } = makeManager();
  const res = manager.importConfigs(Array.from({ length: 1001 }, (_, i) => ({ port: 1000 + i })));
  assert.equal(res.success, false);
  assert.match(res.error, /не больше 1000/);
  assert.deepEqual(store.get('configs'), []);
});
