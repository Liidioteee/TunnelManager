import http from 'node:http';
import net from 'node:net';

export function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

// Закрывает сервер, не дожидаясь клиентов: у HTTP-сервера close() иначе
// ждёт завершения keep-alive соединений
export function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

// Порт, на котором гарантированно никто не слушает (соединение будет отклонено)
export async function getClosedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

// Фейковый API-сервер localtunnel: на каждый запрос отдаёт следующий
// ответ из списка (последний повторяется). Ответ — функция или объект.
export async function startFakeApi(t, responses) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    const index = Math.min(requests.length - 1, responses.length - 1);
    const item = responses[index];
    const body = typeof item === 'function' ? await item() : item;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { host: `http://127.0.0.1:${port}`, requests };
}

// TCP-сервер, имитирующий туннельный порт localtunnel; запоминает сокеты
export async function startTcp(t, onConnection = () => {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  const port = await listen(server);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await close(server);
  });
  return { port, sockets, server };
}
