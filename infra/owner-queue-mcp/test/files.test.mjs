// Вложения в MCP очереди: имя файла на диске, куда можно писать, целостность скачанного, что сказать агенту.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { alreadySaved, ensureDir, extOf, fileRoots, filesState, safeDir, saveStream } from '../files.mjs';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const ID = 'a'.repeat(32);
const stream = (text) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });

test('расширение — из имени консоли и только [a-z0-9]{1,5}, иначе bin', () => {
  assert.equal(extOf('скрин.png'), 'png');
  assert.equal(extOf('Отчёт.PDF'), 'pdf');
  assert.equal(extOf('лог'), 'bin');
  assert.equal(extOf('x.sh;rm -rf ~'), 'bin');
  assert.equal(extOf('../../evil.toolongext'), 'bin');
});

test('корни по умолчанию — только временный каталог: репозиторий и $HOME с их .claude, .github, LaunchAgents — отказ (QA и Безопасность #314)', () => {
  const roots = fileRoots();
  assert.deepEqual(roots, ['/tmp', '/private/tmp', tmpdir()], 'ни корня репозитория, ни домашнего каталога');
  for (const dir of [
    join(REPO, '.claude', 'rules'),
    join(REPO, '.claude', 'agents'),
    join(REPO, '.github', 'workflows'),
    join(homedir(), '.claude', 'agents'),
    join(homedir(), 'Library', 'LaunchAgents'),
    join(homedir(), '.ssh'),
  ]) assert.throws(() => safeDir(dir, roots), /вне разрешённых/, dir);
  // Симлинк из временного каталога наружу — тоже отказ: проверяется настоящий путь.
  const tmp = mkdtempSync(join(tmpdir(), 'oqmcp-roots-'));
  symlinkSync(join(REPO, '.claude'), join(tmp, 'claude'));
  assert.throws(() => safeDir(join(tmp, 'claude', 'rules'), roots), /вне разрешённых/);
  // Временный каталог и путь по умолчанию — можно.
  assert.ok(safeDir(join(tmp, 'i-1'), roots).endsWith('i-1'));
  assert.ok(safeDir(join('/tmp', 'oq-files', 'i-1'), roots).endsWith(join('oq-files', 'i-1')));
});

test('OQ_FILES_DIR — явный дополнительный корень, по умолчанию его нет', () => {
  assert.deepEqual(fileRoots('/srv/oq-files'), ['/tmp', '/private/tmp', tmpdir(), '/srv/oq-files']);
  assert.equal(fileRoots('').length, 3);
});

test('каталог — только внутри разрешённых корней: абсолютный, без выхода по симлинку и без .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'oqmcp-'));
  assert.ok(safeDir(join(root, 'i-1', 'deep'), [root]).endsWith(join('i-1', 'deep')));
  assert.throws(() => safeDir('relative/dir', [root]), /абсолютный/);
  assert.throws(() => safeDir('/etc/oq', [root]), /вне разрешённых/);
  symlinkSync('/etc', join(root, 'link'));
  assert.throws(() => safeDir(join(root, 'link', 'x'), [root]), /вне разрешённых/);
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  assert.throws(() => safeDir(join(root, 'repo', '.git', 'hooks'), [root]), /\.git/);
  // Похожий префикс — не вложенность: /tmp/oqmcp-x2 не внутри /tmp/oqmcp-x.
  assert.throws(() => safeDir(`${root}2/x`, [root]), /вне разрешённых|не найден/);
});

test('скачанное ложится как <id>.<ext>; неполный файл — ошибка, ни .part, ни «целого» не остаётся', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqmcp-save-'));
  const ok = await saveStream(stream('привет'), dir, ID, 'txt', Buffer.byteLength('привет'));
  assert.equal(ok.path, join(dir, `${ID}.txt`));
  assert.equal(readFileSync(ok.path, 'utf8'), 'привет');
  await assert.rejects(saveStream(stream('коротко'), dir, 'b'.repeat(32), 'txt', 1000), /не целиком/);
  assert.deepEqual(readdirSync(dir).sort(), [`${ID}.txt`]);
  await assert.rejects(saveStream(stream('x'), dir, '../evil', 'txt', 1), /id файла/);
  assert.equal(existsSync(join(dir, '..', 'evil.txt')), false);
});

test('агенту: ready + failed < expected — «ещё грузятся»; без обещанных файлов — без заметки', () => {
  assert.deepEqual(filesState({ filesExpected: 3, filesFailed: [{ name: 'big.log', reason: 'больше 20 МБ' }] }, 1), {
    ready: 1, expected: 3, failed: [{ name: 'big.log', reason: 'больше 20 МБ' }], incomplete: true, note: 'файлы ещё грузятся — повторите через минуту',
  });
  assert.deepEqual(filesState({ filesExpected: 2 }, 2), { ready: 2, expected: 2, failed: [] });
  assert.deepEqual(filesState({}, 0), { ready: 0, expected: 0, failed: [] });
  assert.deepEqual(filesState(undefined, 1), { ready: 1, expected: 0, failed: [] });
});

test('sha256 из списка консоли: подмена по дороге — ошибка без следа; тот же файл повторно не качается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqmcp-sha-'));
  const text = 'содержимое';
  const sha = createHash('sha256').update(text).digest('hex');
  const size = Buffer.byteLength(text);
  await assert.rejects(saveStream(stream('подмена!!!!!!!!!!'.slice(0, 10)), dir, ID, 'txt', Buffer.byteLength('подмена!!!!!!!!!!'.slice(0, 10)), sha), /sha256/);
  assert.deepEqual(readdirSync(dir), []);
  const ok = await saveStream(stream(text), dir, ID, 'txt', size, sha);
  assert.deepEqual(await alreadySaved(dir, ID, 'txt', size, sha), ok);
  assert.equal(await alreadySaved(dir, ID, 'txt', size, 'f'.repeat(64)), null, 'другой отпечаток — качать заново');
  assert.equal(await alreadySaved(dir, 'b'.repeat(32), 'txt', size, sha), null);
});

test('подставленный симлинк на .part или на итоговое имя не даёт писать за пределы каталога (линза GLM #314)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqmcp-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'oqmcp-outside-'));
  const victim = join(outside, 'authorized_keys');
  writeFileSync(victim, 'исходное');
  const text = 'содержимое третьего лица';
  const sha = createHash('sha256').update(text).digest('hex');
  // Ссылка на месте временного файла: запись идёт в новый файл, а не по ссылке.
  symlinkSync(victim, join(dir, `${ID}.txt.part`));
  const ok = await saveStream(stream(text), dir, ID, 'txt', Buffer.byteLength(text), sha);
  assert.equal(readFileSync(victim, 'utf8'), 'исходное');
  assert.equal(lstatSync(ok.path).isFile(), true);
  // Ссылка на месте итогового имени: rename заменяет саму запись каталога, цель цела.
  const id2 = 'c'.repeat(32);
  symlinkSync(victim, join(dir, `${id2}.txt`));
  assert.equal(await alreadySaved(dir, id2, 'txt', 8, createHash('sha256').update('исходное').digest('hex')), null, 'симлинк — не «уже скачан»');
  const ok2 = await saveStream(stream(text), dir, id2, 'txt', Buffer.byteLength(text), sha);
  assert.equal(lstatSync(ok2.path).isFile(), true);
  assert.equal(readFileSync(victim, 'utf8'), 'исходное');
});

test('каталог проверяется ещё раз после создания: часть пути, подменённая симлинком наружу, — отказ', () => {
  const root = mkdtempSync(join(tmpdir(), 'oqmcp-race-'));
  const outside = mkdtempSync(join(tmpdir(), 'oqmcp-race-out-'));
  const checked = safeDir(join(root, 'sub', 'deeper'), [root]);
  // Между проверкой и mkdir: «sub» стал ссылкой наружу.
  symlinkSync(outside, join(root, 'sub'));
  assert.throws(() => ensureDir(checked, [root]), /вне разрешённых/);
  assert.ok(ensureDir(join(root, 'ok'), [root]).endsWith('ok'));
});

test('без размера или с кривым sha256 в списке консоли файл не принимается, а не проходит без сверки', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqmcp-strict-'));
  await assert.rejects(saveStream(stream('x'), dir, ID, 'txt', undefined), /размер/);
  await assert.rejects(saveStream(stream('x'), dir, ID, 'txt', 1, 'not-a-sha'), /sha256/);
  assert.deepEqual(readdirSync(dir), []);
});

test('filesState: удалённые по сроку не держат «ещё грузятся»; через час ожидания — «не дошли» (линза GLM #314)', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const fresh = { filesExpected: 3, receivedAt: '2026-10-22T11:50:00.000Z' };
  assert.match(filesState(fresh, 1, 0, now).note, /ещё грузятся/);
  const kept = filesState(fresh, 1, 2, now);
  assert.equal(kept.expired, 2);
  assert.match(kept.note, /удалена по сроку/);
  const stale = filesState({ filesExpected: 3, receivedAt: '2026-10-22T10:30:00.000Z' }, 1, 0, now);
  assert.match(stale.note, /не дошла: прошло больше часа/);
  assert.equal(filesState({ filesExpected: 2 }, 2, 0, now).note, undefined);
});

test('тело длиннее заявленного — обрыв на лету, без полуфайла (линза GLM «ресурсы» #314)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqmcp-big-'));
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled += 1; if (pulled > 1000) { c.close(); return; } c.enqueue(new Uint8Array(1024)); } });
  await assert.rejects(saveStream(body, dir, ID, 'bin', 2048), /длиннее заявленного/);
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(pulled < 100, `прочитано ${pulled} КиБ из 1000 — поток оборван сразу`);
});
