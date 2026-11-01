/**
 * «Занят ≠ завис» для правила «Контейнер unhealthy» (s-diar-busy, 21.10). Однопроцессный пакетный сервис, который
 * считает длинную задачу, не успевает ответить на healthcheck — так 21.10 поднялся P0 #241 на диаризации во время
 * «Переразметить». Такой контейнер занят, а не сломан.
 *
 * Только для сервисов из списка правила (`metric`: «diarization,whisper»). Для остальных unhealthy при высоком CPU —
 * авария: горячий цикл или заблокированный event loop, сервис не отвечает пользователю («Контроль», 22.10).
 *
 * - Занят — CPU не ниже порога правила (`threshold`, % ядра, как в docker stats).
 * - Внутри эпизода низкий CPU терпится BUSY_GRACE_MS: загрузка файла и модели перед расчётом, флип docker в healthy
 *   после задачи. Дольше — тревога, как у зависания.
 * - Тихо — не дольше BUSY_MAX_MS от начала эпизода: зависание с CPU 100 % не должно молчать вечно. Пропуски отчётов
 *   агента потолок не сбрасывают.
 * - Эпизод закрывается, только когда healthcheck проходит BUSY_SETTLE_MS подряд: мигание статуса на грани таймаута не
 *   дробит одну задачу на эпизоды и не обнуляет потолок.
 *
 * Состояние эпизода — строки rule_streaks, время — updatedAt:
 * - `busy:<отпечаток>` — последний занятый замер, streak — пик CPU эпизода;
 * - `busyfrom:<отпечаток>` — начало эпизода;
 * - `busyok:<отпечаток>` — первый здоровый замер после занятости: эпизод закроется через BUSY_SETTLE_MS.
 * Строки старше суток убирает ежедневная уборка (pruneBusyEpisodes): контейнер удалили или правило поменяли.
 */
import { and, inArray, like, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { ruleStreaks } from '../db/schema'
import { BUSY_MAX_MS } from '../../shared/busy-limits'

/** Сколько внутри эпизода терпеть низкий CPU: загрузка файла и модели перед расчётом, флип docker в healthy. */
export const BUSY_GRACE_MS = 10 * 60_000
/**
 * Сколько healthcheck должен проходить подряд, чтобы эпизод закрылся. docker ставит unhealthy после 3 неудач (≈90 с
 * при интервале 30 с) и healthy после одной удачи: при мигании здоровая фаза короче 3 минут.
 */
export const BUSY_SETTLE_MS = 3 * 60_000
export { BUSY_MAX_MS }

const busyKey = (fingerprint: string) => `busy:${fingerprint}`
const fromKey = (fingerprint: string) => `busyfrom:${fingerprint}`
const okKey = (fingerprint: string) => `busyok:${fingerprint}`

/** «diarization, whisper» → набор имён сервисов; пусто — исключения «занят» нет ни у кого. */
export function batchServices(list: string | null | undefined): Set<string> {
  return new Set((list ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

/** Сервис из списка: compose-сервис совпал, а без него — имя контейнера compose вида «проект-сервис-1». */
export function isBatchService(c: { name: string; composeService?: string | null }, services: Set<string>): boolean {
  if (!services.size) return false
  const svc = (c.composeService ?? '').trim().toLowerCase()
  if (svc) return services.has(svc)
  const name = c.name.toLowerCase()
  return [...services].some((s) => name === s || new RegExp(`(^|[-_])${s.replace(/[^a-z0-9]/g, '\\$&')}([-_]\\d+)?$`).test(name))
}

/** Порог занятости задан (0 — правило без него, как до 22.10) и CPU не ниже. CPU неизвестен — не занят. */
export function busyNow(cpuPct: number | null | undefined, threshold: number): boolean {
  return threshold > 0 && typeof cpuPct === 'number' && Number.isFinite(cpuPct) && cpuPct >= threshold
}

export interface BusyVerdict {
  /** Не тревожить: занят сейчас или в последние BUSY_GRACE_MS, и эпизод не дольше BUSY_MAX_MS. */
  quiet: boolean
  /** Занят дольше BUSY_MAX_MS подряд — тревога «занят слишком долго». */
  tooLong: boolean
  /** Эпизод только начался — повод для одной тихой отметки в ленте. */
  started: boolean
  /** Сколько длится эпизод, мин. */
  minutes: number
  /** Пик CPU эпизода, % ядра: в тексте тревоги «занят слишком долго», а не последний замер. */
  maxCpu: number
}

const QUIET_NO: BusyVerdict = { quiet: false, tooLong: false, started: false, minutes: 0, maxCpu: 0 }

async function rows(fingerprint: string) {
  const keys = [busyKey(fingerprint), fromKey(fingerprint), okKey(fingerprint)]
  const list = await getDb().query.ruleStreaks.findMany({ where: inArray(ruleStreaks.fingerprint, keys) })
  const row = (key: string) => list.find((r) => r.fingerprint === key)
  return { last: row(keys[0]!), from: row(keys[1]!), ok: row(keys[2]!) }
}

async function drop(...keys: string[]): Promise<void> {
  await getDb().delete(ruleStreaks).where(inArray(ruleStreaks.fingerprint, keys))
}

async function put(fingerprint: string, at: Date, streak: number): Promise<void> {
  await getDb()
    .insert(ruleStreaks)
    .values({ fingerprint, streak, updatedAt: at })
    .onConflictDoUpdate({ target: ruleStreaks.fingerprint, set: { streak, updatedAt: at } })
}

/** Решение для unhealthy-контейнера из списка пакетных сервисов. */
export async function busyVerdict(fingerprint: string, cpuPct: number | null | undefined, threshold: number, now: number): Promise<BusyVerdict> {
  if (!(threshold > 0)) return QUIET_NO
  const { last, from, ok } = await rows(fingerprint)
  // Снова unhealthy до того, как здоровье устоялось, — та же задача: эпизод продолжается, без новой отметки.
  if (ok) await drop(okKey(fingerprint))
  const sinceLast = last ? now - last.updatedAt.getTime() : Infinity
  if (busyNow(cpuPct, threshold)) {
    // Новый эпизод — только после закрытого (здоров BUSY_SETTLE_MS) или если агент молчал дольше потолка: пропуск
    // отчётов на придушенном хосте потолок не обнуляет.
    const started = !from || sinceLast > BUSY_MAX_MS
    const fromAt = started ? now : from!.updatedAt.getTime()
    if (started) await put(fromKey(fingerprint), new Date(now), 0)
    const maxCpu = Math.max(started ? 0 : (last?.streak ?? 0), Math.round(cpuPct as number))
    await put(busyKey(fingerprint), new Date(now), maxCpu)
    const minutes = Math.floor((now - fromAt) / 60_000)
    const tooLong = now - fromAt > BUSY_MAX_MS
    return { quiet: !tooLong, tooLong, started, minutes, maxCpu }
  }
  if (!from || sinceLast >= BUSY_GRACE_MS) return QUIET_NO
  const minutes = Math.floor((now - from.updatedAt.getTime()) / 60_000)
  const tooLong = now - from.updatedAt.getTime() > BUSY_MAX_MS
  return { quiet: !tooLong, tooLong, started: false, minutes, maxCpu: last?.streak ?? 0 }
}

/**
 * Здоровый замер пакетного сервиса. Эпизод закрывается, когда healthcheck проходит BUSY_SETTLE_MS подряд: итог
 * (длительность и пик CPU) — для тихой отметки. null — эпизода нет или здоровье ещё не устоялось.
 */
export async function busyHealthy(fingerprint: string, now: number): Promise<{ minutes: number; maxCpu: number } | null> {
  const { last, from, ok } = await rows(fingerprint)
  if (!last && !from) {
    if (ok) await drop(okKey(fingerprint))
    return null
  }
  if (!ok) {
    await put(okKey(fingerprint), new Date(now), 0)
    return null
  }
  if (now - ok.updatedAt.getTime() < BUSY_SETTLE_MS) return null
  await drop(busyKey(fingerprint), fromKey(fingerprint), okKey(fingerprint))
  if (!from) return null
  return { minutes: Math.max(0, Math.round(((last?.updatedAt.getTime() ?? now) - from.updatedAt.getTime()) / 60_000)), maxCpu: last?.streak ?? 0 }
}

/** Ежедневная уборка: строки эпизодов старше суток — контейнер удалён или пересоздан под другим именем, правило изменено. */
export async function pruneBusyEpisodes(now: number): Promise<void> {
  await getDb()
    .delete(ruleStreaks)
    .where(and(like(ruleStreaks.fingerprint, 'busy%'), lt(ruleStreaks.updatedAt, new Date(now - 24 * 3_600_000))))
}
