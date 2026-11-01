/** Лента событий консоли: единая хронология действий, алертов, деплоев, настроек. */
import { getDb } from './db/client'
import { activity } from './db/schema'

export type ActivityKind = (typeof activity.$inferInsert)['kind']

export async function logActivity(kind: ActivityKind, message: string, actor = 'system', route = ''): Promise<void> {
  try {
    await getDb()
      .insert(activity)
      .values({ kind, message: message.slice(0, 500), actor: actor.slice(0, 120), route, createdAt: new Date() })
  } catch (err) {
    // Лента — best effort: её сбой не должен ронять основное действие.
    console.warn('[ops] activity log failed:', err instanceof Error ? err.message : err)
  }
}
