import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { launchApp } from './helpers/app.js';
import { createTunnel, toggleTunnel, editTunnel, deleteTunnel, cardInfo, waitForCard } from './helpers/ui.js';
import { startFakeApi, startTcp, listen, close } from '../test/helpers/fakeLocaltunnel.js';

// «Приложение пользователя», которое открывают через туннель
async function startLocalApp(t) {
  const server = http.createServer((req, res) => res.end(`hello from ${req.url}`));
  const port = await listen(server);
  t.after(() => close(server));
  return { server, port };
}

// Фейковый сервер localtunnel, который успешно выдаёт туннель
async function startWorkingLocaltunnel(t, url = 'https://e2e.loca.lt') {
  const tcp = await startTcp(t);
  const api = await startFakeApi(t, [
    { id: 'e2e', ip: '127.0.0.1', port: tcp.port, max_conn_count: 1, url }
  ]);
  return { tcp, api };
}

// Фейковый сервер localtunnel, который отвечает мусором — клиент повторяет попытки
async function startBrokenLocaltunnel(t) {
  return startFakeApi(t, [{ message: 'temporarily unavailable' }]);
}

test('создание и удаление туннеля через интерфейс', async (t) => {
  const app = await launchApp(t);
  const id = await createTunnel(app.page, { name: 'Мой API', port: 3000 });

  const info = await cardInfo(app.page, id);
  assert.equal(info.name, 'Мой API');
  assert.match(info.meta, /Порт: 3000/);
  assert.equal(info.switchOn, false);
  assert.equal(info.statusText, 'Не активен');

  await deleteTunnel(app.page, id);
  await app.page.waitFor(() => !!document.querySelector('.empty-state'));
  assert.equal(await cardInfo(app.page, id), null);
});

test('LocalTunnel: туннель подключается, показывает адрес и пропускает запросы', async (t) => {
  const local = await startLocalApp(t);
  const { tcp, api } = await startWorkingLocaltunnel(t);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });

  const id = await createTunnel(app.page, { name: 'Local app', port: local.port });
  const connected = once(tcp.server, 'connection');
  await toggleTunnel(app.page, id);

  const info = await waitForCard(app.page, id, c => c.statusText === 'Активен', { message: 'туннель активен' });
  assert.equal(info.switchOn, true);
  assert.equal(info.statusType, 'success');
  assert.equal(info.url, 'https://e2e.loca.lt');

  // Запрос «из интернета» приходит через сокет туннеля в локальное приложение
  const [socket] = await connected;
  let response = '';
  socket.on('data', (d) => { response += d; });
  socket.write('GET /hello?token=secret HTTP/1.1\r\nHost: e2e.loca.lt\r\n\r\n');
  await waitUntil(() => response.includes('hello from /hello?token=secret'));

  const withStats = await waitForCard(app.page, id, c => c.requests === '1 req', { message: 'счётчик запросов' });
  assert.match(withStats.lastRequest, /GET \/hello$/); // query string не показывается
});

test('пока сервер недоступен, переключатель остаётся включённым, а карточка показывает предупреждение', async (t) => {
  const api = await startBrokenLocaltunnel(t);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });
  const id = await createTunnel(app.page, { name: 'Retry', port: 3000 });

  await toggleTunnel(app.page, id);
  const info = await waitForCard(app.page, id, c => /Повтор/.test(c.statusText), { message: 'повторная попытка' });

  assert.equal(info.switchOn, true);
  assert.equal(info.statusType, 'warning');
});

test('включённый туннель восстанавливается после перезапуска приложения', async (t) => {
  const local = await startLocalApp(t);
  const { api } = await startWorkingLocaltunnel(t);
  const env = { TUNNEL_MANAGER_LT_SERVER: api.host };

  const first = await launchApp(t, { env });
  const id = await createTunnel(first.page, { name: 'Persistent', port: local.port });
  await toggleTunnel(first.page, id);
  await waitForCard(first.page, id, c => c.statusText === 'Активен');
  const exit = await first.quit();
  assert.equal(exit.code, 0, `код выхода приложения: ${JSON.stringify(exit)}`);

  const second = await launchApp(t, { userDataDir: first.userDataDir, env });
  const info = await waitForCard(second.page, id, c => c.statusText === 'Активен', { message: 'после перезапуска' });
  assert.equal(info.switchOn, true);
  assert.equal(info.url, 'https://e2e.loca.lt');
});

test('редактирование подключающегося туннеля перезапускает его с новым портом', async (t) => {
  const api = await startBrokenLocaltunnel(t);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });
  const id = await createTunnel(app.page, { name: 'Edit', port: 3000 });
  await toggleTunnel(app.page, id);
  await waitForCard(app.page, id, c => /Повтор/.test(c.statusText));

  await editTunnel(app.page, id, { port: 4000 });

  const info = await waitForCard(app.page, id, c => /Порт: 4000/.test(c.meta) && /Повтор/.test(c.statusText),
    { message: 'перезапуск с новым портом' });
  assert.equal(info.switchOn, true);
});

async function waitUntil(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: условие не выполнено');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
