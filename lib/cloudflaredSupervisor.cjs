// Надзиратель за процессом cloudflared.
//
// Запуск: <node или Electron с ELECTRON_RUN_AS_NODE=1> cloudflaredSupervisor.cjs <путь> [аргументы...]
//
// Запускает указанный процесс, передаёт его stdout/stderr как есть и
// завершается с его кодом. Главное — не дать процессу пережить приложение:
// приложение держит stdin надзирателя открытым, и когда оно завершается
// любым способом (в том числе падает или убито), ОС закрывает канал —
// надзиратель видит конец stdin и останавливает процесс. Без этого
// cloudflared после падения приложения продолжал бы открывать локальный
// порт в интернет. Работает одинаково на Linux, macOS и Windows.
//
// CommonJS — чтобы файл надёжно загружался и из app.asar.
'use strict';

const { spawn } = require('child_process');

const [command, ...args] = process.argv.slice(2);

// Обработчики остановки регистрируются ДО запуска процесса: cloudflared
// пишет в вывод напрямую, и приложение может прислать SIGTERM, едва увидев
// его первые строки. Если сигнал придёт раньше обработчика, Node по
// умолчанию просто завершит надзирателя, и cloudflared останется сиротой.
let child = null;
let stopRequested = false;

function stopChild() {
  stopRequested = true;
  if (!child) return; // процесс ещё не запущен — остановим сразу после запуска
  try {
    child.kill('SIGKILL');
  } catch {
    // процесс уже завершился
  }
}

// Конец stdin: приложение завершилось или явно просит остановиться
process.stdin.on('end', stopChild);
process.stdin.on('close', stopChild);
process.stdin.on('error', stopChild);
process.stdin.resume();

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, stopChild);
}

// Переменная, включившая режим Node у Electron, самому cloudflared не нужна
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

child = spawn(command, args, {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true
});

child.on('error', (err) => {
  process.stderr.write(`cloudflared supervisor: не удалось запустить ${command}: ${err.message}\n`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  process.exit(code !== null ? code : (signal ? 1 : 0));
});

if (stopRequested) stopChild();
