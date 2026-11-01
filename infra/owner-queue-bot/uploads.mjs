// Вложения входящих из Telegram (files-plan v3): что из сообщения прикрепляется, что нет и почему, и загрузка в
// консоль после создания пункта. По одному файлу: скачать у Telegram во временный файл один раз, отправить в консоль
// (POST /api/oq/v1/files), при сбое связи — повтор через 1, 5 и 30 с без повторного getFile. Очередь — в state бота
// (переживает перезапуск), не дольше часа. Временные файлы — в каталоге бота: корень контейнера только для чтения.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Больше Bot API боту не отдаёт (getFile). */
export const BOT_API_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_LIMITS = { enabled: true, maxBytes: 20 * 1024 * 1024, maxPerItem: 10 };
/** Имя файла — данные третьих лиц: в журнал без управляющих символов и переводов строк (иначе подделают строки). */
const logName = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 120);
/** Потолок схемы входящего: filesExpected ≤ 20, filesFailed — не больше 20 строк. */
export const MAX_FILES = 20;
const RETRY_S = [1, 5, 30];
const UPLOAD_TTL_MS = 60 * 60_000;
const KEEP_SETTLED_MS = 60 * 60_000;
/** Запись итога в пункт не удалась (сеть, 5xx, три 409 подряд) — повтор через эти паузы, потом журнал. */
const FINISH_RETRY_S = [30, 120, 600];
/** Временный файл без очереди (бот упал между скачиванием и записью state) — убирается через 2 часа. */
const ORPHAN_TMP_MS = 2 * 60 * 60_000;
/**
 * Потолок временных файлов: пока консоль недоступна, скачанное ждёт в каталоге бота до часа — сверх потолка новое не
 * качается, а ждёт места. Иначе диск кончится (ENOSPC) и state.json не запишется именно тогда, когда очередь нужна.
 */
export const TMP_BUDGET_BYTES = 256 * 1024 * 1024;
/** Файл ждёт места под временный — проверка раз в эти секунды, в пределах того же часа очереди. */
const SPACE_WAIT_S = 30;
/** Правки карточки одного пункта — не чаще: Telegram отвечает 429 на частые правки в одном чате. */
const PAINT_GAP_MS = 1200;
/** Правка не прошла (429, сеть) — повтор через эти паузы (при 429 — через retry_after Telegram), потом журнал. */
const PAINT_RETRY_S = [2, 5, 15, 60];

const UNSUPPORTED = { voice: 'голосовое', video_note: 'видеосообщение', video: 'видео', audio: 'аудио', animation: 'GIF', sticker: 'стикер' };

const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const mb = (n) => `${Math.round(n / 1024 / 1024)} МБ`;
const filesWord = (n) => plural(n, 'файла', 'файлов', 'файлов');
/** Обрезка по символам, а не по половинкам суррогатных пар: эмодзи в имени не превращается в битый UTF-8. */
const clip = (s, n) => {
  const a = Array.from(String(s ?? ''));
  return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join('');
};

/** Файлы сообщения: документ или фото (самое крупное из размеров); голос, видео и прочее — агенту недоступны. */
export function filesOf(m) {
  const files = [];
  if (m?.document?.file_id) {
    files.push({ fileId: m.document.file_id, uniqueId: m.document.file_unique_id || m.document.file_id,
      name: String(m.document.file_name || '').slice(0, 200), size: Number(m.document.file_size) || 0, photo: false });
  }
  if (Array.isArray(m?.photo) && m.photo.length && m.photo[m.photo.length - 1]?.file_id) {
    const p = m.photo[m.photo.length - 1];
    files.push({ fileId: p.file_id, uniqueId: p.file_unique_id || p.file_id, name: '', size: Number(p.file_size) || 0, photo: true });
  }
  return { files, unsupported: Object.keys(UNSUPPORTED).filter((k) => m?.[k]).map((k) => UNSUPPORTED[k]) };
}

/**
 * Добавить файлы сообщения в черновик: без повторов (file_unique_id), фото без имени — «фото-1.jpg» по порядку,
 * документ без имени — «файл-1». Возвращает, сколько файлов добавлено.
 */
export function addFiles(d, m) {
  const { files, unsupported } = filesOf(m);
  d.files ||= [];
  d.unsupported ||= [];
  let added = 0;
  for (const f of files) {
    if (d.files.length >= MAX_FILES || d.files.some((x) => x.uniqueId === f.uniqueId)) continue;
    const name = f.name || (f.photo ? `фото-${(d.photoSeq = (d.photoSeq || 0) + 1)}.jpg` : `файл-${(d.docSeq = (d.docSeq || 0) + 1)}`);
    d.files.push({ fileId: f.fileId, uniqueId: f.uniqueId, name, size: f.size });
    added++;
  }
  for (const u of unsupported) if (!d.unsupported.includes(u)) d.unsupported.push(u);
  return added;
}

/**
 * Что уйдёт: в пределах лимитов — на загрузку, остальное — сразу отказом с причиной (в пункт — filesFailed: агент видит,
 * что прикладывал владелец и почему не дошло). room — сколько ещё можно приложить к пункту. Тип файла здесь не
 * решается: его по содержимому проверяет консоль.
 */
export function planFiles(files, limits = DEFAULT_LIMITS, room) {
  const max = Math.min(limits.maxBytes || DEFAULT_LIMITS.maxBytes, BOT_API_MAX_BYTES);
  const perItem = limits.maxPerItem || DEFAULT_LIMITS.maxPerItem;
  const free = room == null ? perItem : Math.max(0, room);
  let sent = 0;
  const rows = (files || []).slice(0, MAX_FILES).map((f) => {
    let reason = null;
    if (f.size > max) reason = `больше ${mb(max)} не принимается — обрежьте лог или пришлите ссылку текстом`;
    else if (sent >= free) reason = `сверх лимита: не больше ${perItem} ${filesWord(perItem)} на задачу`;
    else sent++;
    return { ...f, reason };
  });
  return { send: rows.filter((r) => !r.reason), failed: rows.filter((r) => r.reason).map((r) => ({ name: r.name, reason: r.reason })), expected: rows.length };
}

/** Текст задачи, если владелец прислал только файлы: «Вложение: отчёт.pdf» (и «и ещё 2»). */
export function fallbackText(files) {
  if (!files?.length) return '';
  return `Вложение: ${files[0].name}${files.length > 1 ? ` и ещё ${files.length - 1}` : ''}`;
}

/** Ответ консоли или Telegram → причина владельцу и можно ли повторить (таблица та же, что у страницы /queue). */
export function failureOf(err) {
  const status = err?.status;
  const msg = typeof err?.message === 'string' ? err.message : '';
  // Текст ответа консоли может нести эхо имени или тела запроса — в причину не длиннее 200 символов.
  const lower = msg ? clip(msg.charAt(0).toLowerCase() + msg.slice(1), 200) : '';
  if (err?.tooBig) return { reason: `больше ${mb(BOT_API_MAX_BYTES)} не принимается — обрежьте лог или пришлите ссылку текстом`, retry: false };
  if (status === 404) return { reason: 'задача удалена', retry: false };
  if (status === 409 || status === 413 || status === 415 || status === 422) return { reason: lower || 'файл не принят', retry: false };
  if (status === 401 || status === 403) return { reason: 'консоль не приняла токен бота', retry: false };
  if (status === 429) return { reason: 'слишком часто — повторю позже', retry: true };
  if (status >= 500) return { reason: lower || `ошибка консоли (${status})`, retry: true };
  return { reason: 'нет связи с консолью или Telegram', retry: true };
}

/**
 * Строка о файлах в карточке «Принято»: пока грузятся — счётчик, потом итог и что не принято. Имя и причина — с
 * потолком: пять длинных причин из ответа консоли иначе выводили карточку за 4096 символов, и итог не показывался.
 */
export function filesLine(e) {
  const total = e.files.length + e.failed.length;
  const done = e.files.filter((f) => f.status === 'done').length;
  const failed = [...e.failed, ...e.files.filter((f) => f.status === 'failed').map((f) => ({ name: f.name, reason: f.reason }))];
  const busy = e.files.some((f) => f.status === 'pending');
  if (busy) return `📎 Файлы: ${done} из ${total}, загружаю…`;
  if (!failed.length) return `📎 Файлы: ${done} из ${total} ✓`;
  const list = failed.slice(0, 5).map((f) => `${clip(f.name, 80)} — ${clip(f.reason, 160)}`).join('; ');
  return `📎 Файлы: ${done} из ${total}. Не приняты: ${list}${failed.length > 5 ? ` и ещё ${failed.length - 5}` : ''}`;
}

/**
 * Очередь загрузок. download(fileId, path, maxBytes) — Telegram во временный файл; upload(itemId, name, path) —
 * в консоль; getItem/putItem — пункт (filesFailed пишется в конце); render(itemId, entry) — правка карточки «Принято».
 * paintGapMs — пауза между правками карточки одного пункта; tmpBudget — потолок временных файлов на диске.
 */
export function createUploader({ store, home, download, upload, getItem, putItem, render, log, now = () => Date.now(), schedule = setTimeout,
  paintGapMs = PAINT_GAP_MS, tmpBudget = TMP_BUDGET_BYTES }) {
  const all = () => (store.state.fileUploads ||= {});
  const dir = join(home, 'files-tmp');
  let running = false;
  let stopped = false;
  let timer = null;

  const rmQuiet = (p) => { if (p) rmSync(p, { force: true }); };
  const settled = (e) => e.files.every((f) => f.status !== 'pending');
  // Сбой записи state.json (диск, EBUSY) не обрывает очередь: файлы догрузятся, а при перезапуске консоль схлопнет
  // повтор того же файла по содержимому.
  const save = () => {
    try { store.saveState(); } catch (err) { log(`очередь файлов: состояние не сохранено — ${err?.message || err}`); }
  };
  /** Сколько места уже заняли скачанные, но не отправленные файлы всех очередей. */
  const tmpUsed = () => {
    let bytes = 0;
    for (const e of Object.values(all())) {
      for (const x of e.files) {
        if (!x.tmp) continue;
        try { bytes += statSync(x.tmp).size; } catch { /* уже удалён */ }
      }
    }
    return bytes;
  };

  // Правки карточки — по одной на пункт и не чаще paintGapMs: всплеск событий (альбом из десяти фото) схлопывается в
  // правку с последним состоянием, а сбой правки (429, сеть) повторяется с паузой — итог «Файлы: N из N» не теряется.
  const paints = new Map();
  const startFlush = (itemId, p) => flush(itemId, p).catch((err) => log(`карточка ${itemId}: ${logName(err?.message || err)}`));
  function paint(itemId) {
    let p = paints.get(itemId);
    if (!p) paints.set(itemId, (p = { busy: false, dirty: false, timer: null, tries: 0, lastAt: -Infinity }));
    p.dirty = true;
    if (!p.busy && !p.timer) startFlush(itemId, p);
  }
  async function flush(itemId, p) {
    while (p.dirty && !stopped) {
      const wait = p.lastAt + paintGapMs - now();
      if (wait > 0) {
        p.timer = schedule(() => { p.timer = null; startFlush(itemId, p); }, wait);
        return;
      }
      const e = all()[itemId];
      if (!e) { p.dirty = false; break; }
      p.dirty = false;
      p.busy = true;
      p.lastAt = now();
      try {
        await render(itemId, e);
        p.tries = 0;
      } catch (err) {
        if (p.tries >= PAINT_RETRY_S.length) {
          log(`карточка ${itemId}: строка файлов не обновилась после ${p.tries + 1} попыток — ${logName(err?.message || err)}`);
          p.tries = 0;
        } else {
          const s = Number(err?.retryAfter) > 0 ? Number(err.retryAfter) : PAINT_RETRY_S[p.tries];
          p.tries += 1;
          p.dirty = true; // последнее состояние ещё не показано
          p.lastAt = now() + s * 1000 - paintGapMs;
        }
      } finally {
        p.busy = false;
      }
    }
    // Время последней правки нужно, пока пункт в очереди: иначе следующее событие правило бы карточку без паузы.
    if (!p.dirty && !p.timer && !all()[itemId]) paints.delete(itemId);
  }

  function plan() {
    const t = now();
    let next = Infinity;
    for (const [itemId, e] of Object.entries(all())) {
      if (e.settledAt) {
        // Итог в пункт ещё не записан — повтор записи по своему сроку.
        if (e.finishAt && e.finishAt <= t) return { job: { itemId, finish: true }, next: 0 };
        if (e.finishAt) next = Math.min(next, e.finishAt - t);
        continue;
      }
      for (const f of e.files) {
        if (f.status !== 'pending') continue;
        if (f.nextAt <= t) return { job: { itemId, file: f }, next: 0 };
        next = Math.min(next, f.nextAt - t);
      }
    }
    return { job: null, next };
  }

  async function step(itemId, f) {
    const e = all()[itemId];
    try {
      if (now() - e.startedAt > UPLOAD_TTL_MS) throw Object.assign(new Error('не дождался связи за час'), { expired: true });
      // Имя временного файла постоянное, а скачивание — в .part с переименованием после полного файла: после
      // перезапуска бот находит целый файл и не идёт к Telegram снова, а недокачанный не уйдёт в консоль как целый.
      // uniqueId кодируется, а не «чистится»: замена символов склеила бы разные файлы в один путь.
      const tmp = join(dir, `${itemId}-${Buffer.from(String(f.uniqueId)).toString('base64url')}`);
      if (!existsSync(tmp)) {
        if (tmpUsed() + (Number(f.size) || 0) > tmpBudget) throw Object.assign(new Error('нет места для временных файлов'), { noSpace: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          await download(f.fileId, `${tmp}.part`, BOT_API_MAX_BYTES);
        } catch (e) {
          rmQuiet(`${tmp}.part`);
          throw e;
        }
        renameSync(`${tmp}.part`, tmp);
      }
      f.tmp = tmp;
      delete f.waitSpace;
      const res = await upload(itemId, f.name, tmp);
      f.status = 'done';
      f.doneAt = now();
      // Тот же файл уже был в пункте (консоль схлопнула дубль по содержимому): загружен, но новым не считается.
      if (res?.duplicate === true) f.duplicate = true;
      rmQuiet(f.tmp);
      delete f.tmp;
    } catch (err) {
      if (err?.noSpace) {
        // Место освободится, когда консоль примет уже скачанное: попытки не тратятся, срок — тот же час очереди.
        if (!f.waitSpace) log(`файл ${logName(f.name)} к ${itemId}: ждёт места — временные файлы заняли ${mb(tmpBudget)}`);
        f.waitSpace = true;
        f.nextAt = now() + SPACE_WAIT_S * 1000;
        save();
        return;
      }
      const why = err?.expired ? { reason: 'не дождался связи с консолью за час', retry: true } : failureOf(err);
      if (why.retry && !err?.expired && f.attempts < RETRY_S.length) {
        f.nextAt = now() + RETRY_S[f.attempts] * 1000;
        f.attempts += 1;
      } else {
        f.status = 'failed';
        f.reason = why.reason;
        f.retry = why.retry;
        rmQuiet(f.tmp);
        delete f.tmp;
      }
      // Причина — текст ответа консоли, а он может нести присланное имя: в журнал — тоже очищенной.
      log(`файл ${logName(f.name)} к ${itemId}: ${logName(why.reason)}${f.status === 'pending' ? ` — повтор через ${RETRY_S[f.attempts - 1]} с` : ''}`);
    }
    save();
    if (settled(e)) await finish(itemId, e);
    else paint(itemId);
  }

  /**
   * Всё решено: что не дошло — в пункт (filesFailed), карточка — итогом. Запись пункта — с ifVersion, до 3 попыток
   * подряд; не вышло (сеть, 5xx, три 409) — ещё раз позже (FINISH_RETRY_S): иначе пункт навсегда ждал бы файлы.
   */
  async function finish(itemId, e) {
    e.settledAt ??= now();
    delete e.finishAt;
    save();
    const failed = [...e.failed, ...e.files.filter((f) => f.status === 'failed').map((f) => ({ name: f.name, reason: f.reason }))]
      .slice(0, MAX_FILES).map((f) => ({ name: String(f.name).slice(0, 200), reason: String(f.reason).slice(0, 200) }));
    // Дубли по содержимому из ожиданий агента убираются (иначе «ещё загружаются 1 из 2» час). Число ожидаемых
    // пишется абсолютным, посчитанным один раз и сохранённым до записи: ответ на запись мог потеряться (обрыв после
    // отправки), и повтор вычел бы дубли второй раз.
    const duplicates = e.files.filter((f) => f.duplicate && !f.counted);
    let written = false;
    for (let i = 0; i < 3 && !written; i++) {
      try {
        const doc = await getItem(itemId);
        // Ответ не про этот пункт — ничего не пишем: иначе данные одного пункта легли бы в другой.
        if (!doc?.data?.inbox || (doc.id !== undefined && doc.id !== itemId)) { written = true; break; }
        const inbox = { ...doc.data.inbox };
        if (failed.length) inbox.filesFailed = failed;
        else delete inbox.filesFailed;
        if (duplicates.length) {
          const base = e.expectedTarget ?? inbox.filesExpected;
          if (base > 0) e.expectedTarget = Math.max(0, base - duplicates.length);
          for (const f of duplicates) f.counted = true;
          duplicates.length = 0;
          save();
        }
        if (e.expectedTarget !== undefined) inbox.filesExpected = e.expectedTarget;
        if (JSON.stringify(inbox.filesFailed || null) !== JSON.stringify(doc.data.inbox.filesFailed || null)
          || inbox.filesExpected !== doc.data.inbox.filesExpected) {
          await putItem(itemId, { ...doc.data, inbox }, doc.version);
        }
        written = true;
      } catch (err) {
        if (err?.status === 404) { written = true; break; } // пункт удалён — писать некуда
        if (err?.status !== 409) { log(`filesFailed для ${itemId} не записан: ${logName(err?.message || err)}`); break; }
        if (i === 2) log(`filesFailed для ${itemId} не записан: пункт трижды меняли во время записи`);
      }
    }
    if (written) {
      delete e.finishTries;
      delete e.expectedTarget;
    } else {
      e.finishTries = (e.finishTries || 0) + 1;
      if (e.finishTries <= FINISH_RETRY_S.length) e.finishAt = now() + FINISH_RETRY_S[e.finishTries - 1] * 1000;
      else log(`filesFailed для ${itemId} так и не записан за ${e.finishTries} попытки — агент увидит «не дошли» через час`);
    }
    save();
    paint(itemId);
  }

  async function drain() {
    for (;;) {
      if (stopped) return;
      const { job, next } = plan();
      if (job) {
        if (job.finish) await finish(job.itemId, all()[job.itemId]);
        else await step(job.itemId, job.file);
        continue;
      }
      // Один таймер на очередь: прежний (его поставил прошлый проход) снимается, иначе после stop() сработал бы старый.
      if (timer) clearTimeout(timer);
      timer = next !== Infinity ? schedule(kick, Math.max(50, next)) : null;
      return;
    }
  }

  async function kick() {
    if (running) return;
    running = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { await drain(); } finally { running = false; }
  }

  /** Новый пункт с файлами. entry: { chatId, cardId, base, files: [{fileId, uniqueId, name, size}], failed: [{name, reason}] }. */
  function enqueue(itemId, entry) {
    const prev = all()[itemId];
    const files = entry.files.map((f) => ({ fileId: f.fileId, uniqueId: f.uniqueId, name: f.name, size: f.size, status: 'pending', attempts: 0, nextAt: 0 }));
    if (prev && !prev.settledAt) {
      // Докрепление к пункту, который ещё грузится: в ту же очередь, без повторов.
      for (const f of files) if (!prev.files.some((x) => x.uniqueId === f.uniqueId)) prev.files.push(f);
      prev.failed.push(...entry.failed);
    } else {
      all()[itemId] = { chatId: entry.chatId, cardId: entry.cardId, base: entry.base, startedAt: now(), failed: [...entry.failed], files };
    }
    save();
    paint(itemId);
    // Не ждём загрузки: обработка апдейтов Telegram не должна стоять, пока едут файлы.
    kick().catch((err) => log(`очередь файлов: ${err?.message || err}`));
    return true;
  }

  /** «Повторить»: то, что не дошло из-за связи, — ещё раз (файл заново у Telegram: временный уже удалён). */
  function retry(itemId) {
    const e = all()[itemId];
    if (!e) return false;
    const again = e.files.filter((f) => f.status === 'failed' && f.retry);
    if (!again.length) return false;
    for (const f of again) Object.assign(f, { status: 'pending', attempts: 0, nextAt: 0, reason: undefined, retry: undefined });
    e.startedAt = now();
    delete e.settledAt;
    save();
    paint(itemId);
    kick().catch((err) => log(`очередь файлов: ${err?.message || err}`));
    return true;
  }

  /** Решённые очереди старше часа — из state; временные файлы без живой очереди старше 2 часов — с диска. */
  function prune() {
    const t = now();
    for (const [itemId, e] of Object.entries(all())) {
      if (e.settledAt && !e.finishAt && t - e.settledAt > KEEP_SETTLED_MS) {
        for (const f of e.files) rmQuiet(f.tmp);
        delete all()[itemId];
      }
    }
    save();
    for (const [itemId, p] of paints) if (!all()[itemId] && !p.busy && !p.timer) paints.delete(itemId);
    const live = new Set(Object.values(all()).flatMap((e) => e.files.filter((f) => f.status === 'pending').map((f) => f.tmp)).filter(Boolean));
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      if (live.has(p) || live.has(p.replace(/\.part$/, ''))) continue;
      try { if (t - statSync(p).mtimeMs > ORPHAN_TMP_MS) rmQuiet(p); } catch { /* уже нет */ }
    }
  }

  /** Другая подпись над строкой хода (режим прикрепления закрыт): очередь продолжает править то же сообщение. */
  function rebase(itemId, base) {
    const e = all()[itemId];
    if (!e) return;
    e.base = base;
    save();
    paint(itemId);
  }

  /**
   * Карточку показали позже постановки (очередь ставится до неё, #314): ход загрузки правит это сообщение и
   * перерисовывается поверх — показ карточки затёр строку, нарисованную при постановке. base — текст показанной
   * карточки: статус автопередачи узнаётся уже после постановки, и строка хода дописывается к нему, а не к прежнему.
   */
  function setCard(itemId, cardId, base) {
    const e = all()[itemId];
    if (!e || !cardId) return;
    if (e.cardId !== cardId || (base && e.base !== base)) {
      e.cardId = cardId;
      if (base) e.base = base;
      save();
    }
    paint(itemId);
  }

  const entry = (itemId) => all()[itemId] || null;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const p of paints.values()) if (p.timer) clearTimeout(p.timer);
    paints.clear();
  };
  return { enqueue, retry, kick, prune, rebase, setCard, entry, stop };
}
