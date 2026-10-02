import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUptimeTicker } from '../lib/uptimeTicker.js';

function setup() {
  const sent = [];
  const win = { visible: true };
  const ticker = createUptimeTicker({
    getUptimes: () => ({ c1: 5 }),
    isWindowVisible: () => win.visible,
    send: (data) => sent.push(data)
  });
  return { sent, win, ticker };
}

test('видимому окну время работы отправляется на каждом тике', () => {
  const { sent, ticker } = setup();
  ticker.tick();
  ticker.tick();
  assert.deepEqual(sent, [{ c1: 5 }, { c1: 5 }]);
});

test('скрытому или свёрнутому окну ничего не отправляется', () => {
  const { sent, win, ticker } = setup();
  win.visible = false;
  ticker.tick();
  ticker.tick();
  assert.deepEqual(sent, []);
});

test('при показе окна актуальное время отправляется сразу', () => {
  const { sent, win, ticker } = setup();
  win.visible = false;
  ticker.tick();
  win.visible = true;
  ticker.windowShown();
  assert.deepEqual(sent, [{ c1: 5 }]);
});

test('start/stop управляют таймером', async () => {
  const { sent, ticker } = setup();
  ticker.start(10);
  await new Promise(resolve => setTimeout(resolve, 55));
  ticker.stop();
  const count = sent.length;
  assert.ok(count >= 3, `тиков: ${count}`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sent.length, count);
});
