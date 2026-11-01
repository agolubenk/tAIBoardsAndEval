// node --test infra/owner-queue-bot/test/*.test.mjs — белый список HTML для Telegram (вход недоверенный).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTg, linkHostNote, revealInvisible, sanitizeTg } from '../tg-html.mjs';

test('разрешённые теги проходят, прочие — текстом', () => {
  assert.equal(sanitizeTg('<b>да</b> <i>и</i> <code>x</code>'), '<b>да</b> <i>и</i> <code>x</code>');
  assert.equal(sanitizeTg('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(sanitizeTg('<b onclick="x">t</b>'), '<b>t</b>');
  assert.equal(sanitizeTg('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
});

test('ссылки — только https, домен дописывается, если подпись его не называет', () => {
  assert.equal(sanitizeTg('<a href="tg://login?token=1">войти</a>'), 'войти');
  assert.equal(sanitizeTg('<a href="javascript:alert(1)">x</a>'), 'x');
  assert.equal(sanitizeTg('<a href="http://evil.example">x</a>'), 'x');
  assert.equal(sanitizeTg('<a href="https://evil.example/p">claude.ai/login</a>'), '<a href="https://evil.example/p">claude.ai/login</a> (⚠️ ведёт на evil.example)');
  assert.equal(sanitizeTg('<a href="https://ops.example/i/5">Инцидент #5</a>'), '<a href="https://ops.example/i/5">Инцидент #5</a> (ops.example)');
  assert.equal(sanitizeTg('<a href="https://github.com/x">github.com/x</a>'), '<a href="https://github.com/x">github.com/x</a>');
  assert.equal(sanitizeTg('<a href="https://a.example/?q=&quot;x">t</a>'), 't', 'кавычка в адресе — ссылка отбрасывается');
});

test('баланс: незакрытые закрываются, лишние закрывающие — текстом, вложения запрещены', () => {
  assert.equal(sanitizeTg('<b>жирный'), '<b>жирный</b>');
  assert.equal(sanitizeTg('текст</b>'), 'текст&lt;/b&gt;');
  assert.equal(sanitizeTg('<code><b>x</b></code>'), '<code>&lt;b&gt;x&lt;/b&gt;</code>');
  assert.equal(sanitizeTg('<b><b>x</b></b>'), '<b>&lt;b&gt;x</b>&lt;/b&gt;');
});

test('сущности: допустимые сохраняются, голый & экранируется, числовые — символом', () => {
  assert.equal(sanitizeTg('a &amp; b &lt; c &#123; & d'), 'a &amp; b &lt; c { &amp; d');
  // Числовая сущность невидимого символа — меткой, «<» и «&» — снова сущностью, недопустимая — знаком замены.
  assert.equal(sanitizeTg('e&#173;x &#x202E;y'), 'e⟦U+00AD⟧x ⟦U+202E⟧y');
  assert.equal(sanitizeTg('&#60;b&#62; &#38;'), '&lt;b&gt; &amp;');
  assert.equal(sanitizeTg('&#0; &#xD800; &#1;'), '\uFFFD \uFFFD \uFFFD');
  assert.equal(sanitizeTg('2 > 1'), '2 &gt; 1');
});

test('невидимые символы показываются метками', () => {
  const r = revealInvisible('rm -rf /tmp/x‮gnp.exe');
  assert.equal(r.found, true);
  assert.match(r.text, /⟦U\+202E⟧/);
  assert.equal(revealInvisible('обычный текст').found, false);
  assert.match(sanitizeTg('a​b'), /⟦U\+200B⟧/);
  // Весь Default_Ignorable (ревью «Контроля» #327, п. 1): мягкий перенос, CGJ, теги — тоже метками.
  assert.equal(revealInvisible('e\u00ADx\u034Fy\u{E0041}z').text, 'e⟦U+00AD⟧x⟦U+034F⟧y⟦U+E0041⟧z');
  // Селектор варианта не трогаем: на нём держатся эмодзи «⚠️».
  assert.equal(revealInvisible('⚠️').found, false);
});

test('подпись-домен сверяется с хостом ссылки точно, а не подстрокой (GLM-ревью #213)', () => {
  const a = (href, text) => sanitizeTg(`<a href="${href}">${text}</a>`);
  // Подстрока: «ithub.com» внутри «github.com» раньше сходил за совпадение — ссылка уходила без пометки.
  assert.equal(a('https://ithub.com/x', 'github.com'), '<a href="https://ithub.com/x">github.com</a> (⚠️ ведёт на ithub.com)');
  assert.equal(a('https://evil.com/x', 'evil.com.github.com'), '<a href="https://evil.com/x">evil.com.github.com</a> (⚠️ ведёт на evil.com)');
  // Поддомен — другой хост; «www.» — тот же.
  assert.equal(a('https://github.com/x', 'gist.github.com'), '<a href="https://github.com/x">gist.github.com</a> (⚠️ ведёт на github.com)');
  assert.equal(a('https://www.github.com/x', 'github.com'), '<a href="https://www.github.com/x">github.com</a>');
  // IDN: кириллическая «і» вместо латинской — punycode-хост виден; Unicode-подпись своего же IDN-хоста — тоже с
  // punycode (ревью «Контроля» #327): иначе «gíthub.com» на своём xn--хосте выглядела бы как github.com без пометки.
  assert.match(a('https://gіthub.com/x', 'github.com'), /\(⚠️ ведёт на xn--gthub-/);
  assert.equal(a('https://xn--gthub-zsa.com/', 'gíthub.com'), '<a href="https://xn--gthub-zsa.com/">gíthub.com</a> (xn--gthub-zsa.com)');
  // Без пометки — только подпись буква в букву: другой регистр и текст вокруг получают нейтральное «(хост)»
  // (ревью «Контроля» #327, раунд 2, п. 3); назван и этот хост, и чужой — тоже нейтральное.
  assert.equal(a('https://github.com/x', 'GitHub.COM'), '<a href="https://github.com/x">GitHub.COM</a> (github.com)');
  assert.equal(a('https://github.com/a/b', 'https://github.com/a/b'), '<a href="https://github.com/a/b">https://github.com/a/b</a>');
  assert.equal(a('https://github.com/a/b', 'PR на github.com'), '<a href="https://github.com/a/b">PR на github.com</a> (github.com)');
  assert.equal(a('https://github.com/a', 'github.com или gitlab.com'), '<a href="https://github.com/a">github.com или gitlab.com</a> (github.com)');
  // Числа с точкой и версии — не домены.
  assert.equal(linkHostNote('версия 1.2.3', new URL('https://github.com/')), ' (github.com)');
});

test('имена файлов и сегменты пути в подписи — не домены: без ложного «⚠️» (замечание «Контроля» к #327)', () => {
  const gh = new URL('https://github.com/agolubenk/HR_Helper-v2/blob/main/docs/ops/csp.md');
  assert.equal(linkHostNote('docs/ops/csp.md', gh), ' (github.com)');
  assert.equal(linkHostNote('README.md', gh), ' (github.com)');
  assert.equal(linkHostNote('owner-queue.md и file.txt', gh), ' (github.com)');
  // Репозиторий с точками в имени — сегмент пути, а не второй домен.
  assert.equal(linkHostNote('github.com/agolubenk/agolubenk.github.io', new URL('https://github.com/agolubenk/agolubenk.github.io')), '');
  // Явный адрес чужого домена с путём к файлу — по-прежнему предупреждение; завершающая точка домену не мешает.
  assert.equal(linkHostNote('https://evil.com/docs/csp.md', gh), ' (⚠️ ведёт на github.com)');
  assert.equal(linkHostNote('см. github.com.', gh), ' (github.com)');
  // Кириллический домен в зоне .рф — распознаётся через punycode; у IDN-хоста punycode виден всегда.
  assert.equal(linkHostNote('мойсайт.рф', new URL('https://xn--80arbjktj.xn--p1ai/')), ' (xn--80arbjktj.xn--p1ai)');
  assert.equal(linkHostNote('мойсайт.рф', new URL('https://evil.com/')), ' (⚠️ ведёт на evil.com)');
});

test('ревью «Контроля» к #327: гомограф, любая зона и IP, IDN-зоны по списку, запрос и якорь', () => {
  const note = (label, href) => linkHostNote(label, new URL(href));
  // 1. IDN-гомограф со своим хостом не проходит молча: punycode дописан.
  assert.equal(note('gіthub.com', 'https://xn--gthub-n2e.com/'), ' (xn--gthub-n2e.com)');
  assert.equal(note('gіthub.com', 'https://xn--gthub-zsa.com/'), ' (⚠️ ведёт на xn--gthub-zsa.com)');
  // 2. Подпись называет хост на любой зоне и IP — без дубля «(хост)».
  assert.equal(note('mysite.shop', 'https://mysite.shop/'), '');
  assert.equal(note('notion.so', 'https://www.notion.so/x'), '');
  assert.equal(note('192.168.0.1', 'https://192.168.0.1/'), '');
  assert.equal(note('https://192.168.0.1:8443/x', 'https://192.168.0.1:8443/x'), '');
  // IP и зона вне списка на чужой хост — без «⚠️», но настоящий хост виден.
  assert.equal(note('192.168.0.1', 'https://evil.com/'), ' (evil.com)');
  assert.equal(note('mysite.shop', 'https://evil.com/'), ' (evil.com)');
  // 3. Хост среди названных — нейтральное «(хост)»; адрес с userinfo в подписи называет другой хост — «⚠️».
  assert.equal(note('github.com или gitlab.com', 'https://github.com/a'), ' (github.com)');
  assert.equal(note('https://github.com@evil.com', 'https://github.com/a'), ' (⚠️ ведёт на github.com)');
  // 4. IDN-зоны — только по списку: инициалы и «г.Минск» — не домены.
  assert.equal(note('г.Минск', 'https://github.com/'), ' (github.com)');
  assert.equal(note('И.В.Смирнов', 'https://github.com/'), ' (github.com)');
  assert.equal(note('сайт.бел', 'https://evil.com/'), ' (⚠️ ведёт на evil.com)');
  // 5. После ?, =, & и # — запрос и якорь, не адрес.
  assert.equal(note('github.com/login?next=evil.com', 'https://github.com/a'), ' (github.com)');
  assert.equal(note('?next=evil.com', 'https://github.com/a'), ' (github.com)');
  assert.equal(note('#evil.com', 'https://github.com/a'), ' (github.com)');
  assert.equal(note('a=1&b=evil.com', 'https://github.com/a'), ' (github.com)');
  // Домен в самом начале подписи учитывается (символа перед ним нет — это не «путь»).
  assert.equal(note('evil.com — вход', 'https://github.com/a'), ' (⚠️ ведёт на github.com)');
  // Обходы прежние: «ithub.com» и userinfo в адресе ссылки.
  assert.equal(note('github.com', 'https://ithub.com/x'), ' (⚠️ ведёт на ithub.com)');
  assert.equal(note('github.com', 'https://github.com@evil.com/x'), ' (⚠️ ведёт на evil.com)');
});

test('ревью «Контроля» к #327, раунд 2: без пометки — только подпись буква в букву', () => {
  const note = (label, href) => linkHostNote(label, new URL(href));
  // 1. Невидимые символы не режут подпись: мягкий перенос, CGJ, ZWSP, тег — пометка с «⚠️».
  assert.equal(note('e\u00ADxample.com', 'https://xample.com/'), ' (⚠️ ведёт на xample.com)');
  assert.equal(note('e\u034Fxample.com', 'https://xample.com/'), ' (⚠️ ведёт на xample.com)');
  assert.equal(note('e\u200Bxample.com', 'https://xample.com/'), ' (⚠️ ведёт на xample.com)');
  assert.equal(note('exa\u{E0041}mple.com', 'https://example.com/'), ' (example.com)');
  assert.equal(sanitizeTg('<a href="https://xample.com/">e&#173;xample.com</a>'), '<a href="https://xample.com/">e⟦U+00AD⟧xample.com</a> (⚠️ ведёт на xample.com)');
  // 3. I/l через регистр: «ExampIe.com» на exampie.com — нейтральное «(хост)», а не ''.
  assert.equal(note('ExampIe.com', 'https://exampie.com/'), ' (exampie.com)');
  assert.equal(note('https://GitHub.com/a', 'https://github.com/a'), ' (github.com)');
  // 4. Свой хост в пути или userinfo подписи — не совпадение.
  assert.equal(note('example.com/@example.org', 'https://example.org/'), ' (⚠️ ведёт на example.org)');
  assert.equal(note('example.com/.example.org', 'https://example.org/'), ' (⚠️ ведёт на example.org)');
  assert.equal(note('example.com@example.org', 'https://example.org/'), ' (example.org)');
  // NFKC — только для «⚠️»: «ſ» похожа на «f», но совпадением с хостом не считается.
  assert.equal(note('ſacebook.com', 'https://sacebook.com/'), ' (sacebook.com)');
  assert.equal(note('ｇｉｔｈｕｂ.ｃｏｍ', 'https://evil.com/'), ' (⚠️ ведёт на evil.com)');
  // Буква в букву: хост с «www.» и без, адрес со схемой и без, с «/» в конце и без.
  assert.equal(note('www.github.com', 'https://github.com/'), '');
  assert.equal(note('https://github.com', 'https://github.com/'), '');
  assert.equal(note('github.com/a/b', 'https://www.github.com/a/b'), '');
});

test('ревью «Контроля» к #327, раунд 2, minor: без ложного «⚠️» на именах, «⚠️» на двойниках', () => {
  const note = (label, href) => linkHostNote(label, new URL(href));
  for (const label of ['г.Москва', 'ASP.NET', 'Socket.IO', 'Dockerfile.dev', 'ivan@mail.ru']) {
    assert.equal(note(label, 'https://github.com/'), ' (github.com)', label);
  }
  // Хост ссылки продолжает названный: «example.so» → example.so.example.org.
  assert.equal(note('example.so', 'https://example.so.example.org/'), ' (⚠️ ведёт на example.so.example.org)');
  // Кириллический двойник зоны: смесь латиницы с кириллицей.
  assert.equal(note('github.сом', 'https://evil.com/'), ' (⚠️ ведёт на evil.com)');
  // Адрес в начале подписи с текстом после него — тоже «⚠️».
  assert.equal(note('github.com — вход', 'https://evil.com/'), ' (⚠️ ведёт на evil.com)');
});

test('ревью «Контроля» к #327, раунд 2, п. 2: пометку не теряет ни незакрытая ссылка, ни повторный проход, ни обрезка', () => {
  const evil = '<a href="https://evil.com/">github.com</a> (⚠️ ведёт на evil.com)';
  // Незакрытая <a> закрывается с пометкой.
  assert.equal(sanitizeTg('<a href="https://evil.com/">github.com'), evil);
  assert.equal(sanitizeTg('<a href="https://evil.com/"><b>github.com'), '<a href="https://evil.com/"><b>github.com</b></a> (⚠️ ведёт на evil.com)');
  // Повторный проход (pack) пометку не дублирует.
  assert.equal(sanitizeTg(sanitizeTg('<a href="https://evil.com/">github.com</a>')), evil);
  // cutTg не режет внутри ссылки с пометкой: она остаётся целиком или уходит целиком.
  const line = `${'x'.repeat(50)} ${evil} хвост`;
  for (let max = 40; max <= line.length; max += 1) {
    const cut = cutTg(line, max);
    assert.ok(cut.length <= max, `max ${max}`);
    assert.ok(!cut.includes('<a ') || cut.includes(evil), `max ${max}: ${cut}`);
  }
  // Ссылка, которая не влезает и одна, — текстом подписи с пометкой, без адреса.
  const long = `<a href="https://evil.com/${'p'.repeat(200)}">github.com</a> (⚠️ ведёт на evil.com)`;
  assert.equal(cutTg(long, 100), 'github.com (⚠️ ведёт на evil.com)');
  // Сущность и тег не разрезаются.
  assert.equal(cutTg('ab&amp;cd', 3), 'ab');
  assert.equal(cutTg('ab<b>cd</b>', 4), 'ab');
});
