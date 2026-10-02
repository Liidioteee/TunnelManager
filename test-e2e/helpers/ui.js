// Действия пользователя в окне приложения. Функции, передаваемые в
// page.evaluate, выполняются внутри страницы, поэтому получают данные
// только через аргументы.

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fillTunnelForm(page, fields) {
  await page.waitFor(() => !document.getElementById('add-form').classList.contains('hidden'));
  await page.evaluate((fields) => {
    const set = (id, value, eventName) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    if (fields.provider !== undefined) set('provider-select', fields.provider, 'change');
    if (fields.name !== undefined) set('name-input', fields.name, 'input');
    if (fields.port !== undefined) set('port-input', String(fields.port), 'input');
    document.getElementById('save-btn').click();
  }, fields);
  await page.waitFor(() => document.getElementById('add-form').classList.contains('hidden'));
}

// Создаёт туннель через форму «+» и возвращает id его карточки
export async function createTunnel(page, { name, port, provider = 'lt' }) {
  await page.evaluate(() => document.getElementById('add-btn').click());
  await fillTunnelForm(page, { name, port, provider });
  return page.waitFor((name) => {
    const card = [...document.querySelectorAll('.tunnel-card')]
      .find(c => c.querySelector('.tunnel-name-text').textContent === name);
    return card && card.dataset.id;
  }, [name]);
}

export async function editTunnel(page, id, fields) {
  await page.evaluate((id) => {
    document.querySelector(`.tunnel-card[data-id="${id}"] [data-action="edit"]`).click();
  }, id);
  await fillTunnelForm(page, fields);
}

export async function toggleTunnel(page, id) {
  await page.evaluate((id) => {
    document.querySelector(`.tunnel-card[data-id="${id}"] input[type="checkbox"]`).click();
  }, id);
}

export async function deleteTunnel(page, id) {
  await page.evaluate((id) => {
    document.querySelector(`.tunnel-card[data-id="${id}"] [data-action="delete"]`).click();
  }, id);
  await page.waitFor(() => !document.getElementById('confirm-modal').classList.contains('hidden'));
  await page.evaluate(() => document.getElementById('confirm-ok-btn').click());
}

// Что пользователь видит на карточке туннеля (null — карточки нет)
export function cardInfo(page, id) {
  return page.evaluate((id) => {
    const card = document.querySelector(`.tunnel-card[data-id="${id}"]`);
    if (!card) return null;
    const statusClass = [...card.classList].find(c => c.startsWith('status-'));
    const link = card.querySelector('.tunnel-url-link');
    const stats = card.querySelector('.stats-badge');
    return {
      name: card.querySelector('.tunnel-name-text').textContent,
      meta: card.querySelector('.card-meta').innerText,
      switchOn: card.querySelector('input[type="checkbox"]').checked,
      statusType: statusClass ? statusClass.slice('status-'.length) : null,
      statusText: card.querySelector('.status-message').innerText,
      url: link ? link.textContent.trim() : null,
      requests: stats && !stats.classList.contains('hidden') ? stats.textContent.trim() : null,
      lastRequest: stats ? stats.title : null
    };
  }, id);
}

// Ждёт, пока карточка не будет удовлетворять условию (проверяется в Node)
export async function waitForCard(page, id, predicate, { timeout = 15000, message = '' } = {}) {
  const deadline = Date.now() + timeout;
  let info;
  while (Date.now() < deadline) {
    info = await cardInfo(page, id);
    if (predicate(info)) return info;
    await sleep(100);
  }
  throw new Error(`Карточка не пришла в ожидаемое состояние за ${timeout} мс${message ? ` (${message})` : ''}: ${JSON.stringify(info)}`);
}

export { installFakeCloudflared } from '../../test/helpers/fakeCloudflared.js';
