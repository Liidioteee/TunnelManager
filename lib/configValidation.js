// Адрес обратной петли (сервис на этом же компьютере): localhost,
// 127.0.0.0/8 или ::1
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const octets = h.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

// Правило сервера localtunnel для субдомена: строчные латинские буквы и цифры,
// 4–63 символа; дефисы допускаются внутри (тогда длина 6–65)
const LT_SUBDOMAIN = /^(?:[a-z0-9][a-z0-9-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/;

// Проверка и нормализация полей конфигурации. Возвращает { config, error }:
// config — очищенная конфигурация или null, error — понятная причина отказа.
export function validateConfigInput(input) {
  const fail = (error) => ({ config: null, error });

  // данные приходят из окна или из импортируемого файла — там может быть что угодно
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('Некорректные данные конфигурации');
  }
  const { name, port, subdomain, provider, localHost, localProtocol, skipTlsVerify } = input;

  const portNum = parseInt(port, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return fail('Порт должен быть числом от 1 до 65535');
  }

  // hostname / IPv4 / IPv6 без пробелов, слэшей и управляющих символов
  const host = String(localHost || 'localhost').trim().toLowerCase() || 'localhost';
  if (!/^[a-z0-9._:-]{1,253}$/.test(host)) {
    return fail('Недопустимый локальный хост: разрешены латинские буквы, цифры, точки, дефисы и двоеточия');
  }

  const prov = provider === 'cf' ? 'cf' : 'lt';
  const proto = localProtocol === 'https' ? 'https' : 'http';

  // субдомен есть только у LocalTunnel
  let sub = '';
  if (prov === 'lt') {
    sub = String(subdomain || '').trim().toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-+|-+$/g, '');
    if (sub && !LT_SUBDOMAIN.test(sub)) {
      return fail('Субдомен должен состоять из 4–63 латинских букв и цифр (дефисы — только внутри)');
    }
  }

  const nm = String(name || '').trim().slice(0, 60) || `Порт ${portNum}`;

  return {
    error: null,
    config: {
      name: nm,
      port: portNum.toString(),
      subdomain: sub,
      provider: prov,
      localHost: host,
      localProtocol: proto,
      // Без явного выбора проверку сертификата пропускаем только для
      // локальных адресов (самоподписанные dev-сертификаты); для адресов в
      // сети непроверенный сертификат позволил бы подменить сервис
      skipTlsVerify: typeof skipTlsVerify === 'boolean' ? skipTlsVerify : isLoopbackHost(host)
    }
  };
}

// Очищенная конфигурация или null, если данные некорректны
export function sanitizeConfigInput(input) {
  return validateConfigInput(input).config;
}

// Адрес собственного сервера localtunnel (переменная окружения
// TUNNEL_MANAGER_LT_SERVER). Принимается только http(s)-адрес без пути;
// возвращает origin или null, если значение пустое или некорректное.
export function parseLocaltunnelServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}
