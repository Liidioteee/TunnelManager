import net from 'net';

// Один адрес: принимает ли он соединения на порту за отведённое время
function tryConnect(port, host, timeout) {
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
    socket.connect(port, host);
  });
}

// Проверяет, принимает ли локальный сервис соединения на порту.
// localhost может означать и 127.0.0.1, и ::1: многие dev-серверы слушают
// только IPv6-адрес, а туннель до них достучится, поэтому проверяются оба.
export async function checkLocalPort(port, host = 'localhost', { timeout = 600 } = {}) {
  const targets = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const results = await Promise.all(targets.map(target => tryConnect(port, target, timeout)));
  return results.some(Boolean);
}
