/**
 * Мигание: один и тот же алерт (fingerprint) срабатывает снова и снова — обрыв канала связи,
 * метрика у порога. Вместо пары «алерт/восстановлено» на каждый сбой:
 *   - с 3-го срабатывания за час — одно уведомление «мигает», дальше не чаще раза в 30 мин;
 *   - восстановления, пока мигает, не рассылаются;
 *   - после 15 мин без новых сбоев — одно уведомление «стабильно» (из тика планировщика).
 * Состояние — в settings (`flap:<fingerprint>`): переживает рестарт и serverless.
 */
import { and, desc, eq, gte, like, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, settings } from '../db/schema'
import { maintenanceForRoute } from '../maintenance/store'

export const FLAP_WINDOW_MS = 60 * 60_000
export const FLAP_THRESHOLD = 3
export const FLAP_NOTICE_EVERY_MS = 30 * 60_000
export const FLAP_STABLE_AFTER_MS = 15 * 60_000

export interface FlapState {
  since: number
  lastNoticeAt: number
}

const key = (fingerprint: string) => `flap:${fingerprint}`

async function readState(fingerprint: string): Promise<FlapState | null> {
  const row = await getDb().query.settings.findFirst({ where: eq(settings.key, key(fingerprint)) })
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as Partial<FlapState>
    return typeof v.since === 'number' && typeof v.lastNoticeAt === 'number' ? { since: v.since, lastNoticeAt: v.lastNoticeAt } : null
  } catch {
    return null
  }
}

async function writeState(fingerprint: string, state: FlapState): Promise<void> {
  const value = JSON.stringify(state)
  await getDb()
    .insert(settings)
    .values({ key: key(fingerprint), value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

export async function clearFlap(fingerprint: string): Promise<void> {
  await getDb()
    .delete(settings)
    .where(eq(settings.key, key(fingerprint)))
}

/** Сколько раз алерт срабатывал за окно (включая только что созданный). */
export async function recentFires(fingerprint: string, now = Date.now()): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.fingerprint, fingerprint), gte(alerts.startedAt, new Date(now - FLAP_WINDOW_MS))))
  return Number(row?.n ?? 0)
}

export interface FireDecision {
  flapping: boolean
  count: number
  notify: boolean
}

/** Решение при новом срабатывании: слать ли уведомление и в каком виде. */
export async function onFire(fingerprint: string, now = Date.now()): Promise<FireDecision> {
  const count = await recentFires(fingerprint, now)
  if (count < FLAP_THRESHOLD) return { flapping: false, count, notify: true }
  const state = (await readState(fingerprint)) ?? { since: now, lastNoticeAt: 0 }
  const notify = now - state.lastNoticeAt >= FLAP_NOTICE_EVERY_MS
  if (notify) state.lastNoticeAt = now
  await writeState(fingerprint, state)
  return { flapping: true, count, notify }
}

/** Пока алерт мигает, отдельные восстановления не рассылаются. */
export async function isFlapping(fingerprint: string): Promise<boolean> {
  return (await readState(fingerprint)) !== null
}

export interface StableFlap {
  fingerprint: string
  alert: typeof alerts.$inferSelect
  fires: number
  quietMin: number
}

/**
 * Мигания, которые успокоились: нет горящего алерта и последнее восстановление старше 15 мин.
 * Возвращает их (для уведомления «стабильно») и сбрасывает состояние.
 */
export async function collectStableFlaps(now = Date.now()): Promise<StableFlap[]> {
  const db = getDb()
  const rows = await db.query.settings.findMany({ where: like(settings.key, 'flap:%'), limit: 100 })
  const out: StableFlap[] = []
  for (const row of rows) {
    const fingerprint = row.key.slice('flap:'.length)
    const last = await db.query.alerts.findFirst({ where: eq(alerts.fingerprint, fingerprint), orderBy: desc(alerts.startedAt) })
    if (!last) {
      await clearFlap(fingerprint)
      continue
    }
    if (last.status === 'firing' || !last.resolvedAt || now - last.resolvedAt.getTime() < FLAP_STABLE_AFTER_MS) continue
    // Техработы глушат срабатывания — тишина в окне не значит «стабильно». Ключ мигания остаётся:
    // после окна объект либо снова сорвётся, либо честно отстоит 15 минут.
    if (await maintenanceForRoute(last.route)) continue
    const fires = await recentFires(fingerprint, now)
    out.push({ fingerprint, alert: last, fires, quietMin: Math.round((now - last.resolvedAt.getTime()) / 60_000) })
    await clearFlap(fingerprint)
  }
  return out
}
