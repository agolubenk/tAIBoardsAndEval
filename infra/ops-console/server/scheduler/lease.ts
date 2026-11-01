/**
 * Аренда планировщика в БД: тик выполняет один исполнитель, даже если его одновременно
 * вызвали локальный таймер, Vercel Cron, внешний пингер и отчёт агента.
 */
import { sql } from 'drizzle-orm'
import { getDb } from '../db/client'

export async function tryAcquireLease(name: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const key = `lease:${name}`
  const until = String(now + ttlMs)
  const res = await getDb().run(sql`
    INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${until}, ${now})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE CAST(settings.value AS INTEGER) < ${now}`)
  return res.rowsAffected > 0
}

export async function releaseLease(name: string): Promise<void> {
  await getDb().run(sql`UPDATE settings SET value = '0' WHERE key = ${`lease:${name}`}`)
}
