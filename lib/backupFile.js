import fs from 'fs';

// Файл резервной копии — это список туннелей; больше 1 МБ — явно не он
export const MAX_BACKUP_BYTES = 1024 * 1024;

// Читает и разбирает файл импорта с понятными для пользователя ошибками
export function readBackupFile(filePath) {
  const { size } = fs.statSync(filePath);
  if (size > MAX_BACKUP_BYTES) {
    throw new Error('Файл слишком большой для резервной копии туннелей (больше 1 МБ)');
  }
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Файл не является корректным JSON');
  }
}
