/**
 * Алерты по событиям деплоя (OPS-DEPLOY-VIS, фаза 2). Источник — события contabo-deploy.sh (./progress.ts):
 * - «Деплой упал» — по deploy_done с кодом ≠ 0: сразу и с упавшей фазой и проверками;
 * - «Откат по rollback-prev недоступен» — тот же deploy_done: сменившим образ сервисам не поставился rollback-prev;
 * - «Деплой идёт слишком долго» — на каждом тике по живой карточке;
 * - контекст для «Сайт недоступен»: идёт деплой (окно 502 при подъёме стека) или он только что закончился
 *   зелёным, а сайт лёг (false-green). Только факт и подсказка, без подавления.
 *
 * Доверие: события подписаны учёткой агента, а агентов может быть несколько. Поэтому у алертов из событий свой
 * fingerprint на агента — их поднимает и закрывает только он, следующим своим деплоем. Алерт опроса GitHub
 * (./github.ts) события не подавляют и не закрывают: при провале приходят оба уведомления — сразу от события
 * (фазы, проверки) и после опроса (упавший шаг, ссылка); в консоли они в одном инциденте — объект общий.
 * Контекст для мониторов — только когда запуск GitHub это подтверждает.
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, deployProgress } from '../db/schema'
import { getRulesByKind, observe, type AlertRule, type Fact } from '../alerts/store'
import { getGithubSettings } from '../settings/store'
import { humanDuration } from '../lib/time'
import { DEPLOY_CHECK_LABEL, DEPLOY_PHASE_LABEL, type DeployCard, type DeployCardCheck } from '../../shared/deploy-events-contract'
import { deployCardFor, latestDeployRow } from './progress'

type ProgressRow = typeof deployProgress.$inferSelect

/** Объект алертов деплоя — свой: critical упавшего деплоя не должен попасть в инцидент хоста или подсистемы. */
export const deployObject = (workflow: string) => `Деплой · ${workflow}`
/** Алерт опроса GitHub: правило и workflow. */
export const deployFailedFingerprint = (ruleId: number, workflow: string) => `rule:${ruleId}:deploy:${workflow}`
/** Алерты из событий деплоя: правило, вид и агент, приславший событие. */
export const deployEventFingerprint = (ruleId: number, what: 'failed' | 'rollback' | 'slow', agentId: string) =>
  `rule:${ruleId}:deploy-${what}:${agentId}`

/** Сбой «Сайт недоступен» в это окно после зелёного деплоя — вероятная регрессия выкаченной версии. */
export const AFTER_DEPLOY_WINDOW_MS = 30 * 60_000
/** Карточки старше суток консоль не принимает (progress.ts) — за ними долгий деплой не ищем. */
const SLOW_LOOKBACK_MS = 86_400_000
/** Код выхода при отмене задачи (SIGINT, SIGTERM): прод мог остаться обновлённым наполовину. */
const INTERRUPTED_RC = new Set([130, 143])
const ROLLBACK = 'откат — Actions → deploy-contabo → Run workflow, ref = прежний коммит'

const phaseName = (key: string) => DEPLOY_PHASE_LABEL[key] ?? key
const checkName = (c: Pick<DeployCardCheck, 'key' | 'url'>) => (c.key && DEPLOY_CHECK_LABEL[c.key] ? `${DEPLOY_CHECK_LABEL[c.key]} — ${c.url}` : c.url)
const commitText = (card: DeployCard) => (card.run?.title ? `${card.sha.slice(0, 7)} «${card.run.title}»` : card.sha.slice(0, 7))
const runLinks = (card: DeployCard): Fact[] => (card.run?.url ? [['Запуск в GitHub', card.run.url]] : [])

export interface DeployFailure {
  /** null — заголовок правила («Деплой упал»). */
  title: string | null
  value: string
  hint: string
  facts: Fact[]
}

/** Что сломалось — по сводке итогового события: упавшие фазы и проверки, код выхода. */
export function describeFailure(card: DeployCard): DeployFailure {
  const phases = card.phases.filter((p) => p.status === 'failed')
  const checks = card.checks.filter((c) => c.status === 'failed')
  const facts: Fact[] = []
  if (phases.length) facts.push(['Упала фаза', phases.map((p) => `${phaseName(p.key)}${p.rc !== null ? ` (код ${p.rc})` : ''}`).join('; ')])
  if (checks.length) facts.push(['Не прошли проверки', checks.map(checkName).join('; ')])
  const failed = new Set(phases.map((p) => p.key))
  const code = card.rc !== null ? ` (код ${card.rc})` : ''
  if (card.rc !== null && INTERRUPTED_RC.has(card.rc)) {
    return {
      title: 'Деплой прерван',
      value: `задачу остановили${code}`,
      hint: 'Деплой остановлен посреди работы — часть сервисов могла уже обновиться. Проверьте сайт и состояние стека (contabo-compose.sh ps), затем новый push или Run workflow.',
      facts,
    }
  }
  const first = checks[0]
  if (first?.key === 'site_config' && checks.length === 1 && failed.size <= 1) {
    return {
      title: 'Проверка после деплоя не прошла',
      value: 'site-config.js без доменов разделения',
      hint: 'Новая версия выкачена и отвечает, но в /site-config.js нет доменов — разделение доменов выключено. Причина — в логах frontend, строка «40-site-config» (contabo-compose.sh logs frontend).',
      facts,
    }
  }
  if (first || failed.has('checks')) {
    return {
      title: 'Проверка после деплоя не прошла',
      value: first ? `не отвечает: ${checkName(first)}` : 'не прошла проверка по публичному адресу',
      hint: `Новая версия выкачена, но проверка снаружи не прошла. Откройте адрес: если не работает — ${ROLLBACK}.`,
      facts,
    }
  }
  if (failed.has('nginx')) {
    return {
      title: null,
      value: `конфиги nginx не применены${code}`,
      hint: 'Новая версия выкачена, а новая конфигурация nginx не применилась — прод работает на прежней. Разбор — вывод contabo-nginx-apply.sh в логе запуска.',
      facts,
    }
  }
  if (failed.has('build')) {
    return {
      title: null,
      value: `упала сборка, миграции или подъём стека${code}`,
      hint: `Упал rebuild-prod-stack.sh: часть сервисов могла уже обновиться. Проверьте сайт и contabo-compose.sh ps, лог — в запуске GitHub. Прод сломан — ${ROLLBACK}.`,
      facts,
    }
  }
  if (failed.has('preflight') || failed.has('prepare')) {
    return {
      title: null,
      value: `до выката не дошло${code}`,
      hint: 'До выката дело не дошло — прод на предыдущей версии. Лог — в запуске GitHub; после исправления — новый push или Run workflow.',
      facts,
    }
  }
  return {
    title: null,
    value: `деплой завершился ошибкой${code}`,
    hint: 'Откройте лог запуска в GitHub и найдите упавший шаг; проверьте сайт.',
    facts,
  }
}

/** Итог деплоя (deploy_done): «Деплой упал» и «rollback-prev» — сразу, не дожидаясь опроса GitHub. */
export async function observeDeployFinish(row: ProgressRow, now = Date.now()): Promise<void> {
  if (row.status === 'running') return
  const [failedRules, rollbackRules, gh] = await Promise.all([
    getRulesByKind('deploy_failed'),
    getRulesByKind('deploy_rollback_prev'),
    getGithubSettings(),
  ])
  if (!failedRules.length && !rollbackRules.length) return
  const card = await deployCardFor(row, now)
  const object = deployObject(gh.workflow)
  const links = runLinks(card)
  const why = card.status === 'failed' ? describeFailure(card) : null
  const facts: Fact[] = [
    ['Коммит', commitText(card)],
    ...(card.rc !== null && why ? ([['Код выхода', String(card.rc)]] as Fact[]) : []),
    ...(why?.facts ?? []),
    ['Длительность', humanDuration(card.durationMs)],
    ['Сервер', card.agentName],
  ]
  for (const rule of failedRules) {
    await observe({
      rule,
      fingerprint: deployEventFingerprint(rule.id, 'failed', row.agentId),
      breached: why !== null,
      title: why?.title ?? rule.name,
      object,
      value: why?.value ?? `успешно за ${humanDuration(card.durationMs)}`,
      facts,
      ...(why ? { hint: why.hint } : {}),
      links,
      route: '/deploys',
      recovery: `следующий деплой успешен: ${commitText(card)}`,
    })
  }
  const rb = card.rollback
  // Фаза rollback-prev не дошла (деплой упал раньше) — о закреплении ничего не известно: алерт не трогаем.
  if (!rb) return
  for (const rule of rollbackRules) {
    await observe({
      rule,
      fingerprint: deployEventFingerprint(rule.id, 'rollback', row.agentId),
      breached: rb.failed > 0,
      title: rule.name,
      object,
      value: `${rb.failed} из ${rb.changed} сменивших образ — без rollback-prev`,
      facts: [
        ['Коммит', commitText(card)],
        ['Сменили образ', String(rb.changed)],
        ['Без rollback-prev', String(rb.failed)],
        ['Сервер', card.agentName],
      ],
      hint: `Этим сервисам быстрый откат на прежний образ недоступен — только пересборкой прежнего коммита (${ROLLBACK}). Какие сервисы — строки «rollback-prev не поставлен» в логе запуска. Обычно образа работавшего контейнера уже нет в хранилище; со следующей сменой сервиса rollback-prev встанет сам.`,
      links,
      route: '/deploys',
      recovery: `rollback-prev поставлен всем сменившим образ сервисам: ${commitText(card)}`,
    })
  }
}

/** Приём события deploy_done: алерты — после записи итога; их сбой не отказывает агенту в уже принятом событии. */
export async function observeDeployDone(agentId: string, deployId: string, now = Date.now()): Promise<void> {
  try {
    const row = await getDb().query.deployProgress.findFirst({
      where: and(eq(deployProgress.agentId, agentId), eq(deployProgress.deployId, deployId)),
    })
    if (row) await observeDeployFinish(row, now)
  } catch (err) {
    console.warn('[ops] deploy alerts failed:', err instanceof Error ? err.message : String(err))
  }
}

const SLOW_HINT =
  'Обычно деплой идёт 15–45 минут. Сборка молчит до конца фазы (между build_start и build_done событий нет) — смотрите лог запуска в GitHub. Потолок задачи — 120 минут: дольше GitHub её снимет, и деплой станет красным.'

function slowRecovery(card: DeployCard): string {
  if (card.status === 'success') return `деплой завершён за ${humanDuration(card.durationMs)}`
  if (card.status === 'failed') return `деплой завершился ошибкой за ${humanDuration(card.durationMs)}`
  if (card.status === 'stale') return 'событий от деплоя больше нет — прервался'
  return 'деплой идёт в пределах порога'
}

async function observeSlow(rule: AlertRule, card: DeployCard, workflow: string, now: number): Promise<void> {
  const limitMin = Math.max(1, rule.threshold)
  const phase = card.phases.find((p) => p.status === 'running')
  await observe({
    rule,
    fingerprint: deployEventFingerprint(rule.id, 'slow', card.agentId),
    breached: card.status === 'running' && card.durationMs > limitMin * 60_000,
    title: rule.name,
    object: deployObject(workflow),
    value: `идёт ${humanDuration(card.durationMs)}, порог ${limitMin} мин`,
    facts: [
      ['Коммит', commitText(card)],
      ['Идёт', humanDuration(card.durationMs)],
      ...(phase ? ([['Фаза', `${phaseName(phase.key)}${phase.durationMs !== null ? `, ${humanDuration(phase.durationMs)}` : ''}`]] as Fact[]) : []),
      ['Последнее событие', `${humanDuration(Math.max(0, now - card.lastEventAt))} назад`],
      ['Сервер', card.agentName],
    ],
    hint: SLOW_HINT,
    links: runLinks(card),
    route: '/deploys',
    recovery: slowRecovery(card),
  })
}

/**
 * Деплой идёт дольше порога правила (минуты) — на каждом тике, по последней карточке каждого агента: чужая карточка
 * не закрывает и не подменяет алерт другого агента. Кончился или прервался — алерт закрывается.
 */
export async function evaluateDeploySlow(now = Date.now()): Promise<void> {
  const rules = await getRulesByKind('deploy_slow')
  if (!rules.length) return
  const db = getDb()
  const [rows, gh] = await Promise.all([
    db.query.deployProgress.findMany({
      where: gte(deployProgress.startedAt, new Date(now - SLOW_LOOKBACK_MS)),
      orderBy: [desc(deployProgress.startedAt), desc(deployProgress.id)],
      limit: 50,
    }),
    getGithubSettings(),
  ])
  const latest = new Map<string, ProgressRow>()
  for (const r of rows) if (!latest.has(r.agentId)) latest.set(r.agentId, r)
  const cards = await Promise.all([...latest.values()].map((r) => deployCardFor(r, now)))
  for (const rule of rules) {
    const seen = new Set<string>()
    for (const card of cards) {
      seen.add(deployEventFingerprint(rule.id, 'slow', card.agentId))
      await observeSlow(rule, card, gh.workflow, now)
    }
    // Карточки агента больше нет (ретенция, удалён агент) — его горящий алерт закрываем, а не держим вечно.
    const firing = await db.query.alerts.findMany({ where: and(eq(alerts.ruleId, rule.id), eq(alerts.status, 'firing')), limit: 20 })
    for (const a of firing.filter((x) => !seen.has(x.fingerprint))) {
      await observe({ rule, fingerprint: a.fingerprint, breached: false, title: rule.name, object: a.object, recovery: 'карточки деплоя больше нет' })
    }
  }
}

/**
 * Контекст для «Сайт недоступен»: идёт деплой (при подъёме стека около 3 минут 502) или он закончился зелёным
 * меньше AFTER_DEPLOY_WINDOW_MS назад — тогда сбой, скорее всего, внесла выкаченная версия. Только когда запуск
 * GitHub этого деплоя согласен (идёт / успешен): одних данных агента для подсказки «это деплой» мало.
 */
export async function deployContext(now = Date.now()): Promise<{ fact: Fact; hint: string } | null> {
  const row = await latestDeployRow()
  if (!row || row.status === 'failed') return null
  const card = await deployCardFor(row, now)
  if (!card.run) return null
  const sha = row.sha.slice(0, 7)
  if (card.status === 'running' && card.run.status !== 'completed') {
    return {
      fact: ['Идёт деплой', `${sha}, ${humanDuration(card.durationMs)}`],
      hint: 'Идёт деплой: при подъёме стека сайт около 3 минут отвечает 502 — это ожидаемо. Сбой дольше 5 минут после конца деплоя — уже не окно деплоя.',
    }
  }
  const finished = row.finishedAt?.getTime()
  if (card.status === 'success' && card.run.conclusion === 'success' && finished !== undefined && now - finished <= AFTER_DEPLOY_WINDOW_MS) {
    return {
      fact: ['После деплоя', `${sha}, ${humanDuration(Math.max(0, now - finished))} назад`],
      hint: `Сбой начался вскоре после зелёного деплоя: проверки деплоя прошли, а сайт потом перестал отвечать — вероятна регрессия выкаченной версии. Сравните с прежним коммитом; ${ROLLBACK}.`,
    }
  }
  return null
}
