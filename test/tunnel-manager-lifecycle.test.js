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

test('после неожиданного завершения туннель перезапускается и остаётся включённым', async () => {
  const ctx = makeManager({ configs: [makeConfig()], restartBaseDelay: 20 });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].succeed('https://first.trycloudflare.com');
  await flush();

  ctx.tunnels[0].emit('close'); // процесс туннеля завершился сам

  assert.equal(ctx.storedConfig().active, true);
  assert.equal(ctx.storedConfig().url, '');
  assert.equal(ctx.lastStatus().type, 'warning');
  assert.match(ctx.lastStatus().message, /Перезапуск/);
  assert.equal(ctx.notifications.at(-1).title, 'Туннель перезапускается');

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ctx.tunnels.length, 2, 'запущен новый туннель');
  ctx.tunnels[1].succeed('https://second.trycloudflare.com');
  await flush();
  assert.equal(ctx.storedConfig().url, 'https://second.trycloudflare.com');
  assert.equal(ctx.lastStatus().type, 'success');
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

test('причина неудачного запуска остаётся видна, пока туннель не включат или не выключат снова', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].fail(new Error('Не удалось скачать cloudflared'));
  await flush();

  const expected = { type: 'error', message: 'Ошибка: Не удалось скачать cloudflared' };
  assert.equal(ctx.storedConfig().active, false);
  assert.deepEqual(ctx.lastStatus(), expected);
  assert.deepEqual(ctx.manager.getConfigsWithStatuses()[0].status, expected);

  ctx.manager.toggle('c1', false);
  assert.deepEqual(ctx.lastStatus(), { type: 'info', message: 'Не активен' });
});

test('редактирование работающего туннеля перезапускает его с новыми параметрами', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].succeed();
  await flush();

  const list = ctx.manager.updateConfig({ id: 'c1', name: 'API v2', port: '4000' });

  assert.equal(ctx.tunnels[0].closed, true);
  assert.equal(ctx.tunnels.length, 2);
  assert.equal(ctx.tunnels[1].config.port, '4000');
  assert.equal(ctx.storedConfig().active, true);
  assert.equal(list[0].active, true);
});

test('редактирование выключенного туннеля его не запускает', () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.updateConfig({ id: 'c1', name: 'API v2', port: '4000' });
  assert.equal(ctx.tunnels.length, 0);
  assert.equal(ctx.storedConfig().active, false);
  assert.equal(ctx.storedConfig().port, '4000');
});

test('редактирование туннеля, который ещё подключается, перезапускает его', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true); // подключение ещё идёт

  ctx.manager.updateConfig({ id: 'c1', name: 'API', port: '4000' });
  await flush(); // отменённый первый запуск завершается

  assert.equal(ctx.tunnels.length, 2);
  assert.equal(ctx.tunnels[1].config.port, '4000');
  assert.equal(ctx.manager.activeTunnels.c1, ctx.tunnels[1]);
  assert.equal(ctx.storedConfig().active, true);
});

test('быстрое выключение и включение во время подключения запускает туннель заново', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  ctx.manager.toggle('c1', false);
  ctx.manager.toggle('c1', true);
  await flush();

  assert.equal(ctx.tunnels.length, 2);
  assert.equal(ctx.storedConfig().active, true);
  ctx.tunnels[1].succeed('https://second.loca.lt');
  await flush();
  assert.equal(ctx.storedConfig().url, 'https://second.loca.lt');
});

test('туннель можно запустить снова, даже если отменённый запуск так и не завершился', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  // как CFTunnel, закрытый во время скачивания: колбэк open не вызывается никогда
  ctx.tunnels[0].close = function () { this.closed = true; this.emit('close'); };
  ctx.manager.toggle('c1', false);

  ctx.manager.toggle('c1', true);
  assert.equal(ctx.tunnels.length, 2);
});

test('успешное открытие уже остановленного туннеля игнорируется', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  const first = ctx.tunnels[0];
  first.close = function () { this.closed = true; }; // не отменяет open сам
  ctx.manager.toggle('c1', false);

  first.succeed('https://late.loca.lt');
  await flush();

  assert.equal(ctx.storedConfig().active, false);
  assert.equal(ctx.storedConfig().url, '');
  assert.deepEqual(ctx.notifications, []);
});

test('пауза перед перезапуском растёт при повторных падениях', async () => {
  const ctx = makeManager({ configs: [makeConfig()], restartBaseDelay: 20 });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].succeed();
  await flush();

  ctx.tunnels[0].emit('close');
  assert.match(ctx.lastStatus().message, /через 1 с/); // 20 мс округляются до 1 с в тексте
  assert.equal(ctx.manager.restartAttempts.c1, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  ctx.tunnels[1].succeed();
  await flush();

  ctx.tunnels[1].emit('close'); // снова упал сразу после запуска
  assert.equal(ctx.manager.restartAttempts.c1, 2);
  assert.equal(ctx.manager._restartDelay(2), 40);
  assert.equal(ctx.manager._restartDelay(3), 80);
  assert.equal(ctx.manager._restartDelay(20), 60000, 'не дольше минуты');
});

test('выключение отменяет запланированный перезапуск', async () => {
  const ctx = makeManager({ configs: [makeConfig()], restartBaseDelay: 20 });
  ctx.manager.toggle('c1', true);
  ctx.tunnels[0].succeed();
  await flush();
  ctx.tunnels[0].emit('close');

  ctx.manager.toggle('c1', false);
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(ctx.tunnels.length, 1, 'перезапуска не было');
  assert.equal(ctx.storedConfig().active, false);
  assert.deepEqual(ctx.lastStatus(), { type: 'info', message: 'Не активен' });
});

test('выход из приложения и удаление отменяют запланированный перезапуск', async () => {
  const configs = [makeConfig(), makeConfig({ id: 'c2' })];
  const ctx = makeManager({ configs, restartBaseDelay: 20 });
  for (const id of ['c1', 'c2']) {
    ctx.manager.toggle(id, true);
    ctx.tunnels.at(-1).succeed();
  }
  await flush();
  ctx.tunnels[0].emit('close');
  ctx.tunnels[1].emit('close');

  ctx.manager.deleteConfig('c1');
  ctx.manager.shutdown();
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(ctx.tunnels.length, 2, 'перезапусков не было');
  assert.equal(ctx.storedConfig('c2').active, true, 'после выхода туннель восстановится при следующем запуске');
});

// Окно получает список и событие статуса отдельными сообщениями. Список
// рассылается первым и уже содержит итоговое состояние: между сообщениями
// окно не показывает, например, ошибку при включённом переключателе
function recordBroadcasts(manager) {
  const order = [];
  manager.on('configs', (configs) => order.push({ kind: 'configs', config: configs.find(c => c.id === 'c1') }));
  manager.on('status', (data) => order.push({ kind: 'status', status: data.status }));
  return order;
}

test('ошибка запуска: список с выключенным туннелем и ошибкой рассылается раньше статуса', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  ctx.manager.toggle('c1', true);
  const order = recordBroadcasts(ctx.manager);

  ctx.tunnels[0].fail(new Error('отказ сервера'));
  await flush();

  assert.deepEqual(order.map(e => e.kind), ['configs', 'status']);
  assert.equal(order[0].config.active, false);
  assert.equal(order[0].config.status.type, 'error');
  assert.deepEqual(order[0].config.status, order[1].status);
});

test('остановка: список с выключенным туннелем рассылается раньше статуса', async () => {
  const ctx = makeManager({ configs: [makeConfig()] });
  await startRunning(ctx);
  const order = recordBroadcasts(ctx.manager);

  ctx.manager.stop('c1');

  assert.deepEqual(order.map(e => e.kind), ['configs', 'status']);
  assert.equal(order[0].config.active, false);
  assert.deepEqual(order[0].config.status, order[1].status);
});

test('перезапуск после падения: список рассылается раньше статуса', async () => {
  const ctx = makeManager({ configs: [makeConfig()], restartBaseDelay: 1000 });
  await startRunning(ctx);
  const order = recordBroadcasts(ctx.manager);

  ctx.tunnels[0].emit('close');
  ctx.manager.stop('c1'); // отменяем запланированный перезапуск

  assert.deepEqual(order.slice(0, 2).map(e => e.kind), ['configs', 'status']);
  assert.equal(order[0].config.status.type, 'warning');
});
