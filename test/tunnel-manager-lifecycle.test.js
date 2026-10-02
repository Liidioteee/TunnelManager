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
