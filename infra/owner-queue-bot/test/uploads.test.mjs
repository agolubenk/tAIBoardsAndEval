// node --test infra/owner-queue-bot/test — вложения входящих: что прикрепляется, лимиты, загрузка с повторами, итог.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploader, failureOf, filesLine, filesOf, planFiles } from '../uploads.mjs';

test('что прикрепляется: документ и самое крупное фото; голос, видео и стикер — агенту недоступны', () => {
  const m = { document: { file_id: 'd', file_unique_id: 'ud', file_name: 'отчёт.pdf', file_size: 12 }, photo: [{ file_id: 's', file_size: 1 }, { file_id: 'L', file_unique_id: 'uL', file_size: 9 }], voice: {}, sticker: {} };
  const { files, unsupported } = filesOf(m);
  assert.deepEqual(files.map((f) => [f.fileId, f.name, f.size]), [['d', 'отчёт.pdf', 12], ['L', '', 9]]);
  assert.deepEqual(unsupported, ['голосовое', 'стикер']);
});

test('лимиты до отправки: больше 20 МБ (потолок Bot API) и сверх числа — отказ с причиной, expected — всё приложенное', () => {
  const files = [{ name: 'a', size: 1 }, { name: 'big', size: 21 * 1024 * 1024 }, { name: 'b', size: 1 }, { name: 'c', size: 1 }];
  const p = planFiles(files, { maxBytes: 50 * 1024 * 1024, maxPerItem: 2 });
  assert.deepEqual(p.send.map((f) => f.name), ['a', 'b']);
  assert.deepEqual(p.failed, [
    { name: 'big', reason: 'больше 20 МБ не принимается — обрежьте лог или пришлите ссылку текстом' },
    { name: 'c', reason: 'сверх лимита: не больше 2 файлов на задачу' },
  ]);
  assert.equal(p.expected, 4);
  assert.equal(planFiles([{ name: 'x', size: 1 }], { maxBytes: 1e9, maxPerItem: 5 }, 0).failed.length, 1, 'места в пункте нет');
});

test('ответ консоли → причина и можно ли повторить', () => {
  assert.deepEqual(failureOf({ status: 415, message: 'Файл не принят: архивы не принимаются' }), { reason: 'файл не принят: архивы не принимаются', retry: false });
  assert.equal(failureOf({ status: 409, message: 'У входящего уже 5 файлов — больше нельзя' }).retry, false);
  assert.deepEqual(failureOf({ status: 404 }), { reason: 'задача удалена', retry: false });
  assert.equal(failureOf({ status: 503, message: 'x' }).retry, true);
  assert.equal(failureOf({ status: 429 }).retry, true);
  assert.equal(failureOf(new TypeError('fetch failed')).retry, true);
  assert.equal(failureOf({ tooBig: true }).retry, false);
});

test('строка в «Принято»: счётчик, итог, отказы', () => {
  const e = { failed: [{ name: 'big.log', reason: 'больше 20 МБ' }], files: [{ name: 'a', status: 'done' }, { name: 'b', status: 'pending' }] };
  assert.equal(filesLine(e), '📎 Файлы: 1 из 3, загружаю…');
  e.files[1].status = 'done';
  assert.equal(filesLine(e), '📎 Файлы: 2 из 3. Не приняты: big.log — больше 20 МБ');
  assert.equal(filesLine({ failed: [], files: [{ name: 'a', status: 'done' }] }), '📎 Файлы: 1 из 1 ✓');
});

function rig({ uploadPlan = [], startAt = 1_000_000, getItemFails = [], saveFails = 0, paintGapMs = 0, tmpBudget, renderFails = [], putLoses = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'oqb-up-'));
  let saveLeft = saveFails;
  const store = { state: {}, saveState() { if (saveLeft > 0) { saveLeft -= 1; throw new Error('EBUSY'); } } };
  let t = startAt;
  const timers = [];
  const uploads = [], downloads = [], renders = [], puts = [];
  const plan = [...uploadPlan];
  let item = { data: { kind: 'inbox', inbox: { text: 'x', filesExpected: 2 } }, version: 3 };
  const logs = [];
  let loses = putLoses;
  const up = createUploader({
    store, home, log: (line) => logs.push(line), paintGapMs, ...(tmpBudget !== undefined ? { tmpBudget } : {}),
    now: () => t,
    schedule: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; },
    download: async (fileId, path) => { downloads.push(fileId); writeFileSync(path, `содержимое ${fileId}`); },
    upload: async (itemId, name, path) => {
      uploads.push({ name, exists: existsSync(path) });
      const next = plan.shift();
      if (next === 'dup') return { duplicate: true };
      if (next) throw next;
      return { duplicate: false };
    },
    getItem: async (id) => {
      const err = getItemFails.shift();
      if (err) throw err;
      return item.id === undefined ? item : { ...item };
    },
    putItem: async (id, data, v) => {
      puts.push({ id, data, v });
      item = { data, version: v + 1 };
      // Запись применилась, а ответ потерялся (обрыв после отправки).
      if (loses > 0) { loses -= 1; throw new Error('fetch failed'); }
    },
    render: async (id, e) => {
      const err = renderFails.shift();
      if (err) throw err;
      renders.push(filesLine(e));
    },
  });
  const advance = async (ms) => { t += ms; const due = timers.filter((x) => x.at <= t); timers.splice(0, timers.length, ...timers.filter((x) => x.at > t)); for (const x of due) await x.fn(); };
  return { up, store, uploads, downloads, renders, puts, logs, advance, home, setItem: (doc) => { item = doc; }, settle: () => new Promise((r) => setTimeout(r, 20)) };
}
const entry = (files, failed = []) => ({ chatId: 7, cardId: 70, base: { text: 'Принято', keyboard: [] }, files, failed });
const f = (id, name) => ({ fileId: id, uniqueId: `u${id}`, name, size: 10 });

test('загрузка: по одному, временный файл удаляется, итог без отказов — filesFailed не пишется', async () => {
  const r = rig();
  r.up.enqueue('i-1', entry([f('a', 'a.png'), f('b', 'b.pdf')]));
  await r.settle();
  assert.deepEqual(r.uploads.map((u) => u.name), ['a.png', 'b.pdf']);
  assert.ok(r.uploads.every((u) => u.exists));
  assert.equal(r.renders.at(-1), '📎 Файлы: 2 из 2 ✓');
  assert.equal(r.puts.length, 0);
  assert.ok(r.up.entry('i-1').files.every((x) => !x.tmp));
});

test('сбой связи — повтор через 1 с тем же скачанным файлом (без повторного getFile), пока ждёт — грузится следующий; отказ консоли — сразу в filesFailed', async () => {
  const net = new Error('fetch failed');
  // Порядок вызовов: a (сбой), z (сбой) — оба ждут 1 с; затем a (успех), z (415).
  const r = rig({ uploadPlan: [net, net, null, Object.assign(new Error('Файл не принят: архивы не принимаются'), { status: 415 })] });
  r.up.enqueue('i-2', entry([f('a', 'a.png'), f('z', 'x.zip')], [{ name: 'big.log', reason: 'больше 20 МБ' }]));
  await r.settle();
  assert.deepEqual(r.uploads.map((u) => u.name), ['a.png', 'x.zip'], 'один файл в ожидании повтора не держит остальные');
  assert.equal(r.renders.at(-1), '📎 Файлы: 0 из 3, загружаю…');
  await r.advance(1000); await r.settle();
  assert.deepEqual(r.downloads, ['a', 'z'], 'файл у Telegram — один раз на файл');
  assert.equal(r.uploads.length, 4);
  assert.equal(r.renders.at(-1), '📎 Файлы: 1 из 3. Не приняты: big.log — больше 20 МБ; x.zip — файл не принят: архивы не принимаются');
  assert.equal(r.puts.length, 1);
  assert.deepEqual(r.puts[0].data.inbox.filesFailed.map((x) => x.name), ['big.log', 'x.zip']);
  assert.equal(r.puts[0].v, 3, 'запись пункта — с ifVersion');
});

test('три сбоя связи подряд — файл не принят, «Повторить» запускает его снова', async () => {
  const net = new Error('fetch failed');
  const r = rig({ uploadPlan: [net, net, net, net] });
  r.up.enqueue('i-3', entry([f('a', 'a.png')]));
  await r.settle(); await r.advance(1000); await r.settle(); await r.advance(5000); await r.settle(); await r.advance(30_000); await r.settle();
  const e = r.up.entry('i-3');
  assert.equal(e.files[0].status, 'failed');
  assert.equal(e.files[0].retry, true);
  assert.equal(r.up.retry('i-3'), true);
  await r.settle();
  assert.equal(r.up.entry('i-3').files[0].status, 'done');
  assert.equal(r.renders.at(-1), '📎 Файлы: 1 из 1 ✓');
});

test('очередь старше часа — не ждём связь дальше: файл не принят с понятной причиной', async () => {
  const r = rig({ uploadPlan: [new Error('fetch failed')] });
  r.up.enqueue('i-4', entry([f('a', 'a.png')]));
  await r.settle();
  await r.advance(61 * 60_000); await r.settle();
  assert.equal(r.up.entry('i-4').files[0].status, 'failed');
  assert.match(r.renders.at(-1), /не дождался связи с консолью за час/);
});

test('перезапуск посреди скачивания: недокачанный .part не уходит в консоль, целый файл не скачивается заново', async () => {
  const r = rig();
  // Как после падения бота: целый временный файл уже лежит, у другого файла — только обрывок .part.
  const dir = join(r.home, 'files-tmp');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const tmpName = (u) => `i-5-${Buffer.from(u).toString('base64url')}`;
  writeFileSync(join(dir, tmpName('ua')), 'целый файл');
  writeFileSync(join(dir, `${tmpName('ub')}.part`), 'обры');
  r.up.enqueue('i-5', entry([f('a', 'a.png'), f('b', 'b.png')]));
  await r.settle();
  assert.deepEqual(r.downloads, ['b'], 'целый файл — без повторного getFile, обрывок — скачан заново');
  assert.deepEqual(r.uploads.map((u) => u.name), ['a.png', 'b.png']);
  assert.equal(existsSync(join(dir, `${tmpName('ub')}.part`)), false);
});

test('дубль по содержимому (консоль вернула ту же запись) — из ожиданий агента убирается', async () => {
  const r = rig({ uploadPlan: [null, 'dup'] });
  r.up.enqueue('i-6', entry([f('a', 'a.png'), f('b', 'копия-a.png')]));
  await r.settle();
  assert.equal(r.puts.length, 1);
  assert.equal(r.puts[0].data.inbox.filesExpected, 1, 'было 2, одна — дубль');
  assert.equal(r.puts[0].data.inbox.filesFailed, undefined);
});

test('имя файла из Telegram — в журнал без переводов строк и управляющих символов', async () => {
  const r = rig({ uploadPlan: [Object.assign(new Error('Файл не принят: архивы'), { status: 415 })] });
  r.up.enqueue('i-7', entry([f('a', 'evil\n[ops] деплой прошёл\u202e.zip')]));
  await r.settle();
  assert.ok(r.logs.some((l) => l.includes('evil?[ops] деплой прошёл?.zip')));
  assert.ok(r.logs.every((l) => !l.includes('\n')));
});

test('разные file_unique_id не склеиваются во временном файле (раньше «a.b» и «a_b» давали один путь)', async () => {
  const r = rig();
  r.up.enqueue('i-8', entry([{ fileId: 'f1', uniqueId: 'a.b', name: 'один.txt', size: 1 }, { fileId: 'f2', uniqueId: 'a_b', name: 'два.txt', size: 1 }]));
  await r.settle();
  assert.deepEqual(r.downloads, ['f1', 'f2'], 'второй файл скачан, а не взят из чужого временного');
});

test('консоль вернула документ другого пункта — filesFailed не пишется', async () => {
  const r = rig({ uploadPlan: [Object.assign(new Error('Файл не принят: архивы'), { status: 415 })] });
  r.setItem({ id: 'i-other', data: { kind: 'inbox', inbox: { text: 'чужой' } }, version: 9 });
  r.up.enqueue('i-9', entry([f('a', 'a.zip')]));
  await r.settle();
  assert.equal(r.puts.length, 0);
});

test('итог не записался (консоль 503) — повтор записи позже, а не пункт, навсегда «ждущий файлы» (линза GLM #314)', async () => {
  const r = rig({ getItemFails: [Object.assign(new Error('Service Unavailable'), { status: 503 })] });
  r.up.enqueue('i-1', entry([f('a', 'a.png')], [{ name: 'big.log', reason: 'больше 20 МБ' }]));
  await r.settle();
  assert.equal(r.puts.length, 0);
  assert.ok(r.up.entry('i-1').finishAt > 0, 'запись итога запланирована');
  await r.advance(30_000);
  await r.settle();
  assert.equal(r.puts.length, 1);
  assert.deepEqual(r.puts[0].data.inbox.filesFailed, [{ name: 'big.log', reason: 'больше 20 МБ' }]);
  assert.equal(r.up.entry('i-1').finishAt, undefined);
});

test('после stop() старый таймер повтора не будит очередь', async () => {
  const r = rig({ uploadPlan: [new Error('fetch failed')] });
  r.up.enqueue('i-1', entry([f('a', 'a.png')]));
  await r.settle();
  assert.equal(r.uploads.length, 1);
  r.up.stop();
  await r.advance(2_000);
  await r.settle();
  assert.equal(r.uploads.length, 1, 'после остановки — ни одной загрузки');
});

test('сбой записи state.json не обрывает очередь: файлы догружаются, причина — в журнале', async () => {
  const r = rig({ saveFails: 2 });
  r.up.enqueue('i-1', entry([f('a', 'a.png'), f('b', 'b.pdf')]));
  await r.settle();
  assert.deepEqual(r.uploads.map((u) => u.name), ['a.png', 'b.pdf']);
  assert.ok(r.logs.some((l) => /состояние не сохранено/.test(l)));
});

test('правки карточки: всплеск событий — не чаще паузы, последней правкой — итог (линза GLM «ресурсы» #314)', async () => {
  const r = rig({ paintGapMs: 1000 });
  r.up.enqueue('i-p', entry([f('a', 'a.png'), f('b', 'b.png'), f('c', 'c.png')]));
  await r.settle();
  assert.equal(r.renders.length, 1, 'три загрузки за миг — одна правка, остальное ждёт паузу');
  await r.advance(1000); await r.settle();
  assert.equal(r.renders.length, 2);
  assert.equal(r.renders.at(-1), '📎 Файлы: 3 из 3 ✓');
});

test('правка не прошла (429) — повтор через retry_after Telegram, итог не теряется (линза GLM «ресурсы» #314)', async () => {
  const tooMany = Object.assign(new Error('editMessageText: Too Many Requests: retry after 7'), { retryAfter: 7 });
  const r = rig({ renderFails: [null, tooMany] });
  r.up.enqueue('i-q', entry([f('a', 'a.png')]));
  await r.settle();
  assert.deepEqual(r.renders, ['📎 Файлы: 0 из 1, загружаю…']);
  await r.advance(6_999); await r.settle();
  assert.equal(r.renders.length, 1, 'раньше retry_after не правим');
  await r.advance(1); await r.settle();
  assert.equal(r.renders.at(-1), '📎 Файлы: 1 из 1 ✓');
});

test('ответ на запись итога потерялся — повтор не вычитает дубль второй раз (линза GLM «ресурсы» #314)', async () => {
  const r = rig({ uploadPlan: [null, 'dup'], putLoses: 1 });
  r.up.enqueue('i-6b', entry([f('a', 'a.png'), f('b', 'копия-a.png')]));
  await r.settle();
  assert.equal(r.puts.length, 1);
  assert.equal(r.puts[0].data.inbox.filesExpected, 1);
  assert.ok(r.up.entry('i-6b').finishAt > 0, 'итог не подтверждён — повтор по сроку');
  await r.advance(30_000); await r.settle();
  assert.equal(r.puts.length, 1, 'в пункте уже верное число — второй записи нет, и 1 не стало 0');
  assert.equal(r.up.entry('i-6b').finishAt, undefined);
});

test('временные файлы — с потолком: пока консоль молчит, сверх него не качаем, а ждём места (линза GLM «ресурсы» #314)', async () => {
  const r = rig({ uploadPlan: [new Error('fetch failed'), null, null], tmpBudget: 30 });
  r.up.enqueue('i-t', entry([f('a', 'a.png'), f('b', 'b.png')]));
  await r.settle();
  assert.deepEqual(r.downloads, ['a'], 'второй файл ждёт: первый (22 байта) ещё на диске, потолок 30');
  assert.ok(r.logs.some((l) => /ждёт места/.test(l)));
  assert.equal(r.up.entry('i-t').files[1].attempts, 0, 'ожидание места попыток не тратит');
  await r.advance(1000); await r.settle();
  assert.deepEqual(r.uploads.map((u) => u.name), ['a.png', 'a.png']);
  await r.advance(30_000); await r.settle();
  assert.deepEqual(r.downloads, ['a', 'b']);
  assert.equal(r.renders.at(-1), '📎 Файлы: 2 из 2 ✓');
});

test('строка файлов — с потолком длины, эмодзи не режется пополам (линза GLM «ресурсы» #314)', () => {
  const long = 'x'.repeat(5000);
  const line = filesLine({ failed: Array.from({ length: 6 }, (_, i) => ({ name: `${'я'.repeat(300)}${i}`, reason: long })), files: [] });
  assert.ok(line.length < 1400, `длина ${line.length}: пять причин с эхом консоли не выводят карточку за 4096`);
  const emoji = filesLine({ failed: [{ name: '😀'.repeat(100), reason: 'нет' }], files: [] });
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), false);
  assert.ok(failureOf({ status: 422, message: long }).reason.length <= 200);
});

test('карточку показали позже постановки — ход переезжает в неё и дописывается к её тексту (статус автопередачи)', async () => {
  const r = rig();
  r.up.enqueue('i-1', entry([f('a', 'a.png')]));
  await r.settle();
  const shown = { text: 'Принято · Передаю сессии hr-helper-v2-43', keyboard: [] };
  r.up.setCard('i-1', 71, shown);
  assert.equal(r.up.entry('i-1').cardId, 71);
  assert.equal(r.up.entry('i-1').base, shown);
  r.up.setCard('i-1', 72);
  assert.equal(r.up.entry('i-1').cardId, 72);
  assert.equal(r.up.entry('i-1').base, shown, 'без нового текста подпись прежняя');
});
