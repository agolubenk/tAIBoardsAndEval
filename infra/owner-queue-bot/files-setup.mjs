// Вложения входящих в боте: лимиты консоли (кэш 10 минут), очередь загрузок (uploads.mjs) с правкой строки хода в
// карточке и режим «📎 Прикрепить файл» (attach.mjs). Отдельно от bot.mjs: там — обработка апдейтов и экраны.
import { createAttach } from './attach.mjs';
import { toPlain } from './tg-html.mjs';
import { createUploader, DEFAULT_LIMITS, filesLine } from './uploads.mjs';
import { HOME } from './store.mjs';
import { btn, esc } from './view.mjs';

/** paintGapMs — пауза между правками карточки (uploads.mjs); тесты на настоящих таймерах ставят 0. */
export function createFiles({ store, tg, queueApi, send, markup, log, paintGapMs }) {
  // Лимиты консоли — кэш на 10 минут; консоль без вложений (404 или enabled: false) — файлы описываются словами.
  let filesLimits = null;
  let filesLimitsAt = 0;
  async function getLimits() {
    if (filesLimits && Date.now() - filesLimitsAt < 10 * 60_000) return filesLimits;
    try {
      const s = await queueApi.filesSummary();
      filesLimits = s?.enabled
        ? { enabled: true, maxBytes: Number(s.limits?.maxBytes) || DEFAULT_LIMITS.maxBytes, maxPerItem: Number(s.limits?.maxPerItem) || DEFAULT_LIMITS.maxPerItem }
        : { enabled: false, maxBytes: 0, maxPerItem: 0 };
      filesLimitsAt = Date.now();
    } catch (e) {
      if (e.status !== 404) return filesLimits || DEFAULT_LIMITS; // сбой связи не кэшируем
      filesLimits = { enabled: false, maxBytes: 0, maxPerItem: 0 };
      filesLimitsAt = Date.now();
    }
    return filesLimits;
  }
  /** Правка сообщения без отправки нового: ход загрузки не должен плодить сообщения, если карточку удалили. */
  async function editOnly(chatId, msgId, msg) {
    // Карточка «Принято» и строка файлов с длинными именами и причинами бывают длиннее 4096: обрезка — в обеих ветках;
    // разметку, разрезанную обрезкой, Telegram не разберёт — тогда уходит простой текст (#314).
    try {
      await tg.edit(chatId, msgId, msg.text.slice(0, 4096), markup(msg.keyboard));
    } catch (e) {
      if (!/can't parse entities|message is too long/i.test(e.message)) throw e;
      try {
        await tg.call('editMessageText', { chat_id: chatId, message_id: msgId, text: toPlain(msg.text).slice(0, 4096), ...markup(msg.keyboard) });
      } catch (plainErr) {
        // Тот же простой текст, что уже в сообщении, — не сбой: иначе очередь правок повторяла бы безобидную правку.
        if (!/message is not modified/i.test(plainErr.message)) throw plainErr;
      }
    }
  }
  const uploader = createUploader({
    store, home: HOME, log, ...(paintGapMs !== undefined ? { paintGapMs } : {}),
    download: (fileId, path, maxBytes) => tg.downloadTo(fileId, path, maxBytes),
    upload: (itemId, name, path) => queueApi.uploadFile(itemId, name, path),
    getItem: (id) => queueApi.getItem(id),
    putItem: (id, data, ifVersion) => queueApi.putItem(id, data, ifVersion),
    // Строка о файлах — под текстом карточки «Принято» (или сообщения режима прикрепления); имена — текстом.
    render: async (itemId, e) => {
      if (!e.cardId) return;
      const retry = e.settledAt && e.files.some((f) => f.status === 'failed' && f.retry);
      const keyboard = [...(retry ? [[btn('🔁 Повторить файлы', `ibr:${itemId}`)]] : []), ...(e.base?.keyboard || [])];
      await editOnly(e.chatId, e.cardId, { text: `${e.base?.text || ''}\n\n${esc(filesLine(e))}`, keyboard: keyboard.length ? keyboard : undefined });
    },
  });
  setInterval(() => uploader.prune(), 10 * 60_000).unref();
  const attach = createAttach({
    store, send, log, uploader, getLimits,
    edit: (chatId, msgId, msg) => editOnly(chatId, msgId, msg),
    countFiles: async (itemId) => (await queueApi.listFiles(itemId)).files.length,
  });

  return { getLimits, uploader, attach, editOnly };
}
