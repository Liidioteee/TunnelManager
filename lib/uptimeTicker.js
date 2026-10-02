// Раз в секунду отправляет в окно время работы туннелей — но только когда
// окно видно: приложение может часами работать в трее, и обновлять скрытый
// интерфейс незачем. При показе окна актуальные значения уходят сразу.
export function createUptimeTicker({ getUptimes, isWindowVisible, send }) {
  let timer = null;

  function tick() {
    if (isWindowVisible()) send(getUptimes());
  }

  return {
    tick,
    windowShown: tick,
    start(interval = 1000) {
      if (!timer) timer = setInterval(tick, interval);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
