/**
 * Вложения в форме «Поставить задачу» (files-plan v3): «📎» и чипы под полем, вставка из буфера и перетаскивание,
 * загрузка после создания пункта с прогрессом и «Отменить», список незагруженного с «Повторить». Строка — часть
 * скрипта page-files.ts: пользуется его state, sendFile, recordFailed, refresh, announce и dragsFiles.
 */
export const FILES_COMPOSE = String.raw`
var compose = (function () {
  var root = document.getElementById('oqf-compose');
  if (!root) return null;
  var section = document.getElementById('compose');
  var pick = document.getElementById('oqf-pick');
  var input = document.getElementById('oqf-input');
  var hintEl = document.getElementById('oqf-hint');
  var chipsEl = document.getElementById('oqf-chips');
  var runEl = document.getElementById('oqf-run');
  var bar = document.getElementById('oqf-progress');
  var cancelEl = document.getElementById('oqf-cancel');
  var leftEl = document.getElementById('oqf-left');
  var list = [];
  var listeners = [];
  var locked = false, online = false;
  var run = null;
  // Что не дошло — по задачам (новая отправка не стирает список прошлой): pre — отказ до отправки (размер, лимит),
  // errs — сбой загрузки (можно повторить), note — агенту не удалось записать причины. «Скрыть» только прячет:
  // незагруженное остаётся незагруженным (unresolved), статус формы не врёт.
  var lefts = []; // [{ itemId, pre: [{name, reason}], errs: [{name, reason, file}], hidden, note }]
  function leftOf(itemId) { for (var i = 0; i < lefts.length; i++) if (lefts[i].itemId === itemId) return lefts[i]; return null; }
  function dropLeft(entry) { lefts = lefts.filter(function (x) { return x !== entry; }); }
  var chipsSig = '', leftSig = '';

  function usable() { return state.enabled === true && online && !locked; }
  function changed() { paint(); listeners.forEach(function (cb) { try { cb(); } catch (e) { console.error(e); } }); }
  // Отказ взять файл — видно в строке подсказки (и в live-регионе): перетащенный или вставленный файл не пропадает молча.
  var notice = '';
  function busyWhy() {
    return state.enabled !== true ? 'вложения сейчас недоступны' : !online ? 'нет связи с очередью' : 'идёт отправка — добавьте его после неё';
  }
  function add(files) {
    if (!files || !files.length) return;
    if (!usable()) { notice = 'Файл не прикреплён: ' + busyWhy() + '.'; announce(notice); paint(); return; }
    var skipped = 0;
    Array.prototype.forEach.call(files, function (f) {
      var key = f.name + '|' + f.size + '|' + f.lastModified;
      if (list.some(function (x) { return x.key === key; })) return;
      if (list.length < OQF_MAX_CHIPS) list.push({ file: f, key: key }); else skipped++;
    });
    notice = skipped ? 'За один раз — не больше ' + OQF_MAX_CHIPS + ' файлов: ещё ' + skipped + ' не прикреплено, пришлите их отдельной задачей.' : '';
    if (notice) announce(notice);
    changed();
  }
  function paint() {
    root.hidden = state.enabled !== true;
    hintEl.textContent = notice || oqfHint(state.limits);
    hintEl.classList.toggle('oqf-warn', !!notice);
    pick.disabled = !usable() || list.length >= OQF_MAX_CHIPS;
    var plan = oqfPlan(list.map(function (x) { return x.file; }), state.limits);
    chipsEl.hidden = !plan.rows.length;
    paintLeft();
    // Пересборка — только когда изменился состав: опрос сводки не должен выбивать кнопку из-под пальца.
    var sig = JSON.stringify([plan.rows.map(function (r) { return [r.name, r.file.size, r.reason]; }), locked]);
    if (sig === chipsSig) return;
    chipsSig = sig;
    chipsEl.textContent = '';
    plan.rows.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'oqf-chip' + (r.reason ? ' bad' : '');
      var name = document.createElement('span'); name.className = 'oqf-name'; name.textContent = r.name;
      var size = document.createElement('span'); size.className = 'oqf-size'; size.textContent = oqfSize(r.file.size);
      li.appendChild(name); li.appendChild(size);
      if (r.reason) { var bad = document.createElement('span'); bad.className = 'oqf-bad'; bad.textContent = '⚠ ' + r.reason; li.appendChild(bad); }
      var rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'oqf-x'; rm.textContent = '×'; rm.disabled = locked;
      rm.setAttribute('aria-label', 'Убрать файл ' + r.name);
      rm.addEventListener('click', function () { list.splice(i, 1); notice = ''; changed(); pick.focus(); });
      li.appendChild(rm);
      chipsEl.appendChild(li);
    });
  }
  function rowsOf(entry) { return entry.pre.map(function (p) { return { name: p.name, reason: p.reason, file: null }; }).concat(entry.errs); }
  function paintLeft() {
    var shown = lefts.filter(function (x) { return !x.hidden && (rowsOf(x).length || x.note); });
    var sig = JSON.stringify([shown.map(function (x) { return [x.itemId, x.note || '', rowsOf(x).map(function (r) { return [r.name, r.reason, !!r.file]; })]; }), !!run || locked]);
    leftEl.hidden = !shown.length;
    if (sig === leftSig) return;
    leftSig = sig;
    leftEl.textContent = '';
    shown.forEach(function (entry) {
      var rows = rowsOf(entry);
      var head = document.createElement('li');
      head.className = 'oqf-left-head';
      head.textContent = (rows.length ? 'К задаче ' + entry.itemId + ' не загружено: ' + rows.length : 'Задача ' + entry.itemId) + ' ';
      var hide = document.createElement('button');
      hide.type = 'button'; hide.className = 'oqf-hide'; hide.textContent = 'Скрыть';
      hide.setAttribute('aria-label', 'Скрыть список по задаче ' + entry.itemId);
      hide.addEventListener('click', function () { entry.hidden = true; paint(); pick.focus(); });
      head.appendChild(hide);
      leftEl.appendChild(head);
      if (entry.note) {
        var n = document.createElement('li');
        n.className = 'oqf-left-head';
        n.textContent = entry.note;
        leftEl.appendChild(n);
      }
      rows.forEach(function (r) {
        var li = document.createElement('li');
        li.textContent = r.name + ' — ' + r.reason + ' ';
        if (r.file) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'oqf-retry'; b.textContent = 'Повторить'; b.disabled = !!run || locked;
          b.setAttribute('aria-label', 'Повторить загрузку ' + r.name);
          b.addEventListener('click', function () { retry(entry, r); });
          li.appendChild(b);
        }
        leftEl.appendChild(li);
      });
    });
  }
  /** Файлы по одному; прогресс — по байтам всех файлов (вне live-региона), в live — «файл 2 из 3». */
  async function sendAll(itemId, rows, say) {
    var total = rows.reduce(function (s, r) { return s + r.file.size; }, 0) || 1, done = 0, errs = [];
    errs.duplicates = 0;
    run = { xhr: null, cancelled: false };
    runEl.hidden = false; bar.value = 0; paintLeft();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (run.cancelled) { errs.push({ name: r.name, reason: 'отменено', file: r.file }); continue; }
      say('Загружаю файл ' + (i + 1) + ' из ' + rows.length + '…');
      var base = done;
      var res = await sendFile(itemId, r.file, function (loaded) { bar.value = (base + loaded) / total; }, run);
      done += r.file.size;
      if (!res.ok) errs.push({ name: r.name, reason: res.reason, file: res.retry ? r.file : null });
      else if (res.duplicate) errs.duplicates++;
    }
    run = null; runEl.hidden = true;
    return errs;
  }
  /** Причины и ожидания — в пункт; не вышло — пометка в списке, агент увидит «дошли не все» вместо причин. */
  async function report(entry, duplicates) {
    try {
      await recordFailed(entry.itemId, entry.pre.concat(entry.errs.map(function (e) { return { name: e.name, reason: e.reason }; })), duplicates || 0);
      entry.note = '';
    } catch (e) {
      entry.note = 'Не удалось сообщить агенту, какие файлы не дошли: он увидит «дошли не все».';
    }
  }
  /** После создания пункта: загрузить файлы, недошедшие записать в пункт, форма очищается. */
  async function upload(itemId, say) {
    var plan = oqfPlan(list.map(function (x) { return x.file; }), state.limits);
    list = [];
    var errs = await sendAll(itemId, plan.send, say);
    var entry = { itemId: itemId, pre: plan.failed, errs: errs.slice(), hidden: false, note: '' };
    // Дубль по содержимому (тот же скриншот дважды) сервер схлопнул: из ожиданий агента его убираем (линза GLM #313).
    if (errs.length || errs.duplicates) await report(entry, errs.duplicates);
    if (entry.pre.length || entry.errs.length || entry.note) lefts.push(entry);
    changed();
    refresh();
    var total = plan.expected - errs.duplicates;
    return { done: plan.send.length - errs.length - errs.duplicates, total: total, failed: plan.failed.length + errs.length };
  }
  async function retry(entry, r) {
    if (run || locked || lefts.indexOf(entry) < 0) return;
    entry.errs = entry.errs.filter(function (e) { return e !== r; });
    var errs = await sendAll(entry.itemId, [r], function (t) { announce(t); });
    entry.errs = entry.errs.concat(errs);
    announce(errs.length ? 'Не загружено: ' + r.name + ' — ' + errs[0].reason : 'Файл загружен: ' + r.name);
    await report(entry, errs.duplicates);
    var resolved = !entry.pre.length && !entry.errs.length && !entry.note;
    if (resolved) dropLeft(entry);
    changed();
    refresh();
    if (resolved) pick.focus();
  }

  pick.addEventListener('click', function () { if (usable()) { input.value = ''; input.click(); } });
  input.addEventListener('change', function () { add(input.files); input.value = ''; });
  cancelEl.addEventListener('click', function () { if (run) { run.cancelled = true; if (run.xhr) run.xhr.abort(); } });
  // Скриншот из буфера: файлы есть — берём их; текст вставляется как обычно.
  document.getElementById('compose-text').addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    // Форма занята — текст вставится как обычно, а про файл скажет add().
    if (usable() && !e.clipboardData.getData('text/plain')) e.preventDefault();
    add(files);
  });
  section.addEventListener('dragover', function (e) { if (dragsFiles(e) && usable()) section.classList.add('oqf-drop'); });
  section.addEventListener('dragleave', function (e) { if (!section.contains(e.relatedTarget)) section.classList.remove('oqf-drop'); });
  section.addEventListener('drop', function (e) {
    section.classList.remove('oqf-drop');
    if (dragsFiles(e)) add(e.dataTransfer.files);
  });

  return {
    paint: paint,
    api: {
      count: function () { return list.length; },
      /** Для пункта: сколько файлов ждать, какие не уйдут сразу, текст, если владелец ничего не написал. */
      plan: function () {
        if (!list.length) return null;
        var p = oqfPlan(list.map(function (x) { return x.file; }), state.limits);
        return { expected: p.expected, failed: p.failed, fallbackText: oqfFallbackText(p.rows.map(function (r) { return r.name; })) };
      },
      sync: function (o) { var next = !!o.busy, on = !!o.online; if (next !== locked || on !== online) { locked = next; online = on; paint(); } },
      onChange: function (cb) { listeners.push(cb); },
      upload: upload,
      /** Сколько файлов задачи itemId так и не загружено (с учётом повторов); скрытый список не обнуляет счёт. */
      unresolved: function (itemId) { var e = leftOf(itemId); return e ? e.pre.length + e.errs.length : 0; },
    },
  };
})();
`
