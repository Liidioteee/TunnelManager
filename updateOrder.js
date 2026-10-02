// Порядок обновлений из main-процесса. Каждый снимок списка туннелей
// (ответ на запрос или рассылка) и каждое событие статуса получают в
// main-процессе возрастающий номер. Ответы на запросы и рассылки приходят
// в окно разными очередями IPC и под нагрузкой могут прийти не в том
// порядке, в котором были отправлены, — тогда устаревший список вернул бы
// удалённую карточку или включённый переключатель. Всё, что старше уже
// показанного, отбрасывается.
/* exported createUpdateOrder */
function createUpdateOrder() {
  let listSeq = -Infinity;
  const statusSeqs = new Map(); // id туннеля → номер последнего применённого статуса

  return {
    // Снимок списка новее уже показанного?
    acceptList(seq) {
      if (seq < listSeq) return false;
      listSeq = seq;
      for (const [id, statusSeq] of statusSeqs) {
        if (statusSeq < seq) statusSeqs.delete(id); // снимок новее этого статуса
      }
      return true;
    },

    // Событие статуса новее и последнего списка, и последнего статуса туннеля?
    acceptStatus(id, seq) {
      if (seq < listSeq || seq < (statusSeqs.get(id) ?? -Infinity)) return false;
      statusSeqs.set(id, seq);
      return true;
    },

    // Статус туннеля из события новее, чем в принятом снимке списка?
    hasNewerStatus(id, listSnapshotSeq) {
      return (statusSeqs.get(id) ?? -Infinity) > listSnapshotSeq;
    }
  };
}
