/**
 * Онбординг (как в прототипе): шаг засчитывается только по факту успешной проверки, а не по
 * сохранённой настройке — монитор ответил, агент прислал отчёт, уведомление дошло, деплой пришёл
 * из GitHub, публичная страница включена и на ней есть сервис.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, deliveries, deploys, monitors, tgSubscriptions } from '../db/schema'
import { getGeneralSettings, readSetting } from '../settings/store'
import { deploySyncSchema } from '../deploys/github'

export interface OnboardingStep {
  id: 'monitor' | 'agent' | 'notify' | 'deploys' | 'status'
  title: string
  done: boolean
  detail: string
  /** Куда идти, чтобы закрыть шаг. */
  to: string
  /**
   * Без этого шага консоль не выполняет главную задачу (заметить сбой и сообщить). Необязательные
   * (деплои, публичная страница) на главной не напоминают — только в настройках.
   */
  required: boolean
}

export async function onboardingSteps(): Promise<OnboardingStep[]> {
  const db = getDb()
  const [mon, agent, delivered, sub, deploy, general, sync, publicMon] = await Promise.all([
    db.query.monitors.findFirst({ where: eq(monitors.lastOk, true), orderBy: desc(monitors.lastCheckedAt) }),
    db.query.agents.findFirst({ where: isNotNull(agents.lastSeenAt), orderBy: desc(agents.lastSeenAt) }),
    db.query.deliveries.findFirst({ where: eq(deliveries.ok, true), orderBy: desc(deliveries.id) }),
    db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.state, 'active') }),
    db.query.deploys.findFirst({ orderBy: desc(deploys.createdAt) }),
    getGeneralSettings(),
    readSetting('deploy_sync', deploySyncSchema),
    db.query.monitors.findFirst({ where: and(eq(monitors.isPublic, true), eq(monitors.enabled, true)) }),
  ])
  const ago = (d: Date | null | undefined) => (d ? `${Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000))} мин назад` : '')
  return [
    {
      id: 'monitor',
      title: 'Внешняя проверка отвечает',
      done: Boolean(mon),
      detail: mon ? `${mon.name}: последняя успешная проверка ${ago(mon.lastCheckedAt)}` : 'Добавьте монитор health-эндпоинта — консоль заметит, даже если сервер лёг целиком',
      to: '/monitoring',
      required: true,
    },
    {
      id: 'agent',
      title: 'Первый агент подключён',
      done: Boolean(agent),
      detail: agent ? `${agent.name}: отчёт ${ago(agent.lastSeenAt)}` : 'Подключите сервер одноразовой командой — появятся CPU, память, диски и контейнеры',
      to: '/settings?tab=agents',
      required: true,
    },
    {
      id: 'notify',
      title: 'Уведомление доставлено',
      done: Boolean(delivered),
      detail: delivered
        ? `${delivered.target}: ${delivered.kind === 'test' ? 'тест' : 'уведомление'} доставлено ${ago(delivered.createdAt)}${sub ? ' · есть личная Telegram-подписка' : ''}`
        : 'Добавьте канал и нажмите «Тест» — статус засчитывается только по реальной доставке',
      to: '/alerts?tab=channels',
      required: true,
    },
    {
      id: 'deploys',
      title: 'Деплои видны',
      done: Boolean(deploy) && sync.ok,
      detail: deploy
        ? `последний: ${deploy.title || deploy.workflow}${sync.ok ? '' : ` · последняя синхронизация с ошибкой: ${sync.error}`}`
        : 'Подключите GitHub Actions — деплои встанут на шкалу рядом с инцидентами',
      to: '/deploys',
      required: false,
    },
    {
      id: 'status',
      title: 'Публичная страница статуса',
      done: general.publicStatusEnabled && Boolean(publicMon),
      detail: general.publicStatusEnabled
        ? publicMon
          ? `включена: ${publicMon.name}${publicMon.description ? ` — ${publicMon.description}` : ''}`
          : 'включена, но нет ни одного публичного сервиса — отметьте монитор «публичный»'
        : 'Выключена — включите в «Общих» и выберите сервисы',
      to: '/settings',
      required: false,
    },
  ]
}
