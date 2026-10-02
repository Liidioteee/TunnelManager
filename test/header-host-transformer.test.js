import { test } from 'node:test';
import assert from 'node:assert/strict';
import HeaderHostTransformer from '../lib/HeaderHostTransformer.js';

// Прогоняет данные через трансформер кусками заданного размера
// (имитация произвольного деления TCP-потока на пакеты)
async function transform(input, { host = 'docker.local', chunkSize = Infinity } = {}) {
  const t = new HeaderHostTransformer({ host });
  const out = [];
  t.on('data', (d) => out.push(d));
  const done = new Promise((resolve, reject) => {
    t.on('end', resolve);
    t.on('error', reject);
  });
  const buf = Buffer.from(input, 'latin1');
  const size = Number.isFinite(chunkSize) ? chunkSize : buf.length || 1;
  for (let i = 0; i < buf.length; i += size) t.write(buf.subarray(i, i + size));
  t.end();
  await done;
  return Buffer.concat(out).toString('latin1');
}

const req = (path, extra = '', body = '') =>
  `GET ${path} HTTP/1.1\r\nHost: x.loca.lt\r\n${extra}\r\n${body}`;

for (const chunkSize of [Infinity, 1, 7]) {
  const label = Number.isFinite(chunkSize) ? `кусками по ${chunkSize} байт` : 'одним куском';

  test(`подменяет Host в каждом запросе keep-alive соединения (${label})`, async () => {
    const out = await transform(req('/a') + req('/b') + req('/c'), { chunkSize });
    assert.equal(out, req('/a').replace('x.loca.lt', 'docker.local')
      + req('/b').replace('x.loca.lt', 'docker.local')
      + req('/c').replace('x.loca.lt', 'docker.local'));
  });

  test(`пропускает тело по Content-Length и находит следующий запрос (${label})`, async () => {
    const body = 'Host: evil\r\n\r\nPOST /fake HTTP/1.1\r\n\r\n';
    const first = `POST /upload HTTP/1.1\r\nHost: x.loca.lt\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const out = await transform(first + req('/next'), { chunkSize });
    assert.equal(out, first.replace('Host: x.loca.lt', 'Host: docker.local') + req('/next').replace('x.loca.lt', 'docker.local'));
  });

  test(`пропускает chunked-тело с трейлерами и находит следующий запрос (${label})`, async () => {
    const chunked = 'POST /c HTTP/1.1\r\nHost: x.loca.lt\r\nTransfer-Encoding: chunked\r\n\r\n'
      + '5\r\nHost:\r\n'
      + 'a;ext=1\r\n\r\n\r\nGET / \r\n'
      + '0\r\nX-Trailer: 1\r\n\r\n';
    const out = await transform(chunked + req('/after'), { chunkSize });
    assert.equal(out, chunked.replace('Host: x.loca.lt', 'Host: docker.local') + req('/after').replace('x.loca.lt', 'docker.local'));
  });

  test(`после Upgrade (WebSocket) данные идут без изменений (${label})`, async () => {
    const upgrade = 'GET /ws HTTP/1.1\r\nHost: x.loca.lt\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
    const frames = 'binary\r\n\r\nGET / HTTP/1.1\r\nHost: x.loca.lt\r\n\r\n';
    const out = await transform(upgrade + frames, { chunkSize });
    assert.equal(out, upgrade.replace('x.loca.lt', 'docker.local') + frames);
  });
}

test('регистр имени заголовка не важен, остальные заголовки не меняются', async () => {
  const input = 'GET / HTTP/1.1\r\nX-Host: keep\r\nhOsT:   x.loca.lt\r\nAccept: */*\r\n\r\n';
  assert.equal(await transform(input), 'GET / HTTP/1.1\r\nX-Host: keep\r\nhOsT:   docker.local\r\nAccept: */*\r\n\r\n');
});

test('символы перевода строки в имени хоста вырезаются', async () => {
  const out = await transform(req('/'), { host: 'evil\r\nX-Injected: 1' });
  assert.ok(!out.includes('\r\nX-Injected'), out);
});

test('слишком большой заголовок передаётся без изменений', async () => {
  const huge = `GET / HTTP/1.1\r\nHost: x.loca.lt\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`;
  assert.equal(await transform(huge, { chunkSize: 1000 }), huge);
});

test('некорректный Content-Length — дальше данные идут без изменений', async () => {
  const bad = 'POST / HTTP/1.1\r\nHost: x.loca.lt\r\nContent-Length: abc\r\n\r\n';
  const out = await transform(bad + req('/next'));
  assert.equal(out, bad.replace('x.loca.lt', 'docker.local') + req('/next'));
});

test('незавершённый заголовок отдаётся при закрытии потока', async () => {
  assert.equal(await transform('GET / HTTP/1.1\r\nHost: x.lo'), 'GET / HTTP/1.1\r\nHost: x.lo');
});

test('IPv6-адрес в заголовке Host записывается в квадратных скобках', async () => {
  assert.equal(await transform(req('/'), { host: '::1' }), req('/').replace('x.loca.lt', '[::1]'));
  assert.equal(await transform(req('/'), { host: 'fe80::1' }), req('/').replace('x.loca.lt', '[fe80::1]'));
});
