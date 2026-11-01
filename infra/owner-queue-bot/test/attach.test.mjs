// node --test infra/owner-queue-bot/test — режим «📎 Прикрепить файл» к отправленному входящему.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttach } from '../attach.mjs';

function rig(limits = { enabled: true, maxBytes: 10 * 1024 * 1024, maxPerItem: 5 }, { uploader = { entry: () => null, enqueue: () => true, rebase: () => {} }, countFiles = async () => 0 } = {}) {
  const store = { state: {}, saveState() {} };
  const sent = [], edits = [];
  const attach = createAttach({
    store, uploader, log: () => {}, countFiles,
    send: async (chatId, msg) => { sent.push(msg); return { message_id: 100 + sent.length }; },
    edit: async (chatId, msgId, msg) => { edits.push({ msgId, msg }); },
    getLimits: async () => limits,
  });
  return { attach, sent, edits };
}

/** Очередь как в uploads.mjs: решённая очередь заменяется новой, нерешённая дополняется; startedAt — своя у каждой. */
function queueFake() {
  const entries = {}, calls = [];
  let seq = 0;
  return {
    entries, calls,
    entry: (id) => entries[id] || null,
    enqueue: (id, e) => {
      calls.push({ files: e.files.map((x) => x.name), failed: e.failed });
      const files = e.files.map((x) => ({ ...x, status: 'pending' }));
      const prev = entries[id];
      if (prev && !prev.settledAt) prev.files.push(...files);
      else entries[id] = { startedAt: ++seq, files };
      return true;
    },
    rebase: () => {},
  };
}
const ITEM = 'i-20261022-100000-aaaa';
const photo = (id) => ({ photo: [{ file_id: id, file_unique_id: `u${id}`, file_size: 10 }] });

test('лимит размера в сообщении режима — из настроек консоли, а не «20 МБ» строкой (линза GLM #314)', async () => {
  const r = rig();
  await r.attach.start(7, 'i-20261022-100000-aaaa');
  assert.match(r.sent[0].text, /каждый до 10 МБ/);
});

test('«Готово» со старого сообщения режима к другому пункту текущий режим не закрывает', async () => {
  const r = rig();
  await r.attach.start(7, 'i-20261022-100000-aaaa');
  assert.equal(await r.attach.end(7, 'done', 'i-20261022-090000-bbbb'), false);
  assert.equal(r.attach.active(7), true);
  assert.equal(await r.attach.end(7, 'done', 'i-20261022-100000-aaaa'), true);
  assert.equal(r.attach.active(7), false);
});

test('альбом в режиме — один запрос к консоли за 15 с, лимит соблюдён (линза GLM «ресурсы» #314)', async () => {
  const q = queueFake();
  let counts = 0;
  const r = rig({ enabled: true, maxBytes: 10 * 1024 * 1024, maxPerItem: 2 }, { uploader: q, countFiles: async () => { counts += 1; return 0; } });
  await r.attach.start(7, ITEM);
  for (const id of ['p1', 'p2', 'p3']) await r.attach.collect(7, photo(id));
  assert.equal(counts, 1, 'не по запросу на фото');
  assert.deepEqual(q.calls.map((c) => c.files.length), [1, 1, 0]);
  assert.match(q.calls[2].failed[0].reason, /сверх лимита/);
});

test('файл, загруженный после замера, — в счёт, даже когда решённую очередь сменила новая (линза GLM «ресурсы» #314)', async () => {
  const q = queueFake();
  const r = rig({ enabled: true, maxBytes: 10 * 1024 * 1024, maxPerItem: 2 }, { uploader: q });
  await r.attach.start(7, ITEM);
  await r.attach.collect(7, photo('p1'));
  // p1 загрузился, очередь решена: следующее фото откроет новую очередь, которая про p1 не знает.
  Object.assign(q.entries[ITEM].files[0], { status: 'done', doneAt: Date.now() });
  q.entries[ITEM].settledAt = Date.now();
  await r.attach.collect(7, photo('p2'));
  await r.attach.collect(7, photo('p3'));
  assert.deepEqual(q.calls.map((c) => c.files.length), [1, 1, 0], 'p1 в консоли + p2 в пути = лимит 2');
});

test('не дошедший по связи файл держит место: «Повторить» не выведет пункт за лимит (линза GLM «ресурсы» #314)', async () => {
  const q = queueFake();
  q.entries[ITEM] = { startedAt: 99, settledAt: 1, files: [{ uniqueId: 'u0', status: 'failed', retry: true }, { uniqueId: 'u9', status: 'failed', retry: false }] };
  const r = rig({ enabled: true, maxBytes: 10 * 1024 * 1024, maxPerItem: 1 }, { uploader: q });
  await r.attach.start(7, ITEM);
  await r.attach.collect(7, photo('p1'));
  assert.deepEqual(q.calls[0].files, []);
  assert.match(q.calls[0].failed[0].reason, /сверх лимита/);
});

test('подпись к файлу в режиме — одно предупреждение «не сохраняется» на режим (линза GLM «ресурсы» #314)', async () => {
  const r = rig(undefined, { uploader: queueFake() });
  await r.attach.start(7, ITEM);
  const n = r.sent.length;
  await r.attach.collect(7, { ...photo('p1'), caption: 'лог со вчерашнего инцидента' });
  await r.attach.collect(7, { ...photo('p2'), caption: 'ещё' });
  assert.equal(r.sent.length - n, 1);
  assert.match(r.sent.at(-1).text, /Подпись к файлу не сохраняется/);
});
