import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_USER_MODEL_ID } from '../lib/appInfo.js';

test('AppUserModelID совпадает с build.appId сборки', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_USER_MODEL_ID, pkg.build.appId);
});
