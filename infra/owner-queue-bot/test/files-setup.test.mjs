// node --test infra/owner-queue-bot/test — вложения в боте целиком на подделках Telegram и консоли: лимиты с кэшем,
// загрузка, строка хода в карточке (имена — текстом), «Повторить», режим «Прикрепить файл».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OQB_HOME = mkdtempSync(join(tmpdir(), 'oqb-home-'));
const { createFiles } = await import('../files-setup.mjs');

function fakes({ summary = { enabled: true, limits: { maxBytes: 20 * 1024 * 1024, maxPerItem: 2 } }, uploadFails = 0, have = 0, listFails = false, editFails = null, callFails = null } = {}) {
  const edits = [], sent = [], uploads = [], calls = [];
  let summaryCalls = 0, fails = uploadFails;
  const store = { state: {}, saveState() {} };
  const tg = {
    edit: async (chatId, msgId, text, extra) => {
      if (editFails) throw editFails;
      edits.push({ msgId, text, keyboard: extra?.reply_markup?.inline_keyboard });
    },
    call: async (method, params) => { calls.push({ method, text: params?.text }); if (callFails) throw callFails; return {}; },
    downloadTo: async (fileId, path) => { writeFileSync(path, `файл ${fileId}`); },
  };
  const queueApi = {
    filesSummary: async () => { summaryCalls++; if (summary instanceof Error) throw summary; return summary; },
    uploadFile: async (itemId, name) => { uploads.push(name); if (fails > 0) { fails--; throw Object.assign(new Error('Файл не принят: архивы не принимаются'), { status: 415 }); } return {}; },
    getItem: async () => ({ data: { kind: 'inbox', inbox: { text: 'x' } }, version: 1 }),
    putItem: async () => ({}),
    // Как консоль: уже приложенные плюс загруженные за тест (отказы по типу не считаются).
    listFiles: async () => { if (listFails) throw new Error('fetch failed'); return { files: Array.from({ length: have + uploads.length - (uploadFails - fails) }, (_, i) => ({ id: String(i) })) }; },
  };
  const send = async (chatId, msg) => { sent.push(msg); return { message_id: 300 + sent.length }; };
  const markup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});
  // Правки без паузы: тесты на настоящих таймерах; пауза и повтор правок — в uploads.test.mjs на поддельных часах.
  const files = createFiles({ store, tg, queueApi, send, markup, log: () => {}, paintGapMs: 0 });
  return { ...files, edits, sent, uploads, calls, store, summaryCalls: () => summaryCalls };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test('лимиты консоли — с кэшем; консоль без вложений (404) — выключено, сбой связи — по умолчанию и без кэша', async () => {
  const f = fakes();
  assert.deepEqual(await f.getLimits(), { enabled: true, maxBytes: 20 * 1024 * 1024, maxPerItem: 2 });
  await f.getLimits();
  assert.equal(f.summaryCalls(), 1);
  const old = fakes({ summary: Object.assign(new Error('nope'), { status: 404 }) });
  assert.equal((await old.getLimits()).enabled, false);
  const down = fakes({ summary: new Error('fetch failed') });
  assert.equal((await down.getLimits()).enabled, true);
  await down.getLimits();
  assert.equal(down.summaryCalls(), 2, 'сбой связи не кэшируется');
});

test('строка хода — под текстом карточки, имена файлов — текстом, отказ консоли — в итоге', async () => {
  const f = fakes({ uploadFails: 1 });
  f.uploader.enqueue('i-1', { chatId: 7, cardId: 70, base: { text: '📥 <b>Принято</b>', keyboard: [[{ text: 'Меню', callback_data: 'm' }]] },
    files: [{ fileId: 'a', uniqueId: 'ua', name: '<img src=x onerror=alert(1)>.zip', size: 1 }, { fileId: 'b', uniqueId: 'ub', name: 'скрин.png', size: 1 }], failed: [] });
  await settle();
  const last = f.edits.at(-1);
  assert.equal(last.msgId, 70);
  assert.match(last.text, /^📥 <b>Принято<\/b>\n\n📎 Файлы: 1 из 2\. Не приняты: &lt;img src=x onerror=alert\(1\)&gt;\.zip — файл не принят: архивы не принимаются$/);
  assert.equal(last.keyboard.flat().some((b) => b.callback_data === 'ibr:i-1'), false, 'отказ по типу не повторяют');
});

test('режим «Прикрепить файл»: место по лимиту — с учётом уже приложенного, «Готово» закрывает режим, ход остаётся', async () => {
  const f = fakes({ have: 1 });
  const msg = await f.attach.start(7, 'i-9');
  assert.equal(f.attach.active(7), true);
  assert.match(f.sent.at(-1).text, /Прикрепляю к <code>i-9<\/code>/);
  await f.attach.collect(7, { photo: [{ file_id: 'p1', file_unique_id: 'up1', file_size: 10 }] });
  await f.attach.collect(7, { photo: [{ file_id: 'p2', file_unique_id: 'up2', file_size: 10 }] });
  await settle();
  assert.deepEqual(f.uploads, ['фото-1.jpg'], 'лимит 2, один уже был — второе фото не уходит');
  assert.match(f.edits.at(-1).text, /Не приняты: фото-2\.jpg — сверх лимита: не больше 2 файлов на задачу/);
  await f.attach.end(7, 'done');
  assert.equal(f.attach.active(7), false);
  assert.equal(f.edits.at(-1).msgId, msg.message_id);
  assert.match(f.edits.at(-1).text, /Прикрепление к <code>i-9<\/code> закончено/);
  assert.equal(f.edits.at(-1).keyboard, undefined, 'после «Готово» кнопок режима нет');
});

test('режим прикрепления: консоль не сказала, сколько файлов у пункта, — файл не берём (раньше считалось «0»)', async () => {
  const f = fakes({ listFails: true });
  await f.attach.start(7, 'i-20261022-101500-abcd');
  await f.attach.collect(7, { photo: [{ file_id: 'p1', file_unique_id: 'up1', file_size: 10 }] });
  await settle();
  assert.deepEqual(f.uploads, []);
  assert.match(f.sent.at(-1).text, /файлы не прикреплены/);
});

test('альбом при молчащей консоли — одно предупреждение, а не по одному на файл (линза GLM «ресурсы» #314)', async () => {
  const f = fakes({ listFails: true });
  await f.attach.start(7, 'i-20261022-101500-abcd');
  const before = f.sent.length;
  for (const id of ['p1', 'p2', 'p3']) await f.attach.collect(7, { photo: [{ file_id: id, file_unique_id: `u${id}`, file_size: 10 }] });
  assert.equal(f.sent.length - before, 1);
});

test('правка простым текстом (разметка не разобралась), совпавшая с сообщением, — не сбой (линза GLM «ресурсы» #314)', async () => {
  const f = fakes({
    editFails: new Error("editMessageText: Bad Request: can't parse entities: unclosed tag"),
    callFails: new Error('editMessageText: Bad Request: message is not modified: specified new message content and reply markup are exactly the same'),
  });
  await f.editOnly(7, 70, { text: '📥 <b>Принято' });
  assert.equal(f.calls.length, 1, 'простой текст отправлен один раз');
  const other = fakes({ editFails: new Error("editMessageText: Bad Request: can't parse entities"), callFails: new Error('editMessageText: Bad Request: message to edit not found') });
  await assert.rejects(other.editOnly(7, 70, { text: 'x' }), /not found/);
});
