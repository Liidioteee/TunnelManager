// Проверки для данных, приходящих из окна приложения

// Запрос по IPC принимается только от собственной страницы приложения
// (рекомендация чек-листа безопасности Electron: проверять отправителя)
// На Windows пути к файлам не зависят от регистра (C:\ и c:\ — один путь)
export function isTrustedSenderUrl(senderUrl, appIndexUrl, { caseInsensitive = false } = {}) {
  if (typeof senderUrl !== 'string' || !senderUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const app = new URL(appIndexUrl);
    sender.hash = '';
    app.hash = '';
    return caseInsensitive
      ? decodeURI(sender.href).toLowerCase() === decodeURI(app.href).toLowerCase()
      : sender.href === app.href;
  } catch {
    return false;
  }
}

// Адрес для открытия во внешнем браузере: только http(s), без учётных
// данных в адресе. Возвращает нормализованный адрес или null.
export function safeExternalUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}
