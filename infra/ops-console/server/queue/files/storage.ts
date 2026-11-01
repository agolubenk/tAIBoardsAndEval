/** Диск вложений: `<dir>/<id>` — файлы, `<dir>/tmp/<id>` — идущие загрузки. Каталоги 700, файлы 600. */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { apiError } from '../../http-types'
import { getEnv, type OqFilesConfig } from '../../env'

export const newFileId = () => randomBytes(16).toString('hex')
export const FILE_ID = /^[0-9a-f]{32}$/

export function filesConfig(): OqFilesConfig & { dir: string } {
  const cfg = getEnv().oqFiles
  if (!cfg.dir) throw apiError(503, 'Хранилище вложений не настроено (OQ_FILES_DIR)')
  return { ...cfg, dir: cfg.dir }
}

export const finalPath = (dir: string, id: string) => join(dir, id)
export const tmpPath = (dir: string, id: string) => join(dir, 'tmp', id)

export async function ensureDirs(dir: string): Promise<void> {
  await mkdir(join(dir, 'tmp'), { recursive: true, mode: 0o700 })
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

export async function removeQuiet(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

/** Файлы каталога (без tmp) и их возраст — для уборки и фактического объёма. */
export async function listDisk(dir: string, sub = ''): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  const base = sub ? join(dir, sub) : dir
  const names = await readdir(base).catch(() => [] as string[])
  const out: Array<{ name: string; size: number; mtimeMs: number }> = []
  for (const name of names) {
    if (!sub && name === 'tmp') continue
    const s = await stat(join(base, name)).catch(() => null)
    if (s?.isFile()) out.push({ name, size: s.size, mtimeMs: s.mtimeMs })
  }
  return out
}
