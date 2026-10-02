import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// updateOrder.js — обычный скрипт страницы: выполняем его как в окне
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'updateOrder.js'), 'utf8');
function createUpdateOrder() {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.createUpdateOrder();
}

test('снимок списка старше уже показанного отбрасывается', () => {
  const order = createUpdateOrder();
  assert.equal(order.acceptList(5), true);
  assert.equal(order.acceptList(3), false, 'рассылка, пришедшая после ответа на удаление');
  assert.equal(order.acceptList(7), true);
});

test('первый снимок принимается при любом номере', () => {
  assert.equal(createUpdateOrder().acceptList(1), true);
});

test('событие статуса старше последнего списка отбрасывается', () => {
  const order = createUpdateOrder();
  order.acceptList(10);
  assert.equal(order.acceptStatus('a', 9), false);
  assert.equal(order.acceptStatus('a', 11), true);
});

test('события статуса одного туннеля применяются по порядку, разных — независимо', () => {
  const order = createUpdateOrder();
  assert.equal(order.acceptStatus('a', 4), true);
  assert.equal(order.acceptStatus('a', 2), false);
  assert.equal(order.acceptStatus('b', 3), true);
});

test('статус из события новее статуса в более старом снимке', () => {
  const order = createUpdateOrder();
  order.acceptStatus('a', 6);
  // снимок 5 создан раньше события 6, но пришёл позже: принять список
  // можно, только статус туннеля a в нём устарел
  assert.equal(order.acceptList(5), true);
  assert.equal(order.hasNewerStatus('a', 5), true);
  assert.equal(order.hasNewerStatus('b', 5), false);
  assert.equal(order.acceptList(8), true);
  assert.equal(order.hasNewerStatus('a', 8), false);
});
