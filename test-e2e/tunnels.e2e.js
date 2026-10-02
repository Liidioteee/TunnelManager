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

// Фейковый сервер localtunnel, временно недоступный (503) — клиент повторяет попытки
async function startBrokenLocaltunnel(t) {
  return startFakeApi(t, [{ status: 503, json: { message: 'temporarily unavailable' } }]);
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
  const withUptime = await waitForCard(app.page, id, c => /^\d\d:\d\d:\d\d$/.test(c.uptime || ''), { message: 'время работы' });
  assert.match(withUptime.uptime, /^00:00:0\d$/);

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
  // На Windows SIGTERM завершает процесс жёстко (без before-quit), код выхода
  // не 0; туннель всё равно должен восстановиться — флаг active не сбрасывается
  if (process.platform !== 'win32') {
    assert.equal(exit.code, 0, `код выхода приложения: ${JSON.stringify(exit)}`);
  }

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

test('отказ сервера localtunnel показывается на карточке, туннель выключается', async (t) => {
  const api = await startFakeApi(t, [{
    status: 403,
    json: { message: 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.' }
  }]);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });
  const id = await createTunnel(app.page, { name: 'Rejected', port: 3000 });
  await toggleTunnel(app.page, id);

  const info = await waitForCard(app.page, id, c => c.statusType === 'error', { message: 'ошибка от сервера' });
  assert.match(info.statusText, /Invalid subdomain/);
  assert.equal(info.switchOn, false);
  assert.equal(api.requests.length, 1, 'без повторных запросов');
});

test('проверка TLS-сертификата: по умолчанию пропускается только для локального хоста', async (t) => {
  const app = await launchApp(t);
  const page = app.page;
  await page.evaluate(() => document.getElementById('add-btn').click());
  await page.waitFor(() => !document.getElementById('add-form').classList.contains('hidden'));

  const setHost = (host) => page.evaluate((host) => {
    const input = document.getElementById('host-input');
    input.value = host;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.getElementById('skip-tls-verify-checkbox').checked;
  }, host);

  assert.equal(await page.evaluate(() => document.getElementById('skip-tls-verify-checkbox').checked), true);
  assert.equal(await setHost('192.168.1.5'), false, 'адрес в сети — проверка включена');
  assert.equal(await setHost('127.0.0.1'), true, 'локальный адрес — проверка пропускается');

  // ручной выбор пользователя больше не меняется при смене хоста
  await page.evaluate(() => document.getElementById('skip-tls-verify-checkbox').click());
  assert.equal(await setHost('localhost'), false);

  // сохранённая конфигурация с адресом в сети — с проверкой сертификата
  await page.evaluate(() => document.getElementById('skip-tls-verify-checkbox').click());
  assert.equal(await setHost('192.168.1.5'), true, 'после ручного выбора галочка не меняется');
  await page.evaluate(() => document.getElementById('skip-tls-verify-checkbox').click());
  await page.evaluate(() => {
    document.getElementById('port-input').value = '8443';
    document.getElementById('port-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('save-btn').click();
  });
  const saved = await page.waitFor(async () => (await window.api.getConfigs())[0]);
  assert.equal(saved.localHost, '192.168.1.5');
  assert.equal(saved.skipTlsVerify, false);
});

test('ошибка валидации показывается понятным текстом, форма остаётся открытой', async (t) => {
  const app = await launchApp(t);
  const page = app.page;
  await page.evaluate(() => document.getElementById('add-btn').click());
  await page.waitFor(() => !document.getElementById('add-form').classList.contains('hidden'));
  await page.evaluate(() => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('name-input', 'Short subdomain');
    set('port-input', '3000');
    set('subdomain-input', 'ab');
    document.getElementById('save-btn').click();
  });

  const toast = await page.waitFor(() => {
    const el = document.querySelector('.toast.error');
    return el && el.textContent;
  });
  assert.equal(toast, 'Субдомен должен состоять из 4–63 латинских букв и цифр (дефисы — только внутри)');
  assert.equal(await page.evaluate(() => document.getElementById('add-form').classList.contains('hidden')), false);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.tunnel-card').length), 0);
});

test('настройки: сохраняются из окна, посторонние ключи и неверные типы отбрасываются', async (t) => {
  const app = await launchApp(t);
  const page = app.page;

  // через интерфейс
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitFor(() => !document.getElementById('settings-modal').classList.contains('hidden'));
  await page.evaluate(() => {
    document.getElementById('setting-notifications').checked = false;
    document.getElementById('setting-defaultprovider').value = 'cf';
    document.getElementById('settings-save-btn').click();
  });
  await page.waitFor(() => document.getElementById('settings-modal').classList.contains('hidden'));
  const saved = await page.evaluate(() => window.api.getSettings());
  assert.equal(saved.notifications, false);
  assert.equal(saved.defaultProvider, 'cf');

  // прямой вызов IPC с мусором (как из скомпрометированного окна)
  const result = await page.evaluate(() => window.api.saveSettings({
    closeToTray: 'yes', defaultProvider: 'ngrok', evil: '<script>', autoLaunch: 1
  }));
  assert.deepEqual(result, { ...saved });
  assert.deepEqual(await page.evaluate(() => window.api.getSettings()), saved);
});

test('фильтр по статусу обновляется сам, когда локальный порт закрывается', async (t) => {
  const local = await startLocalApp(t);
  const { api } = await startWorkingLocaltunnel(t);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });
  const id = await createTunnel(app.page, { name: 'Filtered', port: local.port });
  await toggleTunnel(app.page, id);
  await waitForCard(app.page, id, c => c.statusText === 'Активен');

  await app.page.evaluate(() => {
    const select = document.getElementById('filter-status');
    select.value = 'warning';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await cardInfo(app.page, id), null, 'активный туннель не подходит под фильтр');

  await close(local.server); // локальное приложение остановилось
  const info = await waitForCard(app.page, id, c => c !== null && c.statusType === 'warning',
    { message: 'карточка появилась в отфильтрованном списке', timeout: 15000 });
  assert.match(info.statusText, /недоступен/);
});

test('обновление списка не пересоздаёт карточки и не сбрасывает фокус', async (t) => {
  const api = await startBrokenLocaltunnel(t);
  const app = await launchApp(t, { env: { TUNNEL_MANAGER_LT_SERVER: api.host } });
  const first = await createTunnel(app.page, { name: 'First', port: 3001 });
  const second = await createTunnel(app.page, { name: 'Second', port: 3002 });

  // помечаем DOM-элементы карточек и ставим фокус на кнопку второй карточки
  await app.page.evaluate((first, second) => {
    document.querySelector(`.tunnel-card[data-id="${first}"]`).__marker = 'first';
    const card = document.querySelector(`.tunnel-card[data-id="${second}"]`);
    card.__marker = 'second';
    card.querySelector('[data-action="edit"]').focus();
  }, first, second);

  await toggleTunnel(app.page, first); // приходит новый список конфигураций
  await waitForCard(app.page, first, c => c.switchOn && /Повтор/.test(c.statusText));

  const state = await app.page.evaluate((first, second) => ({
    firstSame: document.querySelector(`.tunnel-card[data-id="${first}"]`).__marker === 'first',
    secondSame: document.querySelector(`.tunnel-card[data-id="${second}"]`).__marker === 'second',
    focused: document.activeElement && document.activeElement.closest('.tunnel-card')?.dataset.id === second
  }), first, second);
  assert.deepEqual(state, { firstSame: true, secondSame: true, focused: true });
});

test('карточка после обновления остаётся рабочей: выделение, сортировка, удаление', async (t) => {
  const app = await launchApp(t);
  const a = await createTunnel(app.page, { name: 'Bravo', port: 3001 });
  const b = await createTunnel(app.page, { name: 'Alpha', port: 3002 });

  // сортировка по имени переставляет существующие карточки
  await app.page.evaluate(() => {
    const sort = document.getElementById('sort-select');
    sort.value = 'name_asc';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const order = await app.page.evaluate(() => [...document.querySelectorAll('.tunnel-card .tunnel-name-text')].map(e => e.textContent));
  assert.deepEqual(order, ['Alpha', 'Bravo']);

  // клик по карточке выделяет её, редактирование меняет имя на месте
  await app.page.evaluate((id) => document.querySelector(`.tunnel-card[data-id="${id}"] .card-meta`).click(), a);
  assert.equal(await app.page.evaluate((id) => document.querySelector(`.tunnel-card[data-id="${id}"]`).classList.contains('selected'), a), true);
  await editTunnel(app.page, b, { name: 'Charlie' });
  await waitForCard(app.page, b, c => c.name === 'Charlie');

  await deleteTunnel(app.page, a);
  await app.page.waitFor((id) => !document.querySelector(`.tunnel-card[data-id="${id}"]`), [a]);
  assert.equal(await app.page.evaluate(() => document.querySelectorAll('.tunnel-card').length), 1);
});

test('ошибка действия показывается понятным текстом, переключатель возвращается назад', async (t) => {
  const app = await launchApp(t);
  const id = await createTunnel(app.page, { name: 'Gone', port: 3000 });
  // туннель удалён «где-то ещё» (напрямую через IPC), карточка в окне осталась
  await app.page.evaluate((id) => window.api.deleteConfig(id), id);
  const unhandled = await app.page.evaluate(() => {
    window.__unhandled = [];
    window.addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
    return true;
  });
  assert.ok(unhandled);

  await toggleTunnel(app.page, id);
  const toast = await app.page.waitFor(() => document.querySelector('.toast.error')?.textContent);
  assert.equal(toast, 'Туннель не найден');
  assert.deepEqual(await app.page.evaluate(() => window.__unhandled), []);
  assert.equal(await cardInfo(app.page, id), null, 'карточка удалённого туннеля исчезла после обновления списка');
});

test('Esc закрывает форму добавления туннеля', async (t) => {
  const app = await launchApp(t);
  await app.page.evaluate(() => document.getElementById('add-btn').click());
  await app.page.waitFor(() => !document.getElementById('add-form').classList.contains('hidden'));
  await app.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(await app.page.evaluate(() => document.getElementById('add-form').classList.contains('hidden')), true);
});

test('копирование журнала сообщает о журнале, а не о ссылке', async (t) => {
  const app = await launchApp(t);
  await app.page.evaluate(() => document.getElementById('logs-btn').click());
  await app.page.waitFor(() => !document.getElementById('logs-modal').classList.contains('hidden'));
  await app.page.evaluate(() => document.getElementById('logs-copy-btn').click());
  const toast = await app.page.waitFor(() => document.querySelector('.toast')?.textContent);
  assert.match(toast, /Журнал скопирован|Не удалось скопировать/);
  assert.doesNotMatch(toast, /Ссылка/);
});

async function waitUntil(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: условие не выполнено');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
