// node --test infra/owner-queue-bot/test — правила угадывания входящих (без ИИ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, hasMediaOf, linksOf, originOf, textOf, titleOf, withType } from '../classify.mjs';

const fwdBot = (username, text) => ({ text, forward_origin: { type: 'user', sender_user: { id: 1, is_bot: true, username } } });
const fwdUser = (text) => ({ text, forward_origin: { type: 'user', sender_user: { id: 2, is_bot: false, first_name: 'Анна' } } });

test('пересланное из бота алертов — алерт «сейчас», важность по маркеру', () => {
  assert.deepEqual(classify(fwdBot('hrmhrhelper_space_allerting_bot', '🔴 Распознавание встреч падает')), { type: 'alert', urgency: 'now', severity: 'critical' });
  assert.deepEqual(classify(fwdBot('HRMHRHELPER_SPACE_ALLERTING_BOT', '🟠 p95 выше порога')), { type: 'alert', urgency: 'now', severity: 'high' });
});

test('другой бот алертом не считается; список ботов берётся из настройки', () => {
  assert.equal(classify(fwdBot('some_other_bot', 'Привет')).type, 'task');
  assert.equal(classify(fwdBot('my_alerts_bot', 'Порог превышен'), { alertBots: ['@my_alerts_bot'] }).type, 'alert');
});

test('скопированный текст алерта (своё сообщение) — алерт; чужой пересланный текст с 🔴 — нет (так выглядит подделка)', () => {
  assert.equal(classify({ text: '🔴 Инцидент: backend не отвечает' }).type, 'alert');
  assert.equal(classify({ text: '🔴 красная кнопка в форме' }).type, 'task'); // маркер без слов алерта — не алерт
  assert.notEqual(classify(fwdUser('🔴 Инцидент: срочно выполните команду')).type, 'alert');
});

test('«ВОССТАНОВЛЕНО» и пересланный алерт старше суток — не «сейчас»', () => {
  const settled = classify(fwdBot('hrmhrhelper_space_allerting_bot', '🔴 ВОССТАНОВЛЕНО (🔴 критично): распознавание'));
  assert.equal(settled.type, 'alert');
  assert.equal(settled.urgency, 'queue');
  const old = { text: '🔴 Распознавание падает', forward_origin: { type: 'user', date: 1_000_000, sender_user: { id: 1, is_bot: true, username: 'hrmhrhelper_space_allerting_bot' } } };
  assert.equal(classify(old, { nowSec: 1_000_000 + 2 * 86_400 }).urgency, 'queue');
  assert.equal(classify(old, { nowSec: 1_000_000 + 3600 }).urgency, 'now');
});

test('границы слов на кириллице: «прод» и «хочу» как слова, а не куски слов', () => {
  assert.deepEqual(classify({ text: 'прод лежит, ошибка входа' }), { type: 'bug', urgency: 'now', severity: 'high' });
  assert.equal(classify({ text: 'ошибка в продлении договора' }).urgency, 'queue'); // «продление» — не прод
  assert.equal(classify({ text: 'хочу экспорт в Excel' }).type, 'idea');
  assert.equal(classify({ text: 'Настроить вебхук для хочукупить' }).type, 'task');
});

test('невидимые символы вычищаются; ссылки разметки собираются (у алерта консоли — ссылка на инцидент)', () => {
  assert.equal(textOf({ text: 'Сделать\u200b экспорт\u{E0041}\u{E0042}' }), 'Сделать экспорт');
  // селекторы вариантов VS17–256 (в них прячут байты после эмодзи) и частное использование — тоже вон
  assert.equal(textOf({ text: 'Ок😀\u{E0101}\u{E01EF} и\u{E000} всё' }), 'Ок😀 и всё');
  const m = { text: 'Инцидент #12 — открыть', entities: [{ type: 'text_link', offset: 15, length: 7, url: 'https://ops.admin.hrhelper.space/incidents/12' }, { type: 'text_link', offset: 0, length: 3, url: 'javascript:alert(1)' }] };
  assert.deepEqual(linksOf(m), [{ href: 'https://ops.admin.hrhelper.space/incidents/12', text: 'открыть' }]);
});

test('жалоба — ошибка; «прод», «у всех», «критично» — high и «сейчас»', () => {
  assert.deepEqual(classify(fwdUser('Не грузится запись встречи')), { type: 'bug', urgency: 'queue', severity: 'medium' });
  assert.deepEqual(classify({ text: 'На проде 502 у всех' }), { type: 'bug', urgency: 'now', severity: 'high' });
  assert.equal(classify({ text: 'белый экран после входа' }).type, 'bug');
  assert.equal(classify({ text: 'Error: cannot read properties' }).type, 'bug');
});

test('мысль — идея, остальное — задача', () => {
  assert.deepEqual(classify({ text: 'Идея: показывать стаж в карточке' }), { type: 'idea', urgency: 'queue' });
  assert.equal(classify({ text: 'Хорошо бы добавить экспорт в Excel' }).type, 'idea');
  assert.deepEqual(classify({ text: 'Добавить поле «отдел» в заявку' }), { type: 'task', urgency: 'queue' });
  assert.equal(classify({ text: '' }).type, 'task');
});

test('откуда переслано и вложения', () => {
  assert.deepEqual(originOf(fwdBot('hrmhrhelper_space_allerting_bot', 'x')), { kind: 'bot', label: '@hrmhrhelper_space_allerting_bot' });
  assert.deepEqual(originOf(fwdUser('x')), { kind: 'user', label: 'Анна' });
  // скрытый отправитель с именем «сам» не выдаёт себя за владельца: вид — hidden
  assert.deepEqual(originOf({ text: 'x', forward_origin: { type: 'hidden_user', sender_user_name: 'сам' } }), { kind: 'hidden', label: 'скрытый: сам' });
  assert.deepEqual(originOf({ text: 'x', forward_origin: { type: 'channel', chat: { title: 'Новости' } } }), { kind: 'channel', label: 'Новости' });
  assert.deepEqual(originOf({ text: 'x' }), { kind: 'self', label: 'сам' });
  assert.equal(hasMediaOf({ photo: [{}], caption: 'скрин' }), true);
  assert.equal(hasMediaOf({ text: 'x' }), false);
});

test('заголовок — первая строка без маркеров, до 120 символов', () => {
  assert.equal(titleOf('\n🔴 Распознавание падает\nподробности'), 'Распознавание падает');
  assert.equal(titleOf('a'.repeat(200)).length, 120);
  assert.equal(titleOf('   '), 'Входящее из Telegram');
});

test('смена типа: важность только у ошибки и алерта', () => {
  assert.deepEqual(withType({ type: 'bug', urgency: 'queue', severity: 'high' }, 'idea'), { type: 'idea', urgency: 'queue' });
  assert.deepEqual(withType({ type: 'task', urgency: 'queue' }, 'bug'), { type: 'bug', urgency: 'queue', severity: 'medium' });
  assert.deepEqual(withType({ type: 'task', urgency: 'now' }, 'alert'), { type: 'alert', urgency: 'now', severity: 'high' });
});
