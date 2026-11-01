/**
 * Уборка вложений (раз в сутки; tmp — раз в час): срок хранения после закрытия пункта, сироты на диске и в базе,
 * оборванные загрузки, фактический объём каталога против потолка и свободного места.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { oqDocs } from '../../db/schema'
import { getEnv } from '../../env'
import { finalPath, freeBytes, listDisk, removeQuiet, tmpPath } from './storage'
import { allFileRows, deleteRows, markExpired, type FileRow } from './store'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Надгробие («удалено по сроку») держится год: дольше подпись в карточке не нужна, а строки копились бы без конца. */
const TOMBSTONE_KEEP_DAYS = 365

export interface SweepReport {
  expired: number
  orphanRows: number
  orphanFiles: number
  tmpRemoved: number
  usedBytes: number
  warn: boolean
  /** Строк без файла столько, что каталог, похоже, неверный: их уборка пропущена. */
  suspicious?: number
}

/** Оборванные загрузки старше часа. */
export async function sweepTmp(now = Date.now()): Promise<number> {
  const dir = getEnv().oqFiles.dir
  if (!dir) return 0
  let removed = 0
  for (const f of await listDisk(dir, 'tmp')) {
    if (now - f.mtimeMs > HOUR) {
      await removeQuiet(tmpPath(dir, f.name))
      removed++
    }
  }
  return removed
}

type DocLite = { updatedAt: Date; data: Record<string, unknown> }

async function loadDocs(collection: 'items' | 'checks', ids: string[]): Promise<Map<string, DocLite>> {
  const out = new Map<string, DocLite>()
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await getDb()
      .select()
      .from(oqDocs)
      .where(and(eq(oqDocs.collection, collection), inArray(oqDocs.id, ids.slice(i, i + 200))))
    for (const r of rows) {
      try {
        out.set(r.id, { updatedAt: r.updatedAt, data: JSON.parse(r.dataJson) as Record<string, unknown> })
      } catch {
        out.set(r.id, { updatedAt: r.updatedAt, data: {} })
      }
    }
  }
  return out
}

/** Закрыт ли пункт и с какого момента: архив пункта или «сделано» в ответе (как isDone страницы для входящих). */
function closedAt(item: DocLite, check: DocLite | undefined): number | null {
  const done = item.data.archived === true || check?.data.done === true || check?.data.agentStatus === 'done'
  if (!done) return null
  return Math.max(item.updatedAt.getTime(), check?.updatedAt.getTime() ?? 0)
}

export async function sweepFiles(now = Date.now()): Promise<SweepReport> {
  const cfg = getEnv().oqFiles
  const report: SweepReport = { expired: 0, orphanRows: 0, orphanFiles: 0, tmpRemoved: await sweepTmp(now), usedBytes: 0, warn: false }
  if (!cfg.dir) return report
  const dir = cfg.dir
  const rows: FileRow[] = []
  for (let page = await allFileRows(); page.length; page = await allFileRows(page[page.length - 1]!.id)) rows.push(...page)
  const itemIds = [...new Set(rows.map((r) => r.itemId))]
  const [items, checks] = await Promise.all([loadDocs('items', itemIds), loadDocs('checks', itemIds)])
  const disk = new Map((await listDisk(dir)).map((f) => [f.name, f]))

  const drop: FileRow[] = []
  const expire: FileRow[] = []
  const missing: FileRow[] = []
  for (const r of rows) {
    const item = items.get(r.itemId)
    const closed = item ? closedAt(item, checks.get(r.itemId)) : null
    const onDisk = disk.has(r.id)
    if (!item) {
      drop.push(r)
      report.orphanRows++
    } else if (r.deletedAt) {
      if (now - r.deletedAt.getTime() > TOMBSTONE_KEEP_DAYS * DAY) drop.push(r)
      continue
    } else if (closed !== null && now - Math.max(closed, r.createdAt.getTime()) > cfg.retentionDays * DAY) {
      // Срок — от закрытия, а у файла, докреплённого к уже закрытому пункту, — от его загрузки: иначе он исчез бы
      // на следующей уборке (линза GLM #313).
      expire.push(r)
      report.expired++
    } else if (!onDisk && now - r.createdAt.getTime() > DAY) {
      // Вставка идёт после rename — у строки без файла законного окна нет; сутки — запас на сбой часов.
      missing.push(r)
    }
  }
  // Страховка от неверного каталога (подменили том или OQ_FILES_DIR): если без файла больше половины живых строк
  // старше суток (только их и проверяем), это не сироты, а пустой каталог — строки не трогаем, пишем в журнал.
  const live = rows.filter((r) => !r.deletedAt && items.has(r.itemId) && now - r.createdAt.getTime() > DAY).length
  if (missing.length > 5 && missing.length * 2 > live) {
    report.suspicious = missing.length
    console.warn(`[oq-files] у ${missing.length} из ${live} файлов нет файла на диске — каталог ${dir} пуст или подменён? Строки не удалены, проверьте OQ_FILES_DIR`)
  } else {
    drop.push(...missing)
    report.orphanRows += missing.length
  }
  await deleteRows(drop.map((r) => r.id))
  await markExpired(expire.map((r) => r.id), new Date(now))
  await Promise.all([...drop, ...expire].map((r) => removeQuiet(finalPath(dir, r.id))))

  const gone = new Set([...drop, ...expire].map((r) => r.id))
  const known = new Set(rows.filter((r) => !r.deletedAt && !gone.has(r.id)).map((r) => r.id))
  for (const f of disk.values()) {
    if (!known.has(f.name) && now - f.mtimeMs > DAY) {
      console.warn(`[oq-files] файл без строки в oq_files удалён: ${f.name} (${f.size} байт)`)
      await removeQuiet(finalPath(dir, f.name))
      report.orphanFiles++
    }
  }

  const left = (await listDisk(dir)).reduce((s, f) => s + f.size, 0) + (await listDisk(dir, 'tmp')).reduce((s, f) => s + f.size, 0)
  report.usedBytes = left
  const limit = Math.min(cfg.totalCapBytes, left + (await freeBytes(dir).catch(() => Infinity)))
  report.warn = left >= limit * 0.8
  if (report.warn) console.warn(`[oq-files] вложения занимают ${Math.round(left / 1024 / 1024)} МБ — больше 80 % доступного`)
  return report
}
