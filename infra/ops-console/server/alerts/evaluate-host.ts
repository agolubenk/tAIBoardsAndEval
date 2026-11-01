/**
 * Оценка правил по отчёту агента: метрики хоста и состояние контейнеров.
 * Вызывается из приёма отчёта (server/agents/ingest.ts) после записи состояния.
 * Каждое наблюдение несёт факты и подсказку (server/alerts/explain.ts) — уведомление
 * должно объяснять причину без захода на сервер.
 */
import { and, desc, eq, gte, like, lt, lte, min, sum } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, metricSamples } from '../db/schema'
import { getRulesByKind, observe, resetStreaks, resolveAlert, type AlertRule, type Fact } from './store'
import { isContainerDown, restartDelta } from './container-state'
import { BUSY_MAX_MS, batchServices, busyHealthy, busyVerdict, isBatchService, type BusyVerdict } from './container-busy'
import { logActivity } from '../activity'
import { bizStreakText } from '../../shared/alert-streak'
import {
  bizSubsystem,
  containerFacts,
  explainExit,
  explainOom,
  explainUnhealthy,
  isMeasuredBizMetric,
  metricHint,
  metricLabel,
  topConsumers,
  type ContainerView,
} from './explain'

export interface HostContext {
  agentId: string
  agentName: string
  samples: Map<string, number>
  /** Новый замер бизнес-метрик — только тогда оцениваются правила biz_*; undefined — агент до 1.3 (каждый отчёт). */
  newBusinessSample?: boolean
  /** Команды BUSINESS_CMDS, упавшие в последнем замере. */
  businessFailed?: string[]
  containers: ContainerView[]
  /** false — docker не ответил: состояние контейнеров неизвестно, их алерты не трогаем. */
  containersKnown: boolean
  dockerError?: string | null
  /** Контейнеры, которые агент сейчас перезапускает по команде оператора: их «упал» — ожидаемый. */
  restarting?: Set<string>
}

const RESTART_WINDOW_MS = 10 * 60_000

const fmt = (metric: string, v: number) => {
  const r = Math.round(v * 10) / 10
  if (metric === 'docker_ok') return v >= 1 ? 'да' : 'нет'
  return metric.endsWith('_pct') ? `${r}%` : metric.endsWith('_mb') ? `${Math.round(v)} МБ` : String(r)
}

// Правила бизнес-метрик считают замеры (раз в 5 минут), остальные — отчёты агента; агент до 1.3 — тоже отчёты.
const streakText = (metric: string, forSamples: number, measured: boolean) =>
  metric.startsWith('biz_') && measured ? bizStreakText(forSamples) : forSamples > 1 ? `, ${forSamples} отчёта подряд` : ''

const appliesTo = (rule: AlertRule, agentId: string) => rule.agentId === null || rule.agentId === agentId

function hostFacts(ctx: HostContext, rule: AlertRule, value: number): Fact[] {
  const metric = rule.metric ?? ''
  const facts: Fact[] = [
    ['Сейчас', fmt(metric, value)],
    [
      'Порог',
      `${rule.op === 'gt' ? '>' : '<'} ${fmt(metric, rule.threshold)}${streakText(metric, rule.forSamples, ctx.newBusinessSample !== undefined)}`,
    ],
  ]
  const by = metric === 'cpu_pct' || metric === 'load1' ? 'cpu' : metric === 'mem_pct' || metric === 'swap_used_mb' ? 'mem' : null
  const top = by && ctx.containersKnown ? topConsumers(ctx.containers, by) : ''
  if (top) facts.push([by === 'cpu' ? 'Больше всех CPU' : 'Больше всех памяти', top])
  if (metric === 'docker_ok' && ctx.dockerError) facts.push(['Ошибка агента', ctx.dockerError])
  if (metric === 'biz_failed' && ctx.businessFailed?.length) facts.push(['Не посчитаны', ctx.businessFailed.join(', ')])
  const mem = ctx.samples.get('mem_pct')
  const cpu = ctx.samples.get('cpu_pct')
  const disk = ctx.samples.get('disk_pct')
  const overall = [
    cpu !== undefined && `CPU ${Math.round(cpu)}%`,
    mem !== undefined && `RAM ${Math.round(mem)}%`,
    disk !== undefined && `диск ${Math.round(disk)}%`,
  ]
    .filter(Boolean)
    .join(' · ')
  if (overall) facts.push(['Сервер', overall])
  return facts
}

export async function evaluateHostMetrics(ctx: HostContext): Promise<void> {
  const rules = (await getRulesByKind('host_metric')).filter((r) => appliesTo(r, ctx.agentId) && r.metric)
  for (const rule of rules) {
    const metric = rule.metric ?? ''
    // Значение бизнес-метрики повторяется в каждом отчёте до следующего замера — считаем только новые замеры.
    // Метрики P0 у агента без времени замера (до 1.3) не оцениваются вовсе: их пороги заданы в замерах.
    if (metric.startsWith('biz_') && ctx.newBusinessSample === false) continue
    if (ctx.newBusinessSample === undefined && isMeasuredBizMetric(metric)) continue
    const value = ctx.samples.get(metric)
    if (value === undefined) {
      // Бизнес-метрики нет в новом замере (команда упала — об этом правило biz_failed): серия «подряд» прервана.
      // Остальные метрики хоста и агенты до 1.3 — как раньше: пропуск без сброса.
      if (metric.startsWith('biz_') && ctx.newBusinessSample) await resetStreaks(`rule:${rule.id}:${ctx.agentId}`)
      continue
    }
    const breached = rule.op === 'gt' ? value > rule.threshold : value < rule.threshold
    await observe({
      rule,
      fingerprint: `rule:${rule.id}:${ctx.agentId}`,
      breached,
      title: rule.name,
      // Подсистема впереди, как у контейнеров («backend · vps»): инциденты собираются по объекту.
      object: bizSubsystem(metric) ? `${bizSubsystem(metric)} · ${ctx.agentName}` : ctx.agentName,
      value: `${metricLabel(metric)}: ${fmt(metric, value)}`,
      facts: hostFacts(ctx, rule, value),
      hint: metricHint(metric),
      route: `/infrastructure/${encodeURIComponent(ctx.agentId)}`,
      recovery: `${metricLabel(metric)} сейчас ${fmt(metric, value)}`,
    })
  }
}

export async function restartDeltaFor(agentId: string, name: string, current: number): Promise<number> {
  const db = getDb()
  const metric = `restarts:${name}`
  const windowStart = new Date(Date.now() - RESTART_WINDOW_MS)
  const [before] = await db
    .select({ value: metricSamples.value })
    .from(metricSamples)
    .where(and(eq(metricSamples.agentId, agentId), eq(metricSamples.metric, metric), lte(metricSamples.createdAt, windowStart)))
    .orderBy(desc(metricSamples.createdAt))
    .limit(1)
  const [inWindow] = await db
    .select({ value: min(metricSamples.value) })
    .from(metricSamples)
    .where(and(eq(metricSamples.agentId, agentId), eq(metricSamples.metric, metric), gte(metricSamples.createdAt, windowStart)))
  return restartDelta(current, before?.value ?? null, inWindow?.value ?? null)
}

/**
 * Метрики с префиксом «oomnew:», «restarts:» — диапазоном, а не LIKE: LIKE в SQLite индекс (agent_id, metric, …) по
 * префиксу не использует и читает все строки агента за 30 дней хранения (сотни тысяч на каждый отчёт).
 */
export function metricPrefix(prefix: string) {
  const next = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  return and(gte(metricSamples.metric, prefix), lt(metricSamples.metric, next))
}

/** Сколько процессов ядро убило за окно у каждого контейнера агента — сумма приростов oomnew:<имя>, один запрос. */
async function oomKilledInWindow(agentId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ metric: metricSamples.metric, killed: sum(metricSamples.value) })
    .from(metricSamples)
    .where(
      and(
        eq(metricSamples.agentId, agentId),
        metricPrefix('oomnew:'),
        gte(metricSamples.createdAt, new Date(Date.now() - RESTART_WINDOW_MS)),
      ),
    )
    .groupBy(metricSamples.metric)
  return new Map(rows.map((r) => [r.metric.slice('oomnew:'.length), Number(r.killed ?? 0)]))
}

const healthyLine = (c: ContainerView) => `${c.state}${c.health !== 'none' ? ` · ${c.health}` : ''}`

export async function evaluateContainers(ctx: HostContext): Promise<void> {
  if (!ctx.containersKnown) return
  const [downRules, unhealthyRules, restartRules, oomRules] = await Promise.all([
    getRulesByKind('container_down'),
    getRulesByKind('container_unhealthy'),
    getRulesByKind('container_restarts'),
    getRulesByKind('container_oom'),
  ])
  const route = `/infrastructure/${encodeURIComponent(ctx.agentId)}`
  const now = Date.now()
  const oomKilled = oomRules.length ? await oomKilledInWindow(ctx.agentId) : new Map<string, number>()
  for (const c of ctx.containers) {
    const object = `${c.name} · ${ctx.agentName}`
    const planned = ctx.restarting?.has(c.name) ?? false
    const facts = containerFacts(c, now)
    for (const rule of planned ? [] : downRules.filter((r) => appliesTo(r, ctx.agentId))) {
      await observe({
        rule,
        fingerprint: `rule:${rule.id}:${ctx.agentId}:${c.name}`,
        breached: isContainerDown(c),
        title: rule.name,
        object,
        value: c.state === 'restarting' ? 'в цикле перезапуска' : `${c.state}${c.exitCode !== null ? ` (код ${c.exitCode})` : ''}`,
        facts,
        hint: explainExit(c),
        route,
        recovery: `снова ${healthyLine(c)}`,
      })
    }
    // health=starting — healthcheck ещё не отработал после старта: ни «сломан», ни «починился».
    // Без этого рестарт закрывал бы unhealthy-алерт и тут же открывал новый (два инцидента вместо одного).
    const healthUnknown = planned || c.health === 'starting'
    for (const rule of healthUnknown ? [] : unhealthyRules.filter((r) => appliesTo(r, ctx.agentId))) {
      const fingerprint = `rule:${rule.id}:${ctx.agentId}:${c.name}`
      const unhealthy = c.health === 'unhealthy'
      const busy = await busyFor(rule, fingerprint, c, now, object, route)
      await observe({
        // Соседний стек — предупреждение: виден в ленте и Telegram, но инцидента по продукту не открывает.
        rule: c.mainStack === false && rule.severity === 'critical' ? { ...rule, severity: 'warning' } : rule,
        fingerprint,
        breached: unhealthy && !busy.quiet,
        title: rule.name,
        object,
        // Пик CPU эпизода, а не последний замер: CPU мог упасть секунды назад, а «занят» рядом с 0 % сбивает с толку.
        value: busy.tooLong
          ? `занят дольше ${BUSY_MAX_MS / 60_000} мин без ответа healthcheck (CPU до ${busy.maxCpu}%)`
          : c.healthLog ? `unhealthy: ${c.healthLog}` : 'unhealthy',
        facts,
        hint: busy.tooLong
          ? `Сервис ${busy.minutes} мин не отвечает на healthcheck при работающем CPU — возможно, зациклился. ` +
            `Перезапуск прервёт текущую задачу. ${explainUnhealthy(c)}`
          : explainUnhealthy(c),
        route,
        // Алерт горел (не отвечал при низком CPU), теперь контейнер снова считает: что он не висел, это не доказывает.
        recovery: unhealthy
          ? `контейнер снова занят (CPU ${(c.cpuPct ?? 0).toFixed(0)}%) — тревога снята; до этого он не отвечал при низком CPU, проверьте, что задача идёт`
          : 'healthcheck снова проходит',
      })
    }
    const applicableRestart = restartRules.filter((r) => appliesTo(r, ctx.agentId))
    if (applicableRestart.length) {
      const delta = await restartDeltaFor(ctx.agentId, c.name, c.restartCount)
      for (const rule of applicableRestart) {
        await observe({
          rule,
          fingerprint: `rule:${rule.id}:${ctx.agentId}:${c.name}`,
          breached: delta >= rule.threshold,
          title: rule.name,
          object,
          value: `${delta} перезапусков демоном за 10 мин (порог ${rule.threshold})`,
          facts,
          hint: `Контейнер падает и поднимается снова — это не лечится перезапуском. ${explainExit(c)}`,
          route,
          recovery: `за 10 мин перезапусков: ${delta}`,
        })
      }
    }
    // Оценивается и без итога в текущем отчёте (контейнер остановлен, агент старше 1.4): иначе горящий алерт
    // не закрылся бы никогда.
    const applicableOom = oomRules.filter((r) => appliesTo(r, ctx.agentId))
    if (applicableOom.length) {
      const killed = oomKilled.get(c.name) ?? 0
      for (const rule of applicableOom) {
        await observe({
          rule,
          fingerprint: `rule:${rule.id}:${ctx.agentId}:${c.name}`,
          breached: killed >= rule.threshold,
          title: rule.name,
          object,
          value: `ядро убило ${killed} за 10 мин по нехватке памяти`,
          facts,
          hint: explainOom(c),
          route,
          recovery: 'за 10 мин новых убитых процессов нет',
        })
      }
    }
  }
  await resolveVanished(ctx)
}

/**
 * Занят ≠ завис (container-busy.ts) — только для пакетных сервисов из списка правила: unhealthy при работающем CPU —
 * тихая отметка в ленте, без алерта, не дольше BUSY_MAX_MS. Здоровый замер закрывает эпизод итоговой отметкой
 * (сколько был занят и пик CPU) — по ним пересматривается порог (истории CPU контейнеров консоль не хранит).
 */
async function busyFor(rule: AlertRule, fingerprint: string, c: ContainerView, now: number, object: string, route: string): Promise<BusyVerdict> {
  const none: BusyVerdict = { quiet: false, tooLong: false, started: false, minutes: 0, maxCpu: 0 }
  if (!(rule.threshold > 0) || !isBatchService(c, batchServices(rule.metric))) return none
  if (c.health === 'healthy') {
    // Эпизод закрывается, когда здоровье устоялось (BUSY_SETTLE_MS): отметка 🟢 приходит с этой задержкой.
    const ended = await busyHealthy(fingerprint, now)
    if (ended) {
      await logActivity(
        'alert',
        `🟢 ${object} (${serviceOf(c)}): healthcheck снова отвечает — был занят ${ended.minutes} мин, CPU до ${ended.maxCpu}%`,
        'system',
        route,
      )
    }
    return none
  }
  if (c.health !== 'unhealthy') return none
  const verdict = await busyVerdict(fingerprint, c.cpuPct, rule.threshold, now)
  if (verdict.started) {
    await logActivity(
      'alert',
      `🟡 ${object} (${serviceOf(c)}): healthcheck не отвечает, но контейнер занят (CPU ${(c.cpuPct ?? 0).toFixed(0)}%) — это не зависание, алерта нет`,
      'system',
      route,
    )
  }
  return verdict
}

/**
 * Сервис в тихой отметке: по отметкам 🟢 видно, какой сервис и сколько не отвечал под нагрузкой. У whisper образ
 * speaches, но compose-сервис — `whisper` (infra/docker/docker-compose.yml): в списке правила — имена compose-сервисов.
 */
const serviceOf = (c: ContainerView) => c.composeService || c.name

/** Контейнер удалён (docker rm / пересоздан с другим именем) — его алерты закрываются. */
async function resolveVanished(ctx: HostContext): Promise<void> {
  const names = new Set(ctx.containers.map((c) => c.name))
  const firing = await getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.status, 'firing'), like(alerts.fingerprint, `rule:%:${ctx.agentId}:%`)))
    .limit(100)
  for (const a of firing) {
    const name = a.fingerprint.split(':').slice(3).join(':')
    if (name && !names.has(name)) await resolveAlert(a, 'контейнер больше не существует')
  }
}
