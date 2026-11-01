// Вложения входящих для MCP очереди: куда скачивать, как назвать файл, что сказать агенту о загрузке.
// Имена файлов — данные владельца или третьих лиц (пересланное), поэтому на диск файл ложится под своим id
// с расширением, а не под присланным именем. Чистые функции — их проверяет test/files.test.mjs.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const FILE_ID = /^[0-9a-f]{32}$/;
/** id входящего, из которого строится каталог по умолчанию: без точек и разделителей пути. */
export const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Расширение из имени, которое дала консоль (она ставит его по содержимому): только [a-z0-9]{1,5}, иначе bin. */
export function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'bin';
}

function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Каталог для скачивания — только внутри разрешённых корней. Существующая часть пути раскрывается через realpath:
 * симлинк внутри корня не выведет запись за его пределы. Возвращает абсолютный путь (каталог может ещё не существовать).
 */
/**
 * Куда oq_file_get может писать: только временный каталог и явный OQ_FILES_DIR. Не репозиторий и не домашний каталог:
 * установленная копия MCP лежит в ~/.hr-owner-queue-bot/mcp, и «рядом с сервером» там — весь $HOME. А в репозитории есть
 * каталоги, которые инструменты подгружают сами: `.claude/rules` и `.claude/agents` — в контекст каждой сессии,
 * `.github/workflows` — на раннер. Файл вложения — данные третьих лиц, и агент под промпт-инъекцией из него не должен
 * класть их туда (ревью QA #314).
 */
export function fileRoots(extraDir) {
  return ['/tmp', '/private/tmp', tmpdir(), ...(extraDir ? [extraDir] : [])];
}

export function safeDir(dir, roots) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('dir — абсолютный путь во временном каталоге (/tmp, scratchpad сессии) или в OQ_FILES_DIR');
  let probe = resolve(dir);
  const rest = [];
  let real = realOrNull(probe);
  while (real === null) {
    const up = dirname(probe);
    if (up === probe) throw new Error(`dir не найден: ${dir}`);
    rest.unshift(basename(probe));
    probe = up;
    real = realOrNull(probe);
  }
  const target = join(real, ...rest);
  const allowed = roots.map(realOrNull).filter(Boolean);
  if (!allowed.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new Error(`dir вне разрешённых каталогов (${roots.join(', ')}): ${dir}`);
  }
  if (target.split(sep).includes('.git')) throw new Error('dir внутри .git — нельзя');
  return target;
}

/** sha256 файла на диске (потоком). */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Создать каталог и проверить его ещё раз уже целиком: между проверкой safeDir и mkdir часть пути могла стать
 * симлинком наружу (агент под промпт-инъекцией из вложения). Возвращает настоящий путь — в него и пишем.
 */
export function ensureDir(dir, roots) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return safeDir(realpathSync(dir), roots);
}

const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Путь, куда ляжет файл: <dir>/<id>.<ext>. */
export function finalPath(dir, id, ext) {
  if (!FILE_ID.test(id)) throw new Error('Неверный id файла');
  return join(dir, `${id}.${ext}`);
}

/** Уже скачан тот же файл (размер и sha256 совпали) — повторно не качаем. */
export async function alreadySaved(dir, id, ext, size, sha256) {
  const path = finalPath(dir, id, ext);
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) return null;
  // Только обычный файл: симлинк на чужой файл «уже скачанным» не считается (rename его заменит).
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.size !== size) return null;
  return (await sha256File(path)) === sha256 ? { path, size } : null;
}

/**
 * Поток ответа — в <dir>/<id>.<ext>: сначала .part, сверка размера и sha256 со списком консоли, затем rename. Обрыв
 * или подмена по дороге не оставят файла, похожего на целый; повтор перезапишет прежний.
 */
export async function saveStream(body, dir, id, ext, expectedSize, expectedSha256) {
  const final = finalPath(dir, id, ext);
  // Сверка — обязательна: без размера (или с кривым sha256) в списке консоли файл не принимается, а не проходит молча.
  if (!Number.isInteger(expectedSize) || expectedSize < 0) throw new Error('консоль не дала размер файла — сверить нечем');
  if (expectedSha256 !== undefined && expectedSha256 !== null && !/^[0-9a-f]{64}$/.test(String(expectedSha256))) throw new Error('консоль дала неверный sha256 — сверить нечем');
  const part = `${final}.part`;
  const hash = createHash('sha256');
  // Остаток прошлой попытки (или подставленный симлинк) убирается: rm удаляет саму ссылку, а не файл, куда она ведёт.
  // Запись — только созданием (wx = O_CREAT|O_EXCL): открыть через симлинк нельзя, подставленный снова — ошибка.
  rmSync(part, { force: true });
  try {
    let bytes = 0;
    await pipeline(Readable.fromWeb(body), async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        // Тело длиннее заявленного (сбой консоли, зацикленный прокси) — обрыв сразу, а не после записи на диск целиком.
        if (bytes > expectedSize) throw new Error(`файл длиннее заявленного: больше ${expectedSize} байт`);
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
    const size = lstatSync(part).size;
    if (size !== expectedSize) throw new Error(`файл пришёл не целиком: ${size} из ${expectedSize} байт`);
    if (expectedSha256 && hash.digest('hex') !== expectedSha256) throw new Error('sha256 не совпал со списком консоли');
    // rename заменяет саму запись каталога: симлинк на месте итогового имени заменяется файлом, цель ссылки не трогается.
    if (isLink(part)) throw new Error('временный файл подменён');
    renameSync(part, final);
    return { path: final, size };
  } catch (e) {
    rmSync(part, { force: true }); // ссылку удаляет как ссылку — цель не задевается
    throw e;
  }
}

/** Сколько ждать обещанные файлы от получения пункта — как на странице /queue (OQF_WAIT_MS). */
const FILES_WAIT_MS = 60 * 60_000;

/**
 * Что агенту знать о файлах входящего: ready — загружено, expected — сколько обещал создатель (бот или форма),
 * failed — что не принято и почему, expired — удалено по сроку хранения. ready + failed + expired < expected — файлы
 * ещё в пути, но не дольше часа от получения: дальше это «не дошли» (бот упал между записью пункта и загрузкой),
 * и бесконечное «повторите через минуту» держало бы агента.
 */
export function filesState(inbox, ready, expired = 0, now = Date.now()) {
  const expected = Number.isInteger(inbox?.filesExpected) && inbox.filesExpected > 0 ? inbox.filesExpected : 0;
  const failed = Array.isArray(inbox?.filesFailed) ? inbox.filesFailed.slice(0, 20) : [];
  const gone = Number.isInteger(expired) && expired > 0 ? expired : 0;
  const state = { ready, expected, failed, ...(gone ? { expired: gone } : {}) };
  if (expected && ready + failed.length + gone < expected) {
    // Набор файлов неполный — агент не должен принимать его за все вложения пункта.
    state.incomplete = true;
    const at = Date.parse(inbox?.receivedAt ?? '');
    state.note = Number.isFinite(at) && now - at > FILES_WAIT_MS
      ? 'часть файлов не дошла: прошло больше часа — спросите владельца'
      : 'файлы ещё грузятся — повторите через минуту';
  } else if (gone) {
    state.note = 'часть файлов удалена по сроку хранения';
  }
  return state;
}
