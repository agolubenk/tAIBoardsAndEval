// Входящее из Telegram: что переслал владелец — ошибка, идея, задача или алерт пульса — и насколько срочно.
// Только правила, без ИИ (решение владельца 21.10): догадка отмечена на кнопках, ошибка правила стоит одного нажатия.
// Спека — docs/specs/owner-queue.md, «Входящие из Telegram».

export const TYPES = ['bug', 'idea', 'task', 'alert'];
export const URGENCIES = ['now', 'queue'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const ORIGIN_KINDS = ['self', 'user', 'hidden', 'bot', 'chat', 'channel'];
export const DEFAULT_ALERT_BOTS = ['hrmhrhelper_space_allerting_bot'];
const STALE_ALERT_SEC = 24 * 3600; // пересланный алерт старше суток — не «сейчас»

// В JS \b знает только латиницу: границы слова для кириллицы — через \p{L}.
const word = (w) => `(?<![\\p{L}\\p{N}])(?:${w})(?![\\p{L}\\p{N}])`;
const BUG = new RegExp(`ошибк|не работа|не груз|не загруж|не открыва|не сохран|не приход|не отправля|упал|падает|сломал|${word('баг|bug|error')}|exception|${word('50[0234]')}|белый экран|завис|вылета`, 'iu');
const BUG_HIGH = new RegExp(`${word('прод|проде|прода|проду')}|у всех|критич|срочн|никто не может`, 'iu');
const IDEA = new RegExp(`${word('иде[яиюе]|хочу|хотелось бы')}|было бы|предлага|можно (?:сделать|добавить)|давай(?:те)? добав|хорошо бы|а что если`, 'iu');
const ALERT_TEXT = /алерт|инцидент|горит/iu;
const SETTLED = /восстановлено|закрыт|resolved|^\s*(?:✅|🟢)/iu;
// Невидимые и служебные символы — из текста вон: агент читает текст моделью, а владелец в превью их не видит (защита
// от скрытых инструкций в пересланном). Формат Cf (в том числе bidi), теги U+E0000–E007F, селекторы вариантов
// U+FE00–FE0F и U+E0100–E01EF (в них прячут байты после эмодзи), символы частного использования (Co).
const INVISIBLE = /[\p{Cf}\p{Co}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

const username = (u) => String(u || '').replace(/^@/, '').toLowerCase();

/** Текст сообщения или подписи вложения без невидимых символов. */
export const textOf = (m) => String(m.text || m.caption || '').replace(INVISIBLE, '').trim();
export const isForwarded = (m) => !!m.forward_origin;
export const hasMediaOf = (m) => !!(m.photo || m.document || m.video || m.voice || m.audio || m.animation || m.video_note);

/** Откуда переслано: вид (self — своё сообщение) и подпись для показа. */
export function originOf(m) {
  const o = m.forward_origin;
  if (!o) return { kind: 'self', label: 'сам' };
  if (o.type === 'user') {
    const u = o.sender_user || {};
    const label = u.username ? `@${u.username}` : (u.first_name || 'пользователь');
    return { kind: u.is_bot ? 'bot' : 'user', label: label.slice(0, 200) };
  }
  if (o.type === 'hidden_user') return { kind: 'hidden', label: `скрытый: ${String(o.sender_user_name || '').slice(0, 180)}` };
  if (o.type === 'chat') return { kind: 'chat', label: String(o.sender_chat?.title || o.sender_chat?.username || 'чат').slice(0, 200) };
  return { kind: 'channel', label: String(o.chat?.title || o.chat?.username || 'канал').slice(0, 200) };
}

/** https-ссылки из разметки сообщения (у алерта консоли ссылка на инцидент — text_link, в тексте её нет). */
export function linksOf(m) {
  const ents = [...(m.entities || []), ...(m.caption_entities || [])];
  const text = String(m.text || m.caption || '');
  const out = [];
  for (const e of ents) {
    const href = e.type === 'text_link' ? e.url : e.type === 'url' ? text.slice(e.offset, e.offset + e.length) : '';
    if (/^https:\/\/[^\s"<>]{1,1900}$/.test(href || '') && !out.some((l) => l.href === href)) out.push({ href, text: text.slice(e.offset, e.offset + e.length).slice(0, 120) || href });
  }
  return out.slice(0, 10);
}

/**
 * Пересланное из бота алертов консоли: отправитель — бот (is_bot) с именем из списка. Имя бота в Telegram уникально,
 * а в личку нашему боту пишет только владелец — так что «алертом по отправителю» становится только настоящий алерт.
 */
function fromAlertBot(m, alertBots) {
  const o = m.forward_origin;
  return o?.type === 'user' && o.sender_user?.is_bot === true && alertBots.map(username).includes(username(o.sender_user.username));
}

/**
 * Догадка по сообщению: { type, urgency, severity? }.
 * - Алерт — пересланное из бота алертов или своё сообщение (не пересланное) с маркером 🔴/🟠 и словом «алерт / инцидент /
 *   горит». Чужой пересланный текст с 🔴 алертом не считается: так выглядит подделка.
 * - «ВОССТАНОВЛЕНО» и старше суток — не «сейчас».
 */
export function classify(m, { alertBots = DEFAULT_ALERT_BOTS, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const text = textOf(m);
  const ownAlert = !isForwarded(m) && /^\s*(?:🔴|🟠)/u.test(text) && ALERT_TEXT.test(text);
  if (fromAlertBot(m, alertBots) || ownAlert) {
    const settled = SETTLED.test(text);
    const stale = typeof m.forward_origin?.date === 'number' && nowSec - m.forward_origin.date > STALE_ALERT_SEC;
    const severity = settled ? 'medium' : /🔴|критич/iu.test(text) ? 'critical' : 'high';
    return { type: 'alert', urgency: settled || stale ? 'queue' : 'now', severity };
  }
  if (BUG.test(text)) {
    const high = BUG_HIGH.test(text);
    return { type: 'bug', urgency: high ? 'now' : 'queue', severity: high ? 'high' : 'medium' };
  }
  if (IDEA.test(text)) return { type: 'idea', urgency: 'queue' };
  return { type: 'task', urgency: 'queue' };
}

/** Заголовок пункта — первая непустая строка без маркеров уровня, до 120 символов. */
export function titleOf(text, fallback = 'Входящее из Telegram') {
  const first = String(text).split('\n').map((l) => l.replace(/^[\s🔴🟠🟢✅⚠️❗️]+/u, '').trim()).find(Boolean) || fallback;
  return first.length > 120 ? first.slice(0, 119) + '…' : first;
}

/** Смена типа сбрасывает или проставляет важность: она есть только у ошибки и алерта. */
export function withType(draft, type) {
  const next = { ...draft, type };
  if (type === 'bug' || type === 'alert') next.severity = draft.severity || (type === 'alert' ? 'high' : 'medium');
  else delete next.severity;
  return next;
}
