// Валидация и нормализация полей конфигурации.
// Возвращает null, если данные некорректны.
export function sanitizeConfigInput({ name, port, subdomain, provider, localHost, localProtocol, skipTlsVerify } = {}) {
  const portNum = parseInt(port, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }

  // hostname / IPv4 / IPv6 без пробелов, слэшей и управляющих символов
  const host = String(localHost || 'localhost').trim().toLowerCase() || 'localhost';
  if (!/^[a-z0-9._:-]{1,253}$/.test(host)) {
    return null;
  }

  const prov = provider === 'cf' ? 'cf' : 'lt';
  const proto = localProtocol === 'https' ? 'https' : 'http';

  let sub = String(subdomain || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  const nm = String(name || '').trim().slice(0, 60) || `Порт ${portNum}`;

  return {
    name: nm,
    port: portNum.toString(),
    subdomain: sub,
    provider: prov,
    localHost: host,
    localProtocol: proto,
    skipTlsVerify: skipTlsVerify !== false
  };
}
