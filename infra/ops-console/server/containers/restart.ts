/**
 * Запрос перезапуска контейнера — один путь для консоли (HTTP) и Telegram-бота. Сама консоль докер
 * не трогает: она ставит команду в очередь, агент на хосте забирает её следующим отчётом и выполняет
 * `docker restart` (у агента — свой allowlist и свой cooldown, второй рубеж).
 *
 * Правила (решение владельца 2026-10-06, для бота — 2026-10-11) живут только здесь, вызывающие их не
 * повторяют: перезапускает оператор или владелец; причина обязательна — она уходит в ленту, в
 * инцидент и в отчёт ИИ-совету; stateful — только если введено точное имя контейнера; у контейнера
 * одна команда в очереди; после успешного перезапуска — пауза.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { getDb } from '../db/client'
import { agents, alerts, commands, containers } from '../db/schema'
import { roleAtLeast, type Role } from '../http-types'
import { logActivity } from '../activity'
import { addIncidentEvent } from '../incidents/store'
import { getGeneralSettings } from '../settings/store'

/** Перезапускают оператор и владелец; наблюдатель только смотрит. */
export const RESTART_MIN_ROLE: Role = 'operator'

const reasonSchema = z.string().trim().min(3, 'Причина обязательна — минимум 3 символа').max(300, 'Причина — не длиннее 300 символов')

export type RestartRefusalKind = 'forbidden' | 'reason' | 'not_found' | 'confirm' | 'in_flight' | 'cooldown' | 'failed'

const REFUSAL_STATUS = { forbidden: 403, reason: 400, not_found: 404, confirm: 422, in_flight: 409, cooldown: 429, failed: 500 } as const

/** Отказ в перезапуске: консоли — HTTP-ошибка с текстом для оператора, боту — ещё и вид отказа. */
export class RestartRefusal extends HTTPException {
  constructor(
    readonly kind: RestartRefusalKind,
    message: string,
  ) {
    super(REFUSAL_STATUS[kind], { message })
  }
}

export interface RestartActor {
  email: string
  role: Role
}

/** Откуда запрос. Telegram в ленте и хронологии инцидента — «(из Telegram)», как другие действия из бота. */
export type RestartChannel = 'console' | 'telegram'

export interface RestartRequest {
  agentId: string
  container: string
  reason: string
  confirmName?: string
  /** По умолчанию — консоль. */
  channel?: RestartChannel
}

export interface RestartQueued {
  commandId: number
  agentName: string
  container: string
}

type AgentRow = typeof agents.$inferSelect
type ContainerRow = typeof containers.$inferSelect

export function assertCanRestart(actor: { role: Role }): void {
  if (!roleAtLeast(actor.role, RESTART_MIN_ROLE)) throw new RestartRefusal('forbidden', 'Недостаточно прав: нужна роль оператора')
}

/** Причина без пробелов по краям, 3–300 символов. */
export function parseRestartReason(raw: string): string {
  const parsed = reasonSchema.safeParse(raw)
  if (!parsed.success) throw new RestartRefusal('reason', parsed.error.issues[0]?.message ?? 'Причина обязательна')
  return parsed.data
}

/**
 * Хост включён, контейнер есть в последнем отчёте агента, команды в очереди нет и пауза после
 * прошлого перезапуска прошла. Бот спрашивает это до причины: человек не должен писать её зря.
 */
export async function checkRestartable(agentId: string, name: string): Promise<{ agent: AgentRow; ctr: ContainerRow }> {
  const db = getDb()
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) })
  if (!agent || !agent.enabled) throw new RestartRefusal('not_found', 'Агент не найден или выключен')
  const ctr = await db.query.containers.findFirst({ where: and(eq(containers.agentId, agentId), eq(containers.name, name)) })
  if (!ctr) throw new RestartRefusal('not_found', 'Контейнер не найден в последнем отчёте агента')
  // null — агент до 1.5 (видел только основной проект): решение остаётся за хостом, как раньше.
  if (ctr.restartable === false) {
    const project = ctr.composeProject || 'без проекта'
    throw new RestartRefusal('forbidden', `Хост не перезапускает контейнеры проекта «${project}» (OPS_RESTART_PROJECTS в /etc/hrh-ops-agent.env)`)
  }

  const inFlight = await db.query.commands.findFirst({
    where: and(eq(commands.agentId, agentId), eq(commands.target, name), inArray(commands.status, ['pending', 'claimed'])),
  })
  if (inFlight) throw new RestartRefusal('in_flight', 'Перезапуск этого контейнера уже в очереди')

  const { restartCooldownSec } = await getGeneralSettings()
  const last = await db.query.commands.findFirst({
    where: and(eq(commands.agentId, agentId), eq(commands.target, name), eq(commands.status, 'succeeded')),
    orderBy: desc(commands.finishedAt),
  })
  const sinceLast = last?.finishedAt ? (Date.now() - last.finishedAt.getTime()) / 1000 : Infinity
  if (sinceLast < restartCooldownSec) {
    throw new RestartRefusal(
      'cooldown',
      `Контейнер перезапускали ${Math.round(sinceLast)} с назад — подождите ${Math.ceil(restartCooldownSec - sinceLast)} с`,
    )
  }
  return { agent, ctr }
}

export async function requestRestart(actor: RestartActor, req: RestartRequest): Promise<RestartQueued> {
  assertCanRestart(actor)
  const reason = parseRestartReason(req.reason)
  const { agent, ctr } = await checkRestartable(req.agentId, req.container)
  if (ctr.stateful && req.confirmName !== ctr.name) {
    throw new RestartRefusal('confirm', `Контейнер «${ctr.name}» хранит данные — для перезапуска введите его имя полностью`)
  }

  const db = getDb()
  const [cmd] = await db
    .insert(commands)
    .values({
      agentId: agent.id,
      type: 'restart',
      target: ctr.name,
      reason,
      requestedBy: actor.email,
      requestedAt: new Date(),
    })
    .returning({ id: commands.id })
  if (!cmd) throw new RestartRefusal('failed', 'Не удалось поставить команду')

  // Журнал: кто (actor), когда (время записи), причина и канал.
  const via = req.channel === 'telegram' ? ' (из Telegram)' : ''
  await logActivity('action', `Запрошен перезапуск ${ctr.name} на ${agent.name}${via}: ${reason}`, actor.email, `/infrastructure/${agent.id}`)
  // Если по контейнеру горит алерт в инциденте — действие попадает в его хронологию.
  const related = await db
    .select({ incidentId: alerts.incidentId })
    .from(alerts)
    .where(and(eq(alerts.status, 'firing'), eq(alerts.object, `${ctr.name} · ${agent.name}`)))
    .limit(5)
  const incidentIds = [...new Set(related.map((r) => r.incidentId).filter((id): id is number => id !== null))]
  await Promise.all(incidentIds.map((id) => addIncidentEvent(id, 'action', `Перезапуск ${ctr.name} запрошен${via}: ${reason}`, actor.email)))
  return { commandId: cmd.id, agentName: agent.name, container: ctr.name }
}
