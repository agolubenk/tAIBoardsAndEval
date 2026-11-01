/**
 * Вложения на странице /queue (files-plan v3): «📎» и чипы в форме «Поставить задачу», загрузка после создания пункта
 * с прогрессом и «Отменить», список вложений в карточке входящего, «📎 Добавить файл», «Удалить», тихая строка места.
 *
 * Скрипт ставится до кода страницы (page.ts) и отдаёт ей window.__oqFiles: форма спрашивает, есть ли файлы, и после
 * создания пункта зовёт upload(); карточка входящего берёт свой блок у cardHtml(). Без скрипта или с выключенным
 * хранилищем (сводка enabled: false) страница работает как раньше, «📎» скрыт.
 *
 * Сеть: одна сводка /files/summary с ETag вместо запроса на каждую карточку — при смене входящих, после своих загрузок
 * и, пока у пункта ждут файлы (filesExpected), раз в 4 с (в фоне — 30 с). Тело загрузки — сам файл (XHR ради прогресса).
 * Имена файлов — данные третьих лиц: в DOM только textContent или экранирование.
 *
 * Здесь — отправка файла, сводка и карточки; чистые функции — page-files-pure.ts, форма — page-files-compose.ts.
 * Всё собирается в один скрипт (FILES_JS) с общей областью видимости.
 */
import { FILES_PURE } from './page-files-pure'
import { FILES_COMPOSE } from './page-files-compose'

const FILES_DOM = String.raw`
var API = '/api/oq/v1/files';
var state = { enabled: null, limits: OQF_DEFAULT_LIMITS, usage: null, items: {} };
var metas = {};   // id входящего → { expected, failed, receivedAt } из пункта (их передаёт страница через cardHtml)
var runs = {};    // id входящего → загрузка из карточки: { busy, at, of, errors, xhr, cancelled }
// Пункты, чьи строки файлов не вошли в сводку (старые): список догружается по «показать» и обновляется со сводкой.
var full = {}, expanded = {}, fullErr = {};
var announceEl = document.getElementById('oqf-announce');
function announce(text) { if (announceEl) announceEl.textContent = text; }
var dbP = window.claude && window.claude.use ? window.claude.use('db').catch(function () { return null; }) : Promise.resolve(null);

/** Один файл телом запроса; XHR — ради прогресса. run.xhr — для «Отменить». */
function sendFile(itemId, file, onProgress, run) {
  return new Promise(function (resolve) {
    var xhr = new XMLHttpRequest();
    if (run) run.xhr = xhr;
    xhr.open('POST', API + '?item=' + encodeURIComponent(itemId));
    xhr.setRequestHeader('X-Ops-Csrf', '1');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'файл'));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = oqfUploadTimeout(file.size);
    if (xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = function () {
      // 200 — тот же файл уже был в пункте (сервер схлопнул дубль по содержимому): загружен, но новым не считается.
      if (xhr.status === 200 || xhr.status === 201) { var dup = false; try { dup = JSON.parse(xhr.responseText).duplicate === true; } catch (e) { /* не JSON */ } resolve({ ok: true, duplicate: dup }); return; }
      var m = ''; try { m = JSON.parse(xhr.responseText).error || ''; } catch (e) { /* не JSON */ }
      var r = oqfUploadError(xhr.status, m);
      resolve({ ok: false, reason: r.reason, retry: r.retry });
    };
    xhr.onerror = function () { resolve({ ok: false, reason: 'нет связи с сервером', retry: true }); };
    xhr.ontimeout = function () { resolve({ ok: false, reason: 'слишком долго — повторите', retry: true }); };
    xhr.onabort = function () { resolve({ ok: false, reason: 'отменено', retry: true }); };
    xhr.send(file);
  });
}
/** Что не дошло — в пункт (inbox.filesFailed): агент видит, а не ждёт. Пункт мог измениться — перечитать и повторить. */
/**
 * Поправить файловые поля входящего (filesFailed, filesExpected): пункт мог измениться — перечитать и повторить с
 * ifVersion. Три 409 подряд — ошибка, а не тихий выход: страница скажет, что агент не узнает причины (линза GLM #313).
 */
function patchInbox(itemId, change) {
  return dbP.then(async function (db) {
    if (!db) return;
    for (var i = 0; i < 3; i++) {
      var doc = await db.doc('items/' + itemId).get();
      var d = doc && doc.data;
      if (!d || d.kind !== 'inbox' || !d.inbox) return;
      var ib = change(Object.assign({}, d.inbox));
      if (!ib) return;
      try { await db.doc('items/' + itemId).set(Object.assign({}, d, { inbox: ib }), { ifVersion: doc.version }); return; }
      catch (e) { if (!e || e.status !== 409) throw e; }
    }
    throw new Error('пункт меняется параллельно');
  });
}
/** Что не дошло и сколько ждать: дубли по содержимому сервер схлопнул — их из ожиданий убираем. */
function recordFailed(itemId, failed, duplicates) {
  return patchInbox(itemId, function (ib) {
    if (failed.length) ib.filesFailed = failed.slice(0, OQF_MAX_CHIPS).map(function (f) { return { name: String(f.name).slice(0, 200), reason: String(f.reason).slice(0, 200) }; });
    else delete ib.filesFailed;
    if (duplicates > 0 && ib.filesExpected > 0) ib.filesExpected = Math.max(0, ib.filesExpected - duplicates);
    return ib;
  });
}

// ── Сводка: одна на страницу, с ETag ──────────────────────────────────────────────────────────────────────────
var etag = null, inflight = null, again = false, timer = null;
function readyOf(id) { var s = state.items[id]; return s ? Math.max(s.count || 0, s.files.length) : 0; }
function filesOf(id) { var s = state.items[id]; return full[id] || (s ? s.files : []); }
// focus — догрузка по нажатию «показать»: кнопка исчезает, фокус переходит на первый файл, а не теряется.
function loadFull(id, focus) {
  return fetch(API + '?item=' + encodeURIComponent(id), { credentials: 'same-origin' })
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (j) {
      var clean = oqfCleanSummary({ enabled: true, items: { x: { files: j.files } } }).items.x;
      full[id] = clean ? clean.files : [];
      delete fullErr[id];
    })
    .catch(function () {
      delete full[id]; delete expanded[id];
      // По нажатию «показать» — сказать, что не вышло (кнопка вернётся с этим текстом); фоновая догрузка молчит.
      if (focus) { fullErr[id] = true; announce('Не удалось загрузить список вложений — нажмите ещё раз'); }
    })
    .then(function () {
      paintCard(id);
      if (!focus) return;
      var el = cardEl(id);
      var target = el && el.querySelector('.oqf-file, .oqf-more, .oqf-add');
      if (target) target.focus();
    });
}
function anyLoading() { var now = Date.now(); return Object.keys(metas).some(function (id) { return oqfPending(metas[id], readyOf(id), now) === 'loading'; }); }
// Пауза после сбоя сводки, 0 — сбоя не было. Без первой сводки форма прячет вложения (state.enabled не true), поэтому
// повтор нужен и тогда, когда ничего не грузится: 15 с, дальше вдвое, не реже раза в 5 минут.
var errDelay = 0, retryAt = 0;
function schedule() {
  clearTimeout(timer);
  if (errDelay) { retryAt = Date.now() + errDelay; timer = setTimeout(refresh, errDelay); }
  else if (state.enabled === true && anyLoading()) timer = setTimeout(refresh, document.hidden ? 30000 : 4000);
}
function refresh() {
  if (inflight) { again = true; return inflight; }
  var waited = anyLoading();
  inflight = fetch(API + '/summary', { credentials: 'same-origin', headers: etag ? { 'If-None-Match': etag } : {} })
    .then(function (res) {
      if (res.status === 304) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      etag = res.headers.get('ETag');
      return res.json();
    })
    .then(function (j) {
      errDelay = 0;
      if (j) {
        var s = oqfCleanSummary(j); state.enabled = s.enabled; state.items = s.items;
        if (s.enabled) { state.limits = s.limits; state.usage = s.usage; }
        // Раскрытые старые пункты — свежий список; остальные догруженные списки устарели.
        full = {};
        Object.keys(expanded).forEach(function (id) { if (cardEl(id)) loadFull(id); else delete expanded[id]; });
      }
      // Час ожидания мог истечь без новых файлов: «грузятся» → «не дошли» — перерисовать и при 304.
      if (j || waited) paintAll();
    })
    // Сводка — подсказка, не данные очереди: при сбое оставляем прошлую и повторяем с нарастающей паузой.
    .catch(function () { errDelay = Math.min(errDelay ? errDelay * 2 : 15000, 300000); })
    .then(function () {
      inflight = null;
      // После сбоя отложенный запрос (again) сразу не шлётся: на плохой сети он упал бы следом и удвоил паузу.
      // Его заменяет повтор по errDelay.
      if (again && !errDelay) { again = false; refresh(); } else { again = false; schedule(); }
    });
  return inflight;
}
document.addEventListener('visibilitychange', function () { if (!document.hidden && (anyLoading() || errDelay)) refresh(); });

// ── Карточка входящего ──────────────────────────────────────────────────────────────────────────────────────
function cardInner(id) {
  var s = state.items[id] || { files: [], count: 0, expired: 0 };
  var meta = metas[id] || null;
  var run = runs[id] || null;
  var list = filesOf(id);
  var ready = readyOf(id);
  var html = '';
  // Строки файлов старого пункта не вошли в сводку — счётчик и «показать», а не пустая карточка.
  if (ready > list.length && !full[id]) {
    html += '<button type="button" class="oqf-more" data-oqf-more="' + oqfEsc(id) + '"' + (expanded[id] ? ' disabled' : '') + '>📎 Вложений: ' + ready + (expanded[id] ? ' — загружаю…' : fullErr[id] ? ' — не загрузилось, показать ещё раз' : ' — показать') + '</button>';
  } else if (list.length) {
    html += '<ul class="oqf-list" aria-label="Вложения">' + list.map(function (f) {
      return '<li><a class="oqf-file" href="' + API + '/' + f.id + '" download>' + oqfEsc(f.name) + '</a><span class="oqf-size">' + oqfSize(f.size) + '</span>' +
        '<button type="button" class="oqf-del" data-oqf-file="' + f.id + '" data-oqf-name="' + oqfEsc(f.name) + '" aria-label="Удалить файл ' + oqfEsc(f.name) + '"' + (run && run.busy ? ' disabled' : '') + '>Удалить</button></li>';
    }).join('') + '</ul>';
  }
  var pend = oqfPending(meta, ready, Date.now());
  if (pend === 'loading') html += '<p class="oqf-note">Файлы ещё загружаются: ' + ready + ' из ' + meta.expected + '</p>';
  if (pend === 'lost') html += '<p class="oqf-note oqf-warn">Дошли не все файлы: ' + ready + ' из ' + meta.expected + ' — добавьте недостающие</p>';
  if (meta && meta.failed && meta.failed.length) {
    html += '<p class="oqf-note oqf-warn">Не приняты:</p><ul class="oqf-failed">' + meta.failed.map(function (f) { return '<li>' + oqfEsc(f.name) + ' — ' + oqfEsc(f.reason) + '</li>'; }).join('') + '</ul>';
  }
  if (s.expired) html += '<p class="oqf-note">Файлы удалены по сроку (' + state.limits.retentionDays + ' ' + oqfPlural(state.limits.retentionDays, 'день', 'дня', 'дней') + '): ' + s.expired + '</p>';
  if (run && run.errors.length) {
    html += '<ul class="oqf-errs" aria-label="Не загружено">' + run.errors.map(function (e, i) {
      return '<li>' + oqfEsc(e.name) + ' — ' + oqfEsc(e.reason) + (e.file && !run.busy ? ' <button type="button" class="oqf-retry" data-oqf-retry="' + i + '">Повторить</button>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  if (state.enabled === true && ready < state.limits.maxPerItem) {
    html += '<button type="button" class="oqf-add"' + (run && run.busy ? ' disabled' : '') + '>📎 Добавить файл</button>';
  }
  return html;
}
/**
 * Прогресс и «Отменить» — отдельным блоком: опрос сводки приносит уже загруженный первый файл и меняет список, но
 * блок загрузки при этом не пересоздаётся — индикатор не откатывается к нулю, нажатие «Отменить» не теряется.
 */
function cardRun(id) {
  var run = runs[id] || null;
  if (!(run && run.busy)) return '';
  return '<div class="oqf-run"><progress max="1" value="0" aria-label="Загрузка файла ' + run.at + ' из ' + run.of + '"></progress>' +
    '<button type="button" class="oqf-cancel" data-oqf-cancel="' + oqfEsc(id) + '">Отменить</button></div>';
}
function cardHtml(it) {
  if (!it || typeof it.id !== 'string') return '';
  if (it.files) metas[it.id] = it.files; else delete metas[it.id];
  var body = state.enabled === null ? '' : cardInner(it.id);
  var runHtml = state.enabled === null ? '' : cardRun(it.id);
  return '<div class="oqf-card" data-oqf-item="' + oqfEsc(it.id) + '"' + (body || runHtml ? '' : ' hidden') + '>' +
    '<div class="oqf-body">' + body + '</div><div class="oqf-run-slot">' + runHtml + '</div></div>';
}
function cardEl(id) {
  var all = document.querySelectorAll('.oqf-card[data-oqf-item]');
  for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-oqf-item') === id) return all[i];
  return null;
}
// Блок пересобирается только когда изменилось его содержимое: опрос сводки не должен выбивать кнопку из-под пальца
// или сбрасывать прогресс (он двигается свойством value, не разметкой).
function paintSlot(el, html) {
  if (!el || el.__oqfInner === html) return;
  el.__oqfInner = html;
  el.innerHTML = html;
}
function paintCard(id) {
  var el = cardEl(id);
  if (!el) return;
  var body = cardInner(id);
  var runHtml = cardRun(id);
  el.hidden = !body && !runHtml;
  paintSlot(el.querySelector('.oqf-body'), body);
  paintSlot(el.querySelector('.oqf-run-slot'), runHtml);
}
// После загрузки или удаления фокус — на «Добавить файл»; его нет (лимит) — на последний файл.
function focusAdd(id) {
  var el = cardEl(id);
  if (!el) return;
  var links = el.querySelectorAll('.oqf-file');
  var target = el.querySelector('.oqf-add') || links[links.length - 1];
  if (target) target.focus();
}
function paintAll() {
  document.querySelectorAll('.oqf-card[data-oqf-item]').forEach(function (el) { paintCard(el.getAttribute('data-oqf-item')); });
  var usageEl = document.getElementById('oqf-usage');
  if (usageEl) {
    var u = state.enabled === true ? oqfUsage(state.usage) : null;
    usageEl.hidden = !u;
    usageEl.textContent = u ? u.text : '';
    usageEl.classList.toggle('warn', !!(u && u.warn));
  }
  if (compose) compose.paint();
}
var lastSig = '';
function itemsChanged() {
  // Карточки перемонтированы: метаданные ушедших пунктов больше не нужны; новые входящие — повод спросить сводку.
  var live = {};
  document.querySelectorAll('.oqf-card[data-oqf-item]').forEach(function (el) { live[el.getAttribute('data-oqf-item')] = true; });
  Object.keys(metas).forEach(function (id) { if (!live[id]) delete metas[id]; });
  var sig = JSON.stringify(Object.keys(live).sort().map(function (id) { var m = metas[id]; return [id, m ? m.expected : 0, m && m.failed ? m.failed.length : 0]; }));
  // В паузе после сбоя перерисовка карточек ждёт назначенного повтора: иначе её запрос упал бы следом и удвоил паузу
  // (живой прогон 22.10: первый повтор вместо 15 с — через 30).
  if (sig !== lastSig) { lastSig = sig; if (!(errDelay && Date.now() < retryAt)) refresh(); } else schedule();
}

/** Докрепить к существующему входящему: по одному файлу, прогресс и ошибки — в карточке; keep — прошлые ошибки. */
async function cardUpload(id, files, keep) {
  var plan = oqfPlan(files, state.limits, state.limits.maxPerItem - readyOf(id));
  var pre = plan.failed.map(function (f) { return { name: f.name, reason: f.reason, file: null }; });
  if (plan.skipped) pre.push({ name: 'ещё ' + plan.skipped + ' ' + oqfPlural(plan.skipped, 'файл', 'файла', 'файлов'), reason: 'за один раз — не больше ' + OQF_MAX_CHIPS, file: null });
  var run = runs[id] = { busy: true, at: 0, of: plan.send.length, cancelled: false, xhr: null, errors: (keep || []).concat(pre) };
  for (var i = 0; i < plan.send.length; i++) {
    var row = plan.send[i];
    if (run.cancelled) { run.errors.push({ name: row.name, reason: 'отменено', file: row.file }); continue; }
    run.at = i + 1;
    paintCard(id);
    announce('Загружаю файл ' + run.at + ' из ' + run.of + ': ' + row.name);
    var res = await sendFile(id, row.file, (function (size) {
      return function (loaded) { var el = cardEl(id); var p = el && el.querySelector('progress'); if (p) p.value = size ? loaded / size : 1; };
    })(row.file.size), run);
    if (!res.ok) run.errors.push({ name: row.name, reason: res.reason, file: res.retry ? row.file : null });
  }
  run.busy = false;
  // Строка «ещё N файлов» — одна на N несданных.
  var notSent = run.errors.length + Math.max(0, plan.skipped - 1);
  announce(notSent ? 'Не загружено файлов: ' + notSent : plan.send.length ? 'Файлы добавлены' : '');
  paintCard(id);
  await refresh();
  focusAdd(id);
}
var cardInput = document.getElementById('oqf-card-input');
var pickFor = null;
if (cardInput) cardInput.addEventListener('change', function () {
  var files = Array.prototype.slice.call(cardInput.files || []);
  cardInput.value = '';
  if (pickFor && files.length) cardUpload(pickFor, files);
  pickFor = null;
});
document.addEventListener('click', function (ev) {
  var t = ev.target;
  var card = t.closest && t.closest('.oqf-card[data-oqf-item]');
  if (!card) return;
  var id = card.getAttribute('data-oqf-item');
  if (t.closest('.oqf-add')) { if (cardInput && !(runs[id] && runs[id].busy)) { pickFor = id; cardInput.click(); } return; }
  if (t.closest('.oqf-more')) { if (!expanded[id]) { expanded[id] = true; delete fullErr[id]; paintCard(id); loadFull(id, true); } return; }
  var cancel = t.closest('.oqf-cancel');
  if (cancel) { var r = runs[id]; if (r && r.busy) { r.cancelled = true; if (r.xhr) r.xhr.abort(); } return; }
  var retry = t.closest('.oqf-retry');
  if (retry) {
    var prev = runs[id];
    var e = prev && !prev.busy && prev.errors[Number(retry.getAttribute('data-oqf-retry'))];
    if (!e || !e.file) return;
    cardUpload(id, [e.file], prev.errors.filter(function (x) { return x !== e; }));
    return;
  }
  var del = t.closest('.oqf-del');
  if (del) {
    var name = del.getAttribute('data-oqf-name') || 'файл';
    if (!window.confirm('Удалить файл «' + name + '»? Агент его больше не увидит.')) return;
    del.disabled = true;
    fetch(API + '/' + del.getAttribute('data-oqf-file'), { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Ops-Csrf': '1' } })
      .then(function (res) {
        if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + res.status)); });
        announce('Файл удалён: ' + name);
        // Владелец убрал файл сам: ждать его агенту больше нечего — ожидание уменьшается (иначе «ещё загружаются 4 из 5»).
        patchInbox(id, function (ib) { if (!(ib.filesExpected > 0)) return null; ib.filesExpected -= 1; return ib; }).catch(function () { /* агент увидит «дошли не все» */ });
        // Отказы прошлой загрузки («сверх лимита») после удаления устарели; те, что можно повторить, остаются.
        var r = runs[id];
        if (r && !r.busy) r.errors = r.errors.filter(function (x) { return x.file; });
      })
      .catch(function (err) { var r = runs[id] || (runs[id] = { busy: false, at: 0, of: 0, errors: [] }); r.errors.push({ name: name, reason: 'не удалён: ' + err.message, file: null }); })
      .then(function () { return refresh(); })
      .then(function () { paintCard(id); focusAdd(id); });
  }
});
// Файл, брошенный мимо формы, браузер открыл бы вместо страницы — со страницы очереди не уходим.
function dragsFiles(e) { return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0); }
document.addEventListener('dragover', function (e) { if (dragsFiles(e)) e.preventDefault(); });
document.addEventListener('drop', function (e) { if (dragsFiles(e)) e.preventDefault(); });

// ── Форма «Поставить задачу» — page-files-compose.ts ─────────────────────────────────────────────────────────
${FILES_COMPOSE}

window.__oqFiles = { cardHtml: cardHtml, itemsChanged: itemsChanged, compose: compose ? compose.api : null };
refresh();
`

export const FILES_JS = `(function () {\n  'use strict';\n${FILES_PURE}\n${FILES_DOM}\n})();`
