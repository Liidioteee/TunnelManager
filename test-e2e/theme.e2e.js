import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp } from './helpers/app.js';

async function emulateSystemTheme(page, value) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
}

async function reload(page) {
  await page.send('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.waitFor(() => document.readyState === 'complete' && !!window.api
    && !!document.querySelector('#tunnels-list').children.length);
}

const themeState = (page) => page.evaluate(() => ({
  dark: document.documentElement.classList.contains('dark-theme'),
  sunVisible: !document.getElementById('theme-icon-sun').classList.contains('hidden')
}));

test('без выбранной темы используется системная', async (t) => {
  const app = await launchApp(t);
  await emulateSystemTheme(app.page, 'dark');
  await reload(app.page);
  assert.deepEqual(await themeState(app.page), { dark: true, sunVisible: true });

  await emulateSystemTheme(app.page, 'light');
  await app.page.waitFor(() => !document.documentElement.classList.contains('dark-theme'));
  assert.deepEqual(await themeState(app.page), { dark: false, sunVisible: false });
});

test('тема, выбранная кнопкой, сохраняется и важнее системной', async (t) => {
  const app = await launchApp(t);
  await emulateSystemTheme(app.page, 'dark');
  await reload(app.page);
  await app.page.evaluate(() => document.getElementById('theme-btn').click()); // тёмная → светлая
  assert.equal((await themeState(app.page)).dark, false);

  await reload(app.page);
  assert.deepEqual(await themeState(app.page), { dark: false, sunVisible: false });
});

test('класс темы ставится в <head>, до отрисовки страницы', async (t) => {
  const app = await launchApp(t);
  const order = await app.page.evaluate(() => [...document.head.querySelectorAll('script, link[rel="stylesheet"]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href')));
  assert.deepEqual(order.slice(0, 2), ['theme.js', 'style.css']);
});
