/** Перезапуски контейнеров за последние 10 минут (как правило «restart loop») — для страницы хоста и бота. */
import { and, eq, gte } from 'drizzle-orm'
import { getDb } from '../db/client'
import { metricSamples } from '../db/schema'
import { metricPrefix, restartDeltaFor } from '../alerts/evaluate-host'

/**
 * История счётчика пишется только при изменении, поэтому без записей в окне — ноль, а точный
 * расчёт — только для тех, у кого записи есть (обычно ни одного).
 */
export async function recentRestarts(
  agentId: string,
  ctrs: Array<{ name: string; restartCount: number }>,
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 10 * 60_000)
  const changed = await getDb()
    .selectDistinct({ metric: metricSamples.metric })
    .from(metricSamples)
    .where(and(eq(metricSamples.agentId, agentId), metricPrefix('restarts:'), gte(metricSamples.createdAt, since)))
    .limit(250)
  const names = new Set(changed.map((r) => r.metric.slice('restarts:'.length)))
  const out: Record<string, number> = {}
  for (const c of ctrs) if (names.has(c.name)) out[c.name] = await restartDeltaFor(agentId, c.name, c.restartCount)
  return out
}
