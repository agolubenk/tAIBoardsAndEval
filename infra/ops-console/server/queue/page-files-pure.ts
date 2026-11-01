/**
 * Чистые функции вложений страницы /queue (без DOM): лимиты до отправки, тексты отказов, «ещё грузятся», строка места
 * и сводка, которой страница доверяет. Их исполняет tests/queue-page-files.test.ts; в страницу их ставит page-files.ts.
 */
export const FILES_PURE = String.raw`
var OQF_KINDS = { image: 'картинки', pdf: 'PDF', doc: 'docx', sheet: 'xlsx', text: 'текст/лог' };
var OQF_DEFAULT_LIMITS = { maxBytes: 20971520, maxPerItem: 10, kinds: ['image', 'pdf', 'doc', 'sheet', 'text'], retentionDays: 90 };
var OQF_MAX_CHIPS = 20;
var OQF_WAIT_MS = 3600000;
function oqfEsc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function oqfPlural(n, one, few, many) { var a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }
/** Байты по-русски: «512 Б», «12 КБ», «3,4 МБ», «4 ГБ». */
function oqfSize(n) {
  n = Number(n);
  if (!isFinite(n) || n < 0) return '';
  var units = [['ГБ', 1073741824], ['МБ', 1048576], ['КБ', 1024]];
  for (var i = 0; i < units.length; i++) {
    if (n >= units[i][1]) {
      var v = n / units[i][1];
      return String(v < 10 && i < 2 ? Math.round(v * 10) / 10 : Math.round(v)).replace('.', ',') + ' ' + units[i][0];
    }
  }
  return Math.round(n) + ' Б';
}
/** Подсказка у «📎» — из настроек консоли: «до 5 файлов, 20 МБ; картинки, PDF, docx, xlsx, текст/лог». */
function oqfHint(limits) {
  var l = limits || OQF_DEFAULT_LIMITS;
  var kinds = (l.kinds || []).map(function (k) { return OQF_KINDS[k]; }).filter(Boolean);
  return 'до ' + l.maxPerItem + ' ' + oqfPlural(l.maxPerItem, 'файла', 'файлов', 'файлов') + ', ' + oqfSize(l.maxBytes) + (kinds.length ? '; ' + kinds.join(', ') : '');
}
/**
 * Что уйдёт: файлы в пределах лимитов — на загрузку, остальные — сразу в filesFailed с причиной: агент видит, что
 * владелец прикладывал и почему файл не дошёл. room — сколько ещё можно приложить к пункту (по умолчанию — лимит).
 * Тип файла здесь не проверяется: его по содержимому решает консоль, а фильтр по расширению прятал бы .log и .out.
 */
function oqfPlan(files, limits, room) {
  var l = limits || OQF_DEFAULT_LIMITS;
  var free = room == null ? l.maxPerItem : Math.max(0, room);
  var rows = [], sent = 0;
  (files || []).slice(0, OQF_MAX_CHIPS).forEach(function (f) {
    var name = String(f && f.name || 'файл').slice(0, 200);
    var reason = null;
    if (!(f && f.size > 0)) reason = 'пустой файл';
    else if (f.size > l.maxBytes) reason = 'больше ' + oqfSize(l.maxBytes) + ' — обрежьте лог или пришлите ссылку текстом';
    else if (sent >= free) reason = 'сверх лимита: не больше ' + l.maxPerItem + ' ' + oqfPlural(l.maxPerItem, 'файла', 'файлов', 'файлов') + ' на задачу';
    else sent++;
    rows.push({ file: f, name: name, reason: reason });
  });
  return {
    rows: rows,
    send: rows.filter(function (r) { return !r.reason; }),
    failed: rows.filter(function (r) { return r.reason; }).map(function (r) { return { name: r.name, reason: r.reason }; }),
    expected: rows.length,
    // Сверх потолка схемы входящего: в пункт не попадают — страница говорит о них владельцу сама.
    skipped: Math.max(0, (files || []).length - OQF_MAX_CHIPS),
  };
}
/**
 * Сколько ждать загрузку файла: 15 минут, а для крупного — по скорости 8 КБ/с (медленный 3G) плюс 2 минуты на разбор
 * у консоли; не больше часа. Сервер ждёт тело дольше (requestTimeout в server/local.ts).
 */
function oqfUploadTimeout(size) {
  var bySpeed = Math.ceil((Number(size) || 0) / 8192) * 1000 + 120000;
  return Math.min(3600000, Math.max(900000, bySpeed));
}
/** Текст задачи, когда владелец прислал только файлы: «Вложение: отчёт.pdf» (и «и ещё 2»). */
function oqfFallbackText(names) {
  if (!names || !names.length) return '';
  return 'Вложение: ' + names[0] + (names.length > 1 ? ' и ещё ' + (names.length - 1) : '');
}
/** Ответ консоли на загрузку → строка владельцу и можно ли повторить тем же файлом (таблица одна — и для бота). */
function oqfUploadError(status, message) {
  var m = typeof message === 'string' && message ? message.charAt(0).toLowerCase() + message.slice(1) : '';
  if (status === 0) return { reason: 'нет связи с сервером', retry: true };
  if (status === 401 || status === 403) return { reason: 'сессия истекла — войдите заново и повторите', retry: true };
  if (status === 404) return { reason: 'задача удалена', retry: false };
  if (status === 408) return { reason: 'загрузка не успела — повторите', retry: true };
  if (status === 429) return { reason: 'слишком часто — повторите через минуту', retry: true };
  if (status === 409 || status === 413 || status === 415) return { reason: m || 'файл не принят', retry: false };
  return { reason: m || 'ошибка сервера (' + status + ')', retry: true };
}
/**
 * Едут ли ещё файлы к пункту: создатель обещал filesExpected, а готово и отказано меньше. Ждём час от получения —
 * дальше это «не дошли», а не «грузятся». 'none' — ждать нечего.
 */
function oqfPending(meta, ready, now) {
  if (!meta || !(meta.expected > 0)) return 'none';
  if (ready + (meta.failed ? meta.failed.length : 0) >= meta.expected) return 'none';
  var at = Date.parse(meta.receivedAt);
  return isFinite(at) && now - at < OQF_WAIT_MS ? 'loading' : 'lost';
}
/** Тихая строка места; предупреждение — когда консоль сказала warn (95 %). Пусто — строки нет. */
function oqfUsage(u) {
  if (!u || !(u.usedBytes > 0) || !(u.capBytes > 0)) return null;
  var text = 'Вложения: ' + oqfSize(u.usedBytes) + ' из ' + oqfSize(u.capBytes);
  return u.warn ? { text: text + ' — место почти кончилось: удалите ненужные вложения в карточках', warn: true } : { text: text, warn: false };
}
/** Сводка консоли → то, чему страница доверяет: id — 32 hex, имя — строка, размер — число. */
function oqfCleanSummary(j) {
  if (!j || j.enabled !== true) return { enabled: false, items: {} };
  var l = j.limits || {};
  var limits = {
    maxBytes: l.maxBytes > 0 ? l.maxBytes : OQF_DEFAULT_LIMITS.maxBytes,
    maxPerItem: l.maxPerItem > 0 ? Math.min(l.maxPerItem, OQF_MAX_CHIPS) : OQF_DEFAULT_LIMITS.maxPerItem,
    kinds: Array.isArray(l.kinds) ? l.kinds.filter(function (k) { return typeof k === 'string'; }) : OQF_DEFAULT_LIMITS.kinds,
    retentionDays: l.retentionDays > 0 ? Math.round(l.retentionDays) : OQF_DEFAULT_LIMITS.retentionDays,
  };
  var items = {};
  var src = j.items && typeof j.items === 'object' ? j.items : {};
  Object.keys(src).forEach(function (id) {
    var v = src[id];
    if (!v || typeof v !== 'object') return;
    var files = Array.isArray(v.files) ? v.files.filter(function (f) { return f && /^[0-9a-f]{32}$/.test(f.id) && typeof f.name === 'string'; })
      .map(function (f) { return { id: f.id, name: f.name.slice(0, 200), size: Number(f.size) || 0 }; }) : [];
    // count — живых файлов у пункта; строк в сводке может быть меньше (старые пункты) — их список догружается.
    items[id] = { files: files, count: Math.max(files.length, v.count > 0 ? Math.round(v.count) : 0), expired: v.expired > 0 ? Math.round(v.expired) : 0 };
  });
  var u = j.usage || {};
  return { enabled: true, limits: limits, usage: { usedBytes: Number(u.usedBytes) || 0, capBytes: Number(u.capBytes) || 0, warn: u.warn === true }, items: items };
}
`
