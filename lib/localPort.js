import net from 'net';

// Проверяет, принимает ли локальный сервис соединения на порту
export function checkLocalPort(port, host = 'localhost', { timeout = 600 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host === 'localhost' ? '127.0.0.1' : host);
  });
}
