/**
 * Срок жизни команд агенту. Команда, которую агент не забрал, или забрал, но не прислал
 * результат (ответ консоли потерялся по сети, функция Vercel упёрлась в таймаут), не должна
 * вечно висеть «в работе»: она блокирует новые перезапуски контейнера и глушит его алерты.
 */
import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { commands } from '../db/schema'

export const COMMAND_TTL_MS = 10 * 60_000

export async function expireStaleCommands(agentId?: string, now = Date.now()): Promise<void> {
  const db = getDb()
  const cutoff = new Date(now - COMMAND_TTL_MS)
  const scope = agentId ? eq(commands.agentId, agentId) : undefined
  await db
    .update(commands)
    .set({ status: 'expired', finishedAt: new Date(now), output: 'Агент не забрал команду за 10 минут' })
    .where(and(scope, eq(commands.status, 'pending'), lt(commands.requestedAt, cutoff)))
  await db
    .update(commands)
    .set({
      status: 'expired',
      finishedAt: new Date(now),
      output: 'Агент забрал команду, но не прислал результат за 10 минут — проверьте контейнер вручную',
    })
    .where(and(scope, eq(commands.status, 'claimed'), lt(commands.claimedAt, cutoff)))
}
