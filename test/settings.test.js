import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../lib/settings.js';

test('значения по умолчанию', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, {
    autoLaunch: false, startMinimized: false, closeToTray: true, defaultProvider: 'lt', notifications: true
  });
});

test('корректные значения применяются поверх текущих', () => {
  const current = { ...DEFAULT_SETTINGS, autoLaunch: true };
  assert.deepEqual(sanitizeSettings({ notifications: false, defaultProvider: 'cf' }, current), {
    ...DEFAULT_SETTINGS, autoLaunch: true, notifications: false, defaultProvider: 'cf'
  });
});

test('неизвестные ключи и значения не того типа отбрасываются', () => {
  const result = sanitizeSettings({
    closeToTray: 'no', autoLaunch: 1, defaultProvider: 'ngrok', notifications: null,
    __proto__: { polluted: true }, extra: 'x', constructor: 'y'
  });
  assert.deepEqual(result, DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test('мусор в сохранённых настройках не переживает чтения', () => {
  assert.deepEqual(sanitizeSettings(undefined, { evil: true, closeToTray: false, defaultProvider: 7 }), {
    ...DEFAULT_SETTINGS, closeToTray: false
  });
});

test('не объект на входе — текущие настройки без изменений', () => {
  for (const value of [null, 'str', 5, [true]]) {
    assert.deepEqual(sanitizeSettings(value, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  }
});
