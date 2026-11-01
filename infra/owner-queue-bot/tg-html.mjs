// HTML для Telegram из недоверенного источника (фрейм артефакта: его JS может быть подменён переизданием).
// Белый список проверяется здесь, в Node: b, i, code, pre и a только с https-адресом; всё прочее — текстом.

const ALLOWED = new Set(['b', 'i', 'code', 'pre', 'a']);
const ENTITY = /^&(lt|gt|amp|quot|#\d{1,7}|#x[0-9a-f]{1,6});/i;
// Невидимые символы (Default_Ignorable: нулевой ширины, смена направления, мягкий перенос, теги): показанный текст
// расходится с тем, что скопируется. Кроме селекторов варианта — на них держатся эмодзи вроде «⚠️».
export const INVISIBLE_RE = /(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}/gu;

export const escText = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const unescAttr = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const toPlain = (html) => String(html ?? '').replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Невидимые символы — видимыми метками ⟦U+202E⟧. Возвращает текст и признак, были ли они. */
export function revealInvisible(s) {
  let found = false;
  const text = String(s ?? '').replace(INVISIBLE_RE, (c) => { found = true; return `⟦U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`; });
  return { text, found };
}

// Правило подписи ссылки — одно на бота и страницу /queue (infra/ops-console/server/queue/page.html, linkHostNote):
// регулярки и списки ниже тест ops-console сверяет со страницей на точное равенство, а ответы — на всех сочетаниях.
// Без пометки — только подпись, буква в букву равная хосту или адресу ссылки. Всё остальное получает « (хост)»,
// а «⚠️» — если подпись называет другой адрес и не называет этот. Эвристики решают только про «⚠️»: настоящий хост
// виден при любом их ответе (ревью «Контроля» #327).

// Для сверки адреса в подписи убираются метки невидимых (revealInvisible) и сами невидимые, включая селекторы.
export const LINK_MARK_RE = /⟦U\+[0-9A-F]{4,6}⟧|\p{Default_Ignorable_Code_Point}/gu;
// Слова подписи — между пробелами, скобками, кавычками и запятыми; адрес — только слово целиком, не его часть.
export const LINK_WORD_SPLIT_RE = /[\s()[\]{}<>«»„“”"'`,;!]+/u;
// Слово — голый адрес: «github.com», «github.com/login?x», «пример.рф»; слова с «http(s)://» разбирает URL.
export const LINK_BARE_HOST_RE = /^((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63})(?:[/?#]\S*)?$/u;
// «⚠️» от голого адреса — только на частых веб-зонах: иначе «deploy.sh» или «page.html» давали бы ложное «⚠️».
export const LINK_WEB_TLDS = ['com', 'net', 'org', 'io', 'dev', 'app', 'ai', 'co', 'me', 'info', 'biz', 'pro', 'tech',
  'cloud', 'site', 'online', 'space', 'xyz', 'edu', 'gov', 'int', 'eu', 'us', 'uk', 'de', 'fr', 'nl', 'pl', 'cz', 'it',
  'es', 'ua', 'kz', 'uz', 'am', 'ge', 'az', 'lt', 'lv', 'ee', 'ru', 'by', 'su', 'tv', 'gg', 'ly', 'to', 'news', 'store'];
// Кириллические и прочие IDN-зоны (punycode): рф, бел, укр, рус, москва, онлайн, сайт, орг, ком, дети, қаз, срб, мкд, мон.
export const LINK_IDN_TLDS = ['xn--p1ai', 'xn--90ais', 'xn--j1amh', 'xn--p1acf', 'xn--80adxhks', 'xn--80asehdb',
  'xn--80aswg', 'xn--c1avg', 'xn--j1aef', 'xn--d1acj3b', 'xn--80ao21a', 'xn--90a3ac', 'xn--d1alf', 'xn--l1acc'];

/** Hostname так, как его сравнивает браузер: нижний регистр, IDN → punycode, без «www.»; '' — не разбирается. */
function hostOf(address) {
  try { return new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const mixedScript = (s) => /\p{Script=Latin}/u.test(s) && /(?!\p{Script=Latin})\p{L}/u.test(s);

/** Подпись буква в букву — хост или адрес ссылки: с «www.» и без, с портом и без, со схемой и без, с «/» в конце и без. */
function isExactAddress(label, url) {
  if (!label || url.username || url.password) return false;
  const bare = url.hostname.replace(/^www\./, '');
  const tail = url.pathname + url.search + url.hash;
  for (const h of [bare, `www.${bare}`]) {
    for (const hp of [h, url.port ? `${h}:${url.port}` : h]) {
      if (label === hp) return true;
      for (const t of [tail, tail.replace(/\/$/, '')]) if (label === hp + t || label === `https://${hp}${t}`) return true;
    }
  }
  return false;
}

/**
 * Какой хост называет слово подписи: { host, strong } или null. Адрес со схемой — всегда; голый — только в нижнем
 * регистре («GitHub.com», «ASP.NET», «Socket.IO» — имена). strong — повод для «⚠️»: адрес со схемой, частая веб-зона,
 * IDN-зона из списка, смесь латиницы с другим письмом («gіthub.com») или хост ссылки продолжает его («notion.so.evil.org»).
 */
function wordClaim(word, linkHost) {
  if (/^https?:\/\//i.test(word)) { const host = hostOf(word); return host ? { host, strong: true } : null; }
  if (word !== word.toLowerCase()) return null;
  const m = LINK_BARE_HOST_RE.exec(word);
  const host = m ? hostOf(m[1]) : '';
  if (!host) return null;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  const strong = LINK_WEB_TLDS.includes(tld) || LINK_IDN_TLDS.includes(tld) || mixedScript(m[1]) || linkHost.startsWith(`${host}.`);
  return { host, strong };
}

/**
 * Что дописать после ссылки, чтобы подпись не выдала себя за другой адрес (GLM-ревью #213, ревью «Контроля» #327):
 * '' — подпись буква в букву равна адресу ссылки; « (⚠️ ведёт на хост)» — называет другой адрес и не называет этот;
 * « (хост)» — во всех остальных случаях. Регистр, невидимые символы, двойники и userinfo без пометки не проходят.
 */
export function linkHostNote(label, url) {
  const text = String(label ?? '').trim();
  if (isExactAddress(text, url)) return '';
  const host = url.hostname.replace(/^www\./, '');
  let names = false, other = false;
  for (const raw of text.replace(LINK_MARK_RE, '').normalize('NFKC').split(LINK_WORD_SPLIT_RE)) {
    const c = wordClaim(raw.replace(/[.:?!…]+$/u, ''), host);
    if (c && c.host === host) names = true;
    else if (c && c.strong) other = true;
  }
  return other && !names ? ` (⚠️ ведёт на ${url.host})` : ` (${url.host})`;
}

/** Безопасный https-адрес или null. */
export function safeHttps(href) {
  if (typeof href !== 'string' || !/^https:\/\/[^\s"<>]+$/.test(href)) return null;
  try { return new URL(href); } catch { return null; }
}

/** Числовая сущность — самим символом (невидимый — меткой): сверка подписи видит то же, что покажет Telegram. */
function charRef(ref) {
  const cp = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
  const bad = !(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp < 0xa0);
  return escText(revealInvisible(bad ? '\uFFFD' : String.fromCodePoint(cp)).text);
}

/** Пометка домена у ссылки; уже стоящую сразу после ссылки (повторный проход, pack) не повторяем. */
function noteAfter(out, start, url, src, i) {
  const note = escText(linkHostNote(toPlain(out.slice(start)), url));
  return src.startsWith(note, i) ? '' : note;
}

/**
 * Привести HTML к подмножеству Telegram: незнакомые теги и атрибуты — экранированным текстом,
 * незакрытые теги закрываются, лишние закрывающие — текстом. После ссылки дописывается её настоящий домен, если
 * подпись не равна адресу буква в букву, и предупреждение, если подпись называет другой (linkHostNote) — и у
 * незакрытой ссылки тоже.
 */
export function sanitizeTg(html) {
  const src = revealInvisible(html).text;
  let out = '';
  const stack = []; // { tag, start, url }
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '&') {
      const m = ENTITY.exec(src.slice(i, i + 12));
      if (!m) { out += '&amp;'; i++; continue; }
      out += m[1][0] === '#' ? charRef(m[1]) : m[0];
      i += m[0].length;
      continue;
    }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch !== '<') { out += ch; i++; continue; }
    const end = src.indexOf('>', i);
    const raw = end > 0 ? src.slice(i, end + 1) : '';
    const m = raw ? /^<(\/?)([a-z]+)((?:\s[^>]*)?)>$/i.exec(raw) : null;
    const tag = m && m[2].toLowerCase();
    if (!m || !ALLOWED.has(tag)) { out += '&lt;'; i++; continue; }
    i = end + 1;
    const top = stack[stack.length - 1];
    if (m[1]) { // закрывающий
      if (top && tag === 'a' && top.tag === 'a-skip') { stack.pop(); continue; }
      if (top && top.tag === tag) {
        stack.pop();
        out += `</${tag}>`;
        if (tag === 'a') out += noteAfter(out, top.start, top.url, src, i);
      } else out += escText(raw);
      continue;
    }
    // Тот же тег внутри себя или любой тег внутри <code> — текстом.
    if (stack.some((s) => s.tag === tag || (tag === 'a' && s.tag === 'a-skip')) || (top && top.tag === 'code')) {
      out += escText(raw);
      continue;
    }
    if (tag === 'a') {
      const hm = /\shref="([^"]*)"/i.exec(m[3]);
      const url = hm && safeHttps(unescAttr(hm[1]));
      if (!url) { stack.push({ tag: 'a-skip' }); continue; } // ссылка без https — остаётся только текст
      out += `<a href="${escAttr(url.href)}">`;
      stack.push({ tag: 'a', start: out.length, url });
      continue;
    }
    out += `<${tag}>`;
    stack.push({ tag, start: out.length });
  }
  // Незакрытые — закрываем в обратном порядке; «a-skip» тега не порождал; у ссылки — пометка домена, как у закрытой.
  while (stack.length) {
    const t = stack.pop();
    if (t.tag === 'a-skip') continue;
    out += `</${t.tag}>`;
    if (t.tag === 'a') out += escText(linkHostNote(toPlain(out.slice(t.start)), t.url));
  }
  return out;
}

// Ссылка вместе с пометкой домена после неё — так её выдаёт sanitizeTg; резать её можно только целиком.
export const LINK_UNIT_RE = /<a href="[^"]*">[\s\S]*?<\/a>(?: \((?:⚠️ ведёт на )?[^\s()<>]+\))?/gu;
const TG_ATOM_RE = new RegExp(`${LINK_UNIT_RE.source}|<[^>]*>|&[^;\\s]{1,10};|[\\s\\S]`, 'gu');

/**
 * Начало HTML Telegram (выход sanitizeTg) не длиннее max: режет между символами, но не внутри тега, сущности и
 * ссылки с пометкой — обрезанная подпись без пометки снова выдала бы себя за другой адрес (ревью #327, п. 2).
 * Ссылка, которая не влезает и одна, остаётся текстом подписи с пометкой, без адреса. Незакрытые теги закроет sanitizeTg.
 */
export function cutTg(html, max) {
  if (html.length <= max) return html;
  let out = '';
  for (const [atom] of html.matchAll(TG_ATOM_RE)) {
    const a = !out && atom.length > max && atom.startsWith('<a ') ? atom.replace(/^<a href="[^"]*">/, '').replace('</a>', '') : atom;
    if (out.length + a.length > max) break;
    out += a;
  }
  return out;
}
