/**
 * Приём отчёта агента: результаты команд → состояние контейнеров → метрики → правила →
 * выдача новых команд. Ответ агенту — список команд (перезапуски), которые он выполнит.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, commands, containers, metricSamples } from '../db/schema'
import type { AgentCommand, AgentContainer, AgentReport } from '../../shared/agent-contract'
import { logActivity } from '../activity'
import { plural } from '../../shared/plural'
import { mb } from '../alerts/explain'
import { evaluateContainers, evaluateHostMetrics } from '../alerts/evaluate-host'
import { isStateful } from '../alerts/container-state'
import { expireStaleCommands } from '../containers/commands'
import { syncDomains } from './domains'
import { errCode, syncVpn, vpnSummary } from './vpn'
import { extractHostSamples } from './samples'
import type { AgentRow } from './signature'

const SAMPLE_EVERY_MS = 55_000
const CONTAINER_REFRESH_MS = 5 * 60_000

async function applyCommandResults(agent: AgentRow, report: AgentReport): Promise<void> {
  const db = getDb()
  for (const r of report.commandResults) {
    const [cmd] = await db
      .update(commands)
      .set({ status: r.status, output: r.output.slice(0, 4000), finishedAt: new Date() })
      .where(and(eq(commands.id, r.id), eq(commands.agentId, agent.id), inArray(commands.status, ['pending', 'claimed'])))
      .returning()
    if (cmd) {
      const ok = r.status === 'succeeded'
      await logActivity(
        'action',
        `${ok ? '✅' : '❌'} Перезапуск ${cmd.target} на ${agent.name}: ${ok ? 'выполнен' : `ошибка — ${r.output.slice(0, 200)}`}`,
        cmd.requestedBy,
        `/infrastructure/${agent.id}`,
      )
    }
  }
}

function parseStartedAt(raw: string | undefined): Date | null {
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) && t > 0 ? new Date(t) : null
}

/**
 * Сколько процессов ядро убило с прошлого отчёта. Итог агента — по журналу ядра у этого id контейнера: растёт и
 * переживает перезапуск. null у прошлого значения — первая точка отсчёта (0). Итог меньше прошлого — контейнер
 * пересоздан (новый id) или агент потерял учёт: новая точка отсчёта, а не «убито N».
 */
export function newOomKills(prev: { oomKills: number | null } | undefined, next: { oomKills: number | null }): number {
  if (next.oomKills === null || !prev || prev.oomKills === null) return 0
  return next.oomKills > prev.oomKills ? next.oomKills - prev.oomKills : 0
}

/** Стек продукта — основной проект агента; агент до 1.5 основного проекта не шлёт (и видел только его). */
export function isMainStack(report: Pick<AgentReport, 'mainProject'>, c: Pick<AgentContainer, 'composeProject'>): boolean {
  return !report.mainProject || c.composeProject === report.mainProject
}

async function syncContainers(agent: AgentRow, report: AgentReport): Promise<void> {
  if (!report.containers) return
  const db = getDb()
  const existing = await db.query.containers.findMany({ where: eq(containers.agentId, agent.id), limit: 250 })
  const byName = new Map(existing.map((c) => [c.name, c]))
  const now = Date.now()
  for (const c of report.containers) {
    const prev = byName.get(c.name)
    const row = {
      agentId: agent.id,
      name: c.name,
      image: c.image,
      state: c.state,
      health: c.health || 'none',
      statusText: c.status,
      restartCount: c.restartCount,
      cpuPct: c.cpuPct ?? null,
      memMb: c.memMb ?? null,
      memLimitMb: c.memLimitMb ?? null,
      startedAt: parseStartedAt(c.startedAt),
      composeService: c.composeService,
      composeProject: c.composeProject,
      restartable: c.restartable ?? null,
      mainStack: isMainStack(report, c),
      restartPolicy: c.restartPolicy,
      exitCode: c.exitCode ?? null,
      healthLog: c.healthLog,
      stateful: isStateful(c),
      oomKills: c.oomKills ?? null,
      memPeakMb: c.memPeakMb ?? null,
      swapPeakMb: c.swapPeakMb ?? null,
      updatedAt: new Date(now),
    }
    const changed =
      !prev ||
      prev.state !== row.state ||
      prev.health !== row.health ||
      prev.healthLog !== row.healthLog ||
      prev.restartCount !== row.restartCount ||
      prev.oomKills !== row.oomKills ||
      prev.image !== row.image ||
      prev.restartable !== row.restartable ||
      prev.composeProject !== row.composeProject ||
      prev.mainStack !== row.mainStack ||
      prev.startedAt?.getTime() !== row.startedAt?.getTime() ||
      now - prev.updatedAt.getTime() > CONTAINER_REFRESH_MS
    if (changed) {
      await db
        .insert(containers)
        .values(row)
        .onConflictDoUpdate({ target: [containers.agentId, containers.name], set: row })
    }
    // История счётчика — только при изменении: база окна restart loop берётся из последнего значения.
    if (!prev || prev.restartCount !== c.restartCount) {
      await db
        .insert(metricSamples)
        .values({ agentId: agent.id, metric: `restarts:${c.name}`, value: c.restartCount, createdAt: new Date(now) })
    }
    // Убитые ядром по нехватке памяти. Первое значение — точка отсчёта (старые случаи до учёта не новые). В историю
    // пишется прирост (oomnew:<имя>) в момент, когда он замечен: правило суммирует приросты за окно, поэтому алерт
    // совпадает с записью в ленте и не зависит от того, сколько хранится история.
    const added = newOomKills(prev, row)
    if (added > 0) {
      await db.insert(metricSamples).values({ agentId: agent.id, metric: `oomnew:${c.name}`, value: added, createdAt: new Date(now) })
      const peak = c.memPeakMb !== undefined ? `; пик памяти ${mb(c.memPeakMb)}${c.memLimitMb ? ` из ${mb(c.memLimitMb)}` : ''}` : ''
      const swap = c.swapPeakMb ? `; swap ${mb(c.swapPeakMb)}` : ''
      const victims = c.oomVictims ? `; за 3 сут.: ${c.oomVictims}` : ''
      await logActivity(
        'agent',
        `${c.name} · ${agent.name}: ядро убило ${plural(added, ['процесс', 'процесса', 'процессов'])} по нехватке памяти (всего у контейнера — ${c.oomKills}${peak}${swap}${victims})`,
        'system',
        `/infrastructure/${agent.id}`,
      )
    }
  }
  const names = report.containers.map((c) => c.name)
  await db
    .delete(containers)
    .where(names.length ? and(eq(containers.agentId, agent.id), notInArray(containers.name, names)) : eq(containers.agentId, agent.id))
}

async function claimCommands(agentId: string): Promise<AgentCommand[]> {
  const db = getDb()
  await expireStaleCommands(agentId)
  const pending = await db
    .select({ id: commands.id })
    .from(commands)
    .where(and(eq(commands.agentId, agentId), eq(commands.status, 'pending')))
    .orderBy(commands.requestedAt)
    .limit(5)
  if (!pending.length) return []
  // `status = pending` в условии: параллельный запрос того же агента не заберёт команду дважды.
  return db
    .update(commands)
    .set({ status: 'claimed', claimedAt: new Date() })
    .where(
      and(
        inArray(
          commands.id,
          pending.map((p) => p.id),
        ),
        eq(commands.status, 'pending'),
      ),
    )
    .returning({ id: commands.id, type: commands.type, target: commands.target })
}

/**
 * Новый ли это замер бизнес-метрик. Агент считает их раз в BUSINESS_INTERVAL_SEC, а значение повторяет в каждом
 * отчёте (раз в 15 с): правила biz_* оцениваются только на новом замере и считают замеры, а не отчёты.
 */
export function isNewBusinessSample(prevSnapshotJson: string | null, report: Pick<AgentReport, 'businessAt'>): boolean {
  if (report.businessAt === undefined) return false
  try {
    const prev: unknown = prevSnapshotJson ? JSON.parse(prevSnapshotJson) : null
    return !(prev && typeof prev === 'object' && (prev as { businessAt?: unknown }).businessAt === report.businessAt)
  } catch {
    return true
  }
}

/**
 * Что из отчёта хранится в agents.last_snapshot_json. Снимок отдают все роли (/overview, /infra/agents) и он
 * переписывается каждые 15 с, поэтому в нём только метрики хоста: контейнеры уже лежат в своей таблице (в снимке —
 * счётчики для строки «агент молчит»), а будущие поля отчёта сюда не попадают, пока их не впишут явно.
 */
const SNAPSHOT_FIELDS = [
  'agentVersion',
  'hostname',
  'os',
  'osName',
  'intervalSec',
  'capturedAt',
  'uptimeSec',
  'cpu',
  'memory',
  'disks',
  'network',
  'mainProject',
  'dockerError',
  'nginx',
  'business',
  'businessAt',
  'businessFailed',
  'domainsFailed',
  'domainsTotal',
] as const satisfies ReadonlyArray<keyof AgentReport>

export function storedSnapshot(report: AgentReport): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SNAPSHOT_FIELDS) if (report[key] !== undefined) out[key] = report[key]
  const reported = report.containers
  if (reported) out.containerCounts = { running: reported.filter((c) => c.state === 'running').length, total: reported.length }
  if (report.vpn) out.vpn = vpnSummary(report.vpn)
  return out
}

export async function processReport(agent: AgentRow, report: AgentReport): Promise<AgentCommand[]> {
  const db = getDb()
  await applyCommandResults(agent, report)

  const samples = extractHostSamples(report)
  const now = Date.now()
  const sampleNow = !agent.lastSampleAt || now - agent.lastSampleAt.getTime() >= SAMPLE_EVERY_MS
  await syncContainers(agent, report)
  // Домены — не чаще изменения списка или раза в час; их сбой не должен лишать хост алертов по контейнерам.
  await syncDomains(agent, report).catch((err: unknown) => console.warn('[ops] domains sync failed:', err))
  await syncVpn(agent.id, report).catch((err: unknown) => console.warn('[ops] vpn sync failed:', errCode(err)))
  if (sampleNow && samples.size) {
    await db
      .insert(metricSamples)
      .values([...samples].map(([metric, value]) => ({ agentId: agent.id, metric, value, createdAt: new Date(now) })))
  }

  const wasSilent = agent.lastSeenAt && now - agent.lastSeenAt.getTime() > agent.reportIntervalSec * 4_000
  const snapshot = storedSnapshot(report)
  await db
    .update(agents)
    .set({
      lastSeenAt: new Date(now),
      reportIntervalSec: report.intervalSec,
      lastSnapshotJson: JSON.stringify({ ...snapshot, receivedAt: now }),
      ...(sampleNow ? { lastSampleAt: new Date(now) } : {}),
    })
    .where(eq(agents.id, agent.id))
  if (!agent.lastSeenAt)
    await logActivity(
      'agent',
      `Агент ${agent.name} прислал первый отчёт (${report.hostname || 'host'})`,
      'system',
      `/infrastructure/${agent.id}`,
    )
  else if (wasSilent) await logActivity('agent', `Агент ${agent.name} снова на связи`, 'system', `/infrastructure/${agent.id}`)

  const inFlight = await db
    .select({ target: commands.target })
    .from(commands)
    .where(and(eq(commands.agentId, agent.id), eq(commands.status, 'claimed')))
    .limit(20)
  const ctx = {
    restarting: new Set(inFlight.map((x) => x.target)),
    agentId: agent.id,
    agentName: agent.name,
    samples,
    // Агент до 1.3 времени замера не шлёт — его бизнес-метрики оцениваются на каждом отчёте, как раньше.
    newBusinessSample: report.businessAt === undefined ? undefined : isNewBusinessSample(agent.lastSnapshotJson, report),
    businessFailed: report.businessFailed ?? [],
    containersKnown: Boolean(report.containers) && !report.dockerError,
    dockerError: report.dockerError ?? null,
    containers: (report.containers ?? []).map((c) => ({
      name: c.name,
      image: c.image,
      mainStack: isMainStack(report, c),
      state: c.state,
      status: c.status,
      health: c.health,
      healthLog: c.healthLog,
      restartPolicy: c.restartPolicy,
      exitCode: c.exitCode ?? null,
      oomKilled: c.oomKilled ?? false,
      restartCount: c.restartCount,
      startedAt: parseStartedAt(c.startedAt)?.getTime() ?? null,
      cpuPct: c.cpuPct ?? null,
      memMb: c.memMb ?? null,
      memLimitMb: c.memLimitMb ?? null,
      oomKills: c.oomKills ?? null,
      memPeakMb: c.memPeakMb ?? null,
      swapPeakMb: c.swapPeakMb ?? null,
      oomVictims: c.oomVictims ?? null,
      composeService: c.composeService,
    })),
  }
  await evaluateHostMetrics(ctx)
  await evaluateContainers(ctx)
  return claimCommands(agent.id)
}
