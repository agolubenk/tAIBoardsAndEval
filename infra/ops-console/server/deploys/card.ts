/**
 * Карточка деплоя для интерфейса из строки deploy_progress (чистые функции): фазы по порядку скрипта с
 * длительностями, матрица проверок, rollback-prev, пропущенные события, запуск GitHub.
 */
import {
  DEPLOY_PHASES,
  deploySummarySchema,
  type DeployCard,
  type DeployCardCheck,
  type DeployCardPhase,
  type DeploySummary,
} from '../../shared/deploy-events-contract'
import type { deployProgress, deploys } from '../db/schema'

type ProgressRow = typeof deployProgress.$inferSelect
type RunRow = typeof deploys.$inferSelect

/**
 * Событий нет дольше — «прервался»: сборка молчит до 90+ мин (между build_start и build_done событий нет),
 * потолок задачи GitHub — 120 мин; после него деплой уже убит.
 */
export const STALE_AFTER_MS = 150 * 60_000
/** Запуск GitHub завершён, а итога от скрипта столько нет — деплой убит вместе с задачей. */
const RUN_DONE_GRACE_MS = 10 * 60_000
/** Часы GitHub и сервера расходятся на секунды; скрипт стартует через секунды–минуту после запуска. */
const SLACK_MS = 2 * 60_000
const MATCH_WINDOW_MS = 3 * 3_600_000
const MAX_MISSING_SHOWN = 20

export interface EventLogEntry {
  seq: number
  type: string
  at: number
}

const EMPTY_SUMMARY: DeploySummary = { phases: [], checks: [], rollback: null }

export function parseSummary(json: string): DeploySummary {
  try {
    const parsed = deploySummarySchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : EMPTY_SUMMARY
  } catch {
    return EMPTY_SUMMARY
  }
}

export function parseEvents(json: string): EventLogEntry[] {
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is EventLogEntry =>
        Boolean(e) && typeof e === 'object' && Number.isInteger((e as EventLogEntry).seq) && typeof (e as EventLogEntry).type === 'string',
    )
  } catch {
    return []
  }
}

/**
 * Запуск GitHub этого деплоя. По sha — у push-запуска head_sha и есть выкаченный коммит (повтор деплоя того же
 * коммита — ближайший по времени). Иначе — единственный запуск, который шёл в момент старта: ручной Run workflow
 * отдаёт вершину ветки, а не выкаченный коммит, а деплои идут строго по одному (concurrency + flock).
 */
export function matchRun(sha: string, startedAtMs: number, runs: RunRow[]): RunRow | null {
  const near = runs.filter((r) => r.startedAt && Math.abs(r.startedAt.getTime() - startedAtMs) <= MATCH_WINDOW_MS)
  const dist = (r: RunRow) => Math.abs((r.startedAt?.getTime() ?? 0) - startedAtMs)
  const bySha = near.filter((r) => r.headSha.length >= 7 && sha.startsWith(r.headSha)).sort((a, b) => dist(a) - dist(b))
  if (bySha[0]) return bySha[0]
  const containing = near.filter(
    (r) => (r.startedAt?.getTime() ?? Infinity) <= startedAtMs + SLACK_MS && (!r.finishedAt || r.finishedAt.getTime() >= startedAtMs - SLACK_MS),
  )
  return containing.length === 1 ? (containing[0] ?? null) : null
}

const ms = (unixSec: number | null) => (unixSec === null ? null : unixSec * 1000)

function spanMs(startedAt: number | null, endedAt: number | null, running: boolean, endMs: number): number | null {
  if (startedAt === null) return null
  if (endedAt !== null) return Math.max(0, (endedAt - startedAt) * 1000)
  return running ? Math.max(0, endMs - startedAt * 1000) : null
}

/** Фазы в порядке скрипта; не дошедшие — «ждёт» у идущего деплоя и «не выполнялась» у завершённого. */
function orderPhases(summary: DeploySummary, done: boolean, endMs: number): DeployCardPhase[] {
  const byKey = new Map(summary.phases.map((p) => [p.key, p]))
  const keys = [...DEPLOY_PHASES, ...summary.phases.map((p) => p.key).filter((k) => !(DEPLOY_PHASES as readonly string[]).includes(k))]
  return keys.map((key) => {
    const p = byKey.get(key)
    if (!p) return { key, status: done ? 'skipped' : 'pending', startedAt: null, endedAt: null, durationMs: null, rc: null }
    return {
      key,
      status: p.status,
      startedAt: ms(p.startedAt),
      endedAt: ms(p.endedAt),
      durationMs: spanMs(p.startedAt, p.endedAt, p.status === 'running', endMs),
      rc: p.rc,
    }
  })
}

export function buildDeployCard(row: ProgressRow, agentName: string, run: RunRow | null, now: number): DeployCard {
  const summary = parseSummary(row.summaryJson)
  const lastEventAt = row.lastEventAt.getTime()
  const runDoneAt = run?.status === 'completed' && run.finishedAt ? run.finishedAt.getTime() : null
  const stale =
    row.status === 'running' && (now - lastEventAt > STALE_AFTER_MS || (runDoneAt !== null && now - runDoneAt > RUN_DONE_GRACE_MS))
  const endMs = row.finishedAt?.getTime() ?? (stale ? lastEventAt : now)
  const received = parseEvents(row.eventsJson)
  const seen = new Set(received.map((e) => e.seq))
  const missing: number[] = []
  for (let s = 1; s <= row.lastSeq && missing.length < MAX_MISSING_SHOWN; s += 1) if (!seen.has(s)) missing.push(s)
  const checks: DeployCardCheck[] = summary.checks.map((c) => ({
    key: c.key,
    url: c.url,
    status: c.status,
    rc: c.rc,
    durationMs: spanMs(c.startedAt, c.endedAt, c.status === 'running', endMs),
  }))
  return {
    id: row.id,
    agentId: row.agentId,
    agentName,
    deployId: row.deployId,
    sha: row.sha,
    status: stale ? 'stale' : row.status,
    startedAt: row.startedAt.getTime(),
    finishedAt: row.finishedAt?.getTime() ?? null,
    durationMs: Math.max(0, endMs - row.startedAt.getTime()),
    lastEventAt,
    rc: row.rc,
    phases: orderPhases(summary, row.status !== 'running' || stale, endMs),
    checks,
    rollback: summary.rollback,
    events: { received: received.length, lastSeq: row.lastSeq, missing },
    run: run ? { runKey: run.runKey, url: run.url, title: run.title, status: run.status, conclusion: run.conclusion } : null,
  }
}
