// «📎 Прикрепить файл» к уже отправленному входящему (files-plan v3 #4). Режим как ввод комментария: 10 минут от
// последнего файла, /cancel, [✅ Готово] [✖️ Отмена]; ход загрузки — строкой в сообщении режима (правка на месте).
// Пересланное и обычный текст режим завершают. В режиме документ (в том числе .txt) — вложение, а не комментарий.
import { addFiles, planFiles } from './uploads.mjs';
import { btn, esc } from './view.mjs';

const TTL_MS = 10 * 60_000;
/** Сколько файлов у пункта — из консоли не чаще раза в 15 с: альбом из десяти фото — один запрос, а не десять. */
const COUNT_TTL_MS = 15_000;
/** Одно предупреждение о молчащей консоли на режим в минуту, а не на каждый файл альбома. */
const WARN_GAP_MS = 60_000;

/**
 * uploader — очередь загрузок (uploads.mjs); getLimits() — лимиты консоли; countFiles(itemId) — сколько файлов уже у
 * пункта (консоль); edit(chatId, msgId, msg) — правка сообщения без отправки нового.
 */
export function createAttach({ store, send, edit, uploader, getLimits, countFiles, log }) {
  const all = () => (store.state.inboxAttach ||= {});
  const save = () => store.saveState();

  function get(chatId) {
    const a = all()[chatId];
    if (a && Date.now() - a.at > TTL_MS) {
      delete all()[chatId];
      save();
      return null;
    }
    return a || null;
  }

  // Лимит размера — из сводки консоли, а не «20 МБ» строкой: иначе режим обещал бы больше, чем примет консоль.
  const mb = (bytes) => `${Math.max(1, Math.floor((Number(bytes) || 0) / (1024 * 1024)))} МБ`;
  const head = (a, limits) => `📎 Прикрепляю к <code>${esc(a.itemId)}</code>: пришлите файлы или фото — до ${limits.maxPerItem} на задачу, `
    + `каждый до ${mb(limits.maxBytes)}. Режим ждёт 10 минут; /cancel — выйти.`;
  const keyboard = (a) => [[btn('✅ Готово', `ibfd:${a.itemId}`), btn('✖️ Отмена', `ibfx:${a.itemId}`)]];

  async function start(chatId, itemId) {
    const limits = await getLimits();
    if (limits.enabled === false) return send(chatId, { text: '📎 Консоль пока не принимает файлы — опишите словами в комментарии к пункту.' });
    const prev = get(chatId);
    if (prev) await end(chatId, 'quiet');
    const a = { itemId, at: Date.now(), photoSeq: 0, docSeq: 0 };
    all()[chatId] = a;
    save();
    const msg = await send(chatId, { text: head(a, limits), keyboard: keyboard(a) });
    a.msgId = msg?.message_id;
    save();
    log(`прикрепление к ${itemId}: режим открыт`);
    return msg;
  }

  const active = (chatId) => !!get(chatId);
  /** Загруженные после замера числа файлов у пункта (дубль по содержимому места не занимает). */
  const doneAfter = (files, at) => files.filter((f) => f.status === 'done' && !f.duplicate && f.doneAt >= at).length;

  /**
   * Сколько мест у пункта уже занято: файлы в консоли (кэш на COUNT_TTL_MS плюс догруженные после замера) и то, что
   * ещё может туда попасть, — ждущие загрузки и не дошедшие по связи (их вернёт «🔁 Повторить файлы»). null — консоль
   * не ответила.
   */
  async function usedSlots(a) {
    const e = uploader.entry(a.itemId);
    const files = e?.files || [];
    // Кэш — только для той же очереди пункта: новая очередь (прежняя решена) не помнит файлов, догруженных после замера.
    const fresh = a.countAt && Date.now() - a.countAt < COUNT_TTL_MS && a.countOf === (e?.startedAt ?? null);
    if (!fresh) {
      const at = Date.now(); // до запроса: файл, догруженный во время ответа, лучше посчитать дважды, чем ни разу
      try {
        a.count = await countFiles(a.itemId);
      } catch {
        return null;
      }
      a.countAt = at;
      a.countOf = e?.startedAt ?? null;
      save();
    }
    const reserved = files.filter((f) => f.status === 'pending' || (f.status === 'failed' && f.retry)).length;
    return a.count + doneAfter(files, a.countAt) + reserved;
  }

  /** Файл или фото в режиме — в очередь загрузок пункта; места нет — отказ с причиной, тем же списком «не приняты». */
  async function collect(chatId, m) {
    const a = get(chatId);
    if (!a) return false;
    a.at = Date.now();
    // Подпись к файлу в пункт не попадает — владелец не должен думать, что описание доставлено. Раз на режим.
    if (m?.caption && !a.captionWarned) {
      a.captionWarned = true;
      save();
      await send(chatId, { text: '📝 Подпись к файлу не сохраняется: агент видит только сам файл. Напишите её комментарием к пункту.' });
    }
    const draft = { files: [], unsupported: [], photoSeq: a.photoSeq, docSeq: a.docSeq };
    addFiles(draft, m);
    a.photoSeq = draft.photoSeq || 0;
    a.docSeq = draft.docSeq || 0;
    save();
    if (!draft.files.length) {
      await send(chatId, { text: `🎤 ${esc(draft.unsupported.join(', ') || 'Это')} не прикрепить: агент видит только файлы и фото. Опишите словами в комментарии к пункту.` });
      return true;
    }
    const limits = await getLimits();
    // Консоль не сказала, сколько файлов уже у пункта, — не угадываем «0»: файл не берём, просим повторить.
    const used = await usedSlots(a);
    if (used === null) {
      if (!a.warnedAt || Date.now() - a.warnedAt > WARN_GAP_MS) {
        a.warnedAt = Date.now();
        save();
        await send(chatId, { text: '⚠️ Консоль не ответила, сколько файлов уже у пункта, — файлы не прикреплены. Пришлите их ещё раз через минуту.' });
      }
      return true;
    }
    const plan = planFiles(draft.files, limits, limits.maxPerItem - used);
    const before = uploader.entry(a.itemId);
    uploader.enqueue(a.itemId, { chatId, cardId: a.msgId, base: { text: head(a, limits), keyboard: keyboard(a) }, files: plan.send, failed: plan.failed });
    const after = uploader.entry(a.itemId);
    if (after && after !== before) {
      // Новая очередь (прежняя решена) не помнит прежних файлов: догруженное после замера — в счёт, кэш — к новой.
      a.count += doneAfter(before?.files || [], a.countAt);
      a.countOf = after.startedAt ?? null;
      save();
    }
    return true;
  }

  /**
   * Конец режима: «Готово», «Отмена», пересланное, текст или новый режим. Уже отправленное догружается. itemId — из
   * кнопки: старое сообщение режима к другому пункту не закрывает текущий режим (#314).
   */
  async function end(chatId, how = 'quiet', itemId = null) {
    const a = all()[chatId];
    if (!a) return false;
    if (itemId && a.itemId !== itemId) return false;
    delete all()[chatId];
    save();
    const text = how === 'cancel'
      ? `📎 Прикрепление к <code>${esc(a.itemId)}</code> отменено: новые файлы не принимаются, уже отправленные останутся.`
      : `📎 Прикрепление к <code>${esc(a.itemId)}</code> закончено.`;
    // Строка хода загрузки остаётся в этом сообщении: очередь правит его, пока не догрузит.
    const e = uploader.entry(a.itemId);
    if (e && e.cardId === a.msgId) uploader.rebase(a.itemId, { text, keyboard: [] });
    else if (a.msgId) await edit(chatId, a.msgId, { text }).catch(() => {});
    log(`прикрепление к ${a.itemId}: режим закрыт (${how})`);
    return true;
  }

  return { start, active, collect, end };
}
