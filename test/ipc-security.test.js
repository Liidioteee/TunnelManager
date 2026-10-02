import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedSenderUrl, safeExternalUrl } from '../lib/ipcSecurity.js';

const APP = 'file:///opt/Tunnel%20Manager/resources/app.asar/index.html';

test('доверенный отправитель — только страница приложения', () => {
  assert.equal(isTrustedSenderUrl(APP, APP), true);
  assert.equal(isTrustedSenderUrl(`${APP}#section`, APP), true);
  for (const url of [
    'file:///opt/Tunnel%20Manager/resources/app.asar/other.html',
    'file:///home/user/evil.html',
    'https://example.com/index.html',
    `${APP}?x=1`,
    '', null, undefined, 'not a url'
  ]) {
    assert.equal(isTrustedSenderUrl(url, APP), false, String(url));
  }
});

test('внешние ссылки: только http(s)', () => {
  assert.equal(safeExternalUrl('https://app.loca.lt'), 'https://app.loca.lt/');
  assert.equal(safeExternalUrl(' http://x.trycloudflare.com/path?q=1 '), 'http://x.trycloudflare.com/path?q=1');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://host/share', 'ms-settings:',
    'https://user:pass@evil.com', 'not a url', '', null]) {
    assert.equal(safeExternalUrl(value), null, String(value));
  }
});

test('на Windows регистр и кодирование пути не важны', () => {
  const app = 'file:///C:/Program%20Files/Tunnel%20Manager/resources/app.asar/index.html';
  const sender = 'file:///c:/program%20files/Tunnel%20Manager/resources/app.asar/index.html';
  assert.equal(isTrustedSenderUrl(sender, app, { caseInsensitive: true }), true);
  assert.equal(isTrustedSenderUrl(sender, app), false);
  assert.equal(isTrustedSenderUrl('file:///C:/evil/index.html', app, { caseInsensitive: true }), false);
});
