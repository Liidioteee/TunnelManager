// Настройки приложения: только известные ключи нужных типов. Настройки
// приходят из окна (IPC) и из хранилища на диске — и то и другое может
// содержать что угодно, поэтому значения проверяются при каждом чтении и записи.

export const DEFAULT_SETTINGS = Object.freeze({
  autoLaunch: false,
  startMinimized: false,
  closeToTray: true,
  defaultProvider: 'lt',
  notifications: true
});

const BOOLEAN_KEYS = ['autoLaunch', 'startMinimized', 'closeToTray', 'notifications'];
const PROVIDERS = ['lt', 'cf'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function applyValid(target, source) {
  if (!isPlainObject(source)) return target;
  for (const key of BOOLEAN_KEYS) {
    if (Object.hasOwn(source, key) && typeof source[key] === 'boolean') target[key] = source[key];
  }
  if (Object.hasOwn(source, 'defaultProvider') && PROVIDERS.includes(source.defaultProvider)) {
    target.defaultProvider = source.defaultProvider;
  }
  return target;
}

// Применяет корректные значения из input поверх current (оба проверяются)
export function sanitizeSettings(input, current = DEFAULT_SETTINGS) {
  const base = applyValid({ ...DEFAULT_SETTINGS }, current);
  return applyValid(base, input);
}
