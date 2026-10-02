import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, makeConfig, flush } from './helpers/fakeManagerDeps.js';

async function startRunning(ctx, id = 'c1') {
  const started = ctx.manager.start(id);
  ctx.tunnels.at(-1).succeed();
  await started;
  await flush();
  return ctx.tunnels.at(-1);
}

test('stop сохраняет конфигурацию и рассылает список ровно один раз', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  await startRunning(ctx);
  const writes = ctx.store.writes;
  const broadcasts = ctx.events.configs.length;

  ctx.manager.stop('c1');

  assert.equal(ctx.store.writes - writes, 1);
  assert.equal(ctx.events.configs.length - broadcasts, 1);
});

test('close от старого экземпляра не останавливает новый туннель', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const first = await startRunning(ctx);
  ctx.manager.stop('c1');
  const second = await startRunning(ctx);

  first.emit('close'); // запоздалое событие от уже остановленного туннеля

  assert.equal(second.closed, false);
  assert.equal(ctx.manager.activeTunnels.c1, second);
  assert.equal(ctx.storedConfig().active, true);
});

test('самопроизвольное закрытие туннеля останавливает его в менеджере', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const tunnel = await startRunning(ctx);
  tunnel.emit('close');
  assert.equal(ctx.manager.activeTunnels.c1, undefined);
  assert.equal(ctx.manager.tunnelStates.c1.connectionState, 'stopped');
});

test('после выхода из приложения активные туннели восстанавливаются при следующем запуске', async () => {
  const configs = [makeConfig(), makeConfig({ id: 'c2' }), makeConfig({ id: 'c3' })];
  const ctx = makeManager({ configs });
  await startRunning(ctx, 'c1');
  ctx.manager.toggle('c2', true); // пользователь включил, туннель ещё подключается

  ctx.manager.shutdown();
  await flush();

  assert.ok(ctx.tunnels.every(t => t.closed), 'все туннели закрыты');
  assert.deepEqual(ctx.store.get('configs').map(c => c.active), [true, true, false]);

  // следующий запуск приложения с тем же хранилищем
  const next = makeManager({ configs: ctx.store.get('configs') });
  next.manager.restoreActive();
  assert.deepEqual(next.tunnels.map(t => t.config.id), ['c1', 'c2']);
});

test('после shutdown туннели больше не запускаются', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.shutdown();
  ctx.manager.start('c1');
  ctx.manager.restoreActive();
  assert.equal(ctx.tunnels.length, 0);
});

test('недоступный локальный порт распознаётся по коду статуса, а не по тексту', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const tunnel = await startRunning(ctx);

  tunnel.emit('status', { type: 'warning', code: 'LOCAL_PORT_CLOSED', message: 'Local port unavailable' });
  assert.deepEqual(ctx.lastStatus(), { type: 'warning', message: 'Локальный порт 3000 недоступен' });

  tunnel.emit('status', { type: 'success', message: 'Активен' });
  await flush();
  tunnel.emit('status', { type: 'warning', message: 'Локальный порт — просто текст, без кода' });
  assert.equal(ctx.manager.tunnelStates.c1.localPortState, 'open');
  assert.equal(ctx.manager.tunnelStates.c1.connectionState, 'retrying');
});

test('устаревший результат проверки порта не перезаписывает более свежий статус', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const tunnel = await startRunning(ctx);

  // проверка порта «зависает», пока тест её не завершит
  let finishCheck;
  ctx.deps.checkLocalPort = () => new Promise(resolve => { finishCheck = resolve; });

  tunnel.emit('status', { type: 'success', message: 'Активен' });        // запускает проверку порта
  tunnel.emit('status', { type: 'warning', code: 'LOCAL_PORT_CLOSED', message: 'x' }); // свежее событие
  assert.equal(ctx.lastStatus().type, 'warning');

  finishCheck(true); // запоздалый ответ «порт открыт» от первой проверки
  await flush();

  assert.equal(ctx.lastStatus().type, 'warning');
  assert.equal(ctx.manager.tunnelStates.c1.localPortState, 'closed');
});

test('проверка порта, завершившаяся после остановки, не меняет статус', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const tunnel = await startRunning(ctx);
  let finishCheck;
  ctx.deps.checkLocalPort = () => new Promise(resolve => { finishCheck = resolve; });

  tunnel.emit('status', { type: 'success', message: 'Активен' });
  ctx.manager.stop('c1');
  const statusesAfterStop = ctx.events.status.length;

  finishCheck(false);
  await flush();

  assert.equal(ctx.events.status.length, statusesAfterStop);
  assert.equal(ctx.manager.tunnelStates.c1.connectionState, 'stopped');
});

test('периодическая проверка порта не затирает статус, пришедший во время проверки', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  const tunnel = await startRunning(ctx);
  let finishCheck;
  ctx.deps.checkLocalPort = () => new Promise(resolve => { finishCheck = resolve; });

  const checking = ctx.manager.checkPorts();
  tunnel.emit('status', { type: 'warning', code: 'LOCAL_PORT_CLOSED', message: 'x' });
  finishCheck(true);
  await checking;

  assert.equal(ctx.manager.tunnelStates.c1.localPortState, 'closed');
  assert.equal(ctx.lastStatus().type, 'warning');
});

test('повторные попытки подключения показываются предупреждением, туннель остаётся включённым', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].emit('status', { type: 'warning', code: 'SERVER_RETRY', message: 'Сервер недоступен. Повтор через 2с...' });

  assert.deepEqual(ctx.lastStatus(), { type: 'warning', message: 'Сервер недоступен. Повтор через 2с...' });
  assert.equal(ctx.storedConfig().active, true);
  assert.equal(ctx.tunnels[0].closed, false);
});
