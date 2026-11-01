import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ActivityDot, activityText } from '../ui/ActivityText'
import { deployStatus } from './Deploys'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { hostMetrics } from '../lib/host'
import { dateTime, duration, pct, timeAgo, timeShort } from '../lib/format'
import type { Alert, Overview, ResourceWindow, UiStatus, WatchedResource } from '../lib/types'
import { CommandBadge, SeverityBadge, StatusBadge } from '../ui/Badge'
import { Button, LinkButton } from '../ui/Controls'
import { UptimeBars } from '../ui/Charts'
import { Empty, LoadError, Meter, PageHero, Panel, Skeleton } from '../ui/Glass'
import { OverviewTiles } from './overview/OverviewTiles'
import { WatchedResources } from './overview/WatchedResources'
import { OnboardingPanel } from './settings/Onboarding'
import { plural } from '../../shared/plural'
import ui from '../ui/styles'
import s from './pages.module.css'

export function overallStatus(o: Overview): UiStatus {
  if (o.alerts.some((a) => a.severity === 'critical')) return 'critical'
  if (o.alerts.length) return 'warning'
  if (!o.monitors.length && !o.agents.length) return 'pending'
  return 'healthy'
}

const HEADLINE: Record<UiStatus, string> = {
  healthy: 'Все системы работают',
  warning: 'Есть предупреждения',
  critical: 'Есть критичные проблемы',
  unknown: 'Нет данных',
  pending: 'Подключите первый сервер',
  maintenance: 'Идут техработы',
}

/** «Обновлено N сек назад» — тикает раз в 5 с. */
function useFreshness(updatedAt: number): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  if (!updatedAt) return 'загрузка…'
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000))
  return sec < 5 ? 'обновлено только что' : sec < 60 ? `обновлено ${sec} с назад` : `обновлено ${timeAgo(updatedAt)}`
}

/** «2 критичных · 3 предупреждения · 1 объект без данных · открыт 1 инцидент». */
function countsLine(o: Overview): string {
  const crit = o.alerts.filter((a) => a.severity === 'critical').length
  const warn = o.alerts.length - crit
  const noData =
    o.agents.filter((a) => a.status === 'unknown').length + o.monitors.filter((m) => m.enabled && m.lastOk === null).length
  const parts = [
    crit ? `${crit} критичных` : '',
    warn ? plural(warn, ['предупреждение', 'предупреждения', 'предупреждений']) : '',
    noData ? `${plural(noData, ['объект', 'объекта', 'объектов'])} без данных` : '',
    o.incidents.length ? (o.incidents.length === 1 ? 'открыт 1 инцидент' : `открыто инцидентов: ${o.incidents.length}`) : '',
    o.maintenance.length ? `🛠 техработы: ${plural(o.maintenance.length, ['окно', 'окна', 'окон'])}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Алертов нет, все объекты отчитываются.'
}

export function OverviewPage() {
  const { can } = useSession()
  const [window, setWindow] = useState<ResourceWindow>('6h')
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 15_000 })
  const res = useQuery({
    queryKey: ['overview-resources', window],
    queryFn: () => api.get<{ resources: WatchedResource[] }>(`/overview/resources?window=${window}`),
    refetchInterval: 60_000,
  })
  const freshness = useFreshness(q.dataUpdatedAt)
  const tick = useAction(() => api.post<{ checks: number; ran: boolean }>('/overview/tick'), {
    success: (r) => (r.ran ? `Проверки выполнены: ${r.checks}` : 'Проверка уже идёт — данные обновятся через несколько секунд'),
    invalidate: [['overview']],
  })
  const ack = useAction((a: Alert) => api.post(`/alerts/${a.id}/ack`), {
    success: 'Взято в работу — повторы по алерту остановлены',
    invalidate: [['overview'], ['alerts']],
  })

  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const o = q.data
  const status = o ? overallStatus(o) : 'unknown'

  return (
    <>
      <PageHero
        eyebrow={`Обзор · ${freshness}`}
        title={o ? HEADLINE[status] : 'Загрузка…'}
        titleAside={o ? <StatusBadge status={status} /> : null}
        lead={o ? countsLine(o) : ' '}
        actions={
          <>
            {can('owner') ? (
              <LinkButton to="/settings?tab=agents" icon="plus">
                Подключить сервер
              </LinkButton>
            ) : null}
            {can('operator') ? (
              <Button icon="refresh" busy={tick.isPending} onClick={() => tick.mutate(undefined)}>
                Проверить сейчас
              </Button>
            ) : null}
          </>
        }
      />

      <OverviewTiles o={o} resources={res.data?.resources} />
      {can('operator') ? <OnboardingPanel compact /> : null}

      <div className={s.split}>
        <Panel
          title="Требует внимания"
          hint="Горящие алерты: сначала критичные"
          action={
            <LinkButton to="/alerts" small>
              Все алерты
            </LinkButton>
          }
        >
          {!o ? (
            <Skeleton height={96} />
          ) : o.alerts.length === 0 ? (
            <Empty title="Активных алертов нет">Правила и каналы — в разделе «Алерты».</Empty>
          ) : (
            <div className={s.attention}>
              {[...o.alerts]
                .sort((a, b) => (a.severity === b.severity ? b.startedAt - a.startedAt : a.severity === 'critical' ? -1 : 1))
                .slice(0, 8)
                .map((a) => (
                  <div key={a.id} className={s.attentionItem}>
                    <SeverityBadge severity={a.severity} />
                    <Link to={a.route || `/alerts?focus=${a.id}`} className={s.attentionLink}>
                      <span className={s.attentionTitle}>{a.title}</span>
                      <span className={s.attentionMeta}>
                        {' '}
                        · {a.object} · {duration(a.startedAt)}
                        {a.acknowledgedBy ? ` · в работе: ${a.acknowledgedBy}` : ''}
                      </span>
                    </Link>
                    <span className={s.attentionValue}>{a.value}</span>
                    {can('operator') && !a.acknowledgedBy ? (
                      <Button small busy={ack.isPending && ack.variables?.id === a.id} onClick={() => ack.mutate(a)}>
                        В работу
                      </Button>
                    ) : null}
                  </div>
                ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Последние изменения"
          action={
            <LinkButton to="/events" small>
              Лента
            </LinkButton>
          }
        >
          {!o ? (
            <Skeleton height={96} />
          ) : o.activity.length === 0 ? (
            <Empty title="Событий пока нет" icon="list" />
          ) : (
            <ul className={s.feed}>
              {o.activity.slice(0, 8).map((e) => (
                <li key={e.id} className={s.feedItem}>
                  <span className={s.feedTime} title={dateTime(e.createdAt)}>
                    {timeShort(e.createdAt)}
                  </span>
                  <span>
                    <ActivityDot message={e.message} />
                    {e.route ? <Link to={e.route}>{activityText(e.message)}</Link> : activityText(e.message)}
                    {e.actor !== 'system' ? <span className={s.feedActor}> · {e.actor}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <WatchedResources window={window} onWindow={setWindow} data={res.data?.resources} />

      <Panel
        title="Состояние сервисов · 30 дней"
        hint="Внешние HTTP-проверки — работают, даже если сервер лёг целиком"
        action={
          <LinkButton to="/monitoring" small>
            Мониторинг
          </LinkButton>
        }
      >
        {!o ? (
          <Skeleton height={120} />
        ) : o.monitors.length === 0 ? (
          <Empty title="Мониторов нет" icon="pulse">
            Добавьте адреса сервисов в разделе «Мониторинг».
          </Empty>
        ) : (
          o.monitors.map((m) => (
            <div key={m.id} className={s.serviceRow}>
              <span className={ui.row}>
                <StatusBadge
                  status={!m.enabled ? 'unknown' : m.lastOk === null ? 'pending' : m.lastOk ? 'healthy' : 'critical'}
                  label={!m.enabled ? 'Выключен' : m.lastOk === null ? 'Ждёт проверки' : m.lastOk ? 'Доступен' : 'Недоступен'}
                />
                <Link to={`/monitoring?monitor=${m.id}`} className={s.serviceName}>
                  {m.name}
                </Link>
              </span>
              <span className={s.serviceNums}>
                {pct(m.uptime24h, 2)} за 24 ч · {m.lastLatencyMs !== null ? `${m.lastLatencyMs} мс` : '—'}
              </span>
              <div className={s.serviceBars}>
                <UptimeBars days={m.uptime30d} label={m.name} />
              </div>
            </div>
          ))
        )}
      </Panel>

      <Panel
        title="Серверы"
        hint="Данные локального контроллера (агента) каждого хоста"
        action={
          <LinkButton to="/infrastructure" small>
            Инфраструктура
          </LinkButton>
        }
      >
        {!o ? (
          <Skeleton height={120} />
        ) : o.agents.length === 0 ? (
          <Empty title="Серверы не подключены" icon="server">
            Владелец добавляет агента в «Настройки → Агенты» и ставит контроллер на сервер по инструкции.
          </Empty>
        ) : (
          <div className={s.grid3}>
            {o.agents.map((a) => {
              const hm = hostMetrics(a.snapshot)
              return (
                <Link key={a.id} to={`/infrastructure/${a.id}`} className={`${ui.panel} ${ui.panelCompact} ${s.hostCard}`}>
                  <div className={s.hostHead}>
                    <div>
                      <div className={s.hostName}>{a.name}</div>
                      <div className={s.hostMeta}>
                        {a.environment} · {a.lastSeenAt ? `отчёт ${timeAgo(a.lastSeenAt)}` : 'ещё не подключался'}
                      </div>
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                  <div className={s.hostMetrics}>
                    {[
                      ['CPU', hm.cpu],
                      ['RAM', hm.memPct],
                      ['Диск', hm.disk?.pct ?? null],
                    ].map(([label, v]) => (
                      <div key={label as string}>
                        <div className={s.metricLabel}>{label}</div>
                        <div className={s.metricValue}>{pct(v as number | null, 0)}</div>
                        <Meter value={v as number | null} label={`${label} ${a.name}`} />
                      </div>
                    ))}
                  </div>
                  <div className={s.hostMeta}>
                    Контейнеры: {a.containers.running} из {a.containers.total} работают
                    {a.containers.unhealthy ? ` · unhealthy: ${a.containers.unhealthy}` : ''}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </Panel>

      <div className={s.grid2}>
        <Panel title="Последние перезапуски">
          {!o?.commands.length ? (
            <Empty title="Перезапусков не было" icon="restart" />
          ) : (
            <ul className={s.feed}>
              {o.commands.map((c) => (
                <li key={c.id} className={s.feedItem}>
                  <span className={s.feedTime} title={dateTime(c.requestedAt)}>
                    {timeShort(c.requestedAt)}
                  </span>
                  <span className={ui.row}>
                    <CommandBadge status={c.status} />
                    <Link to={`/infrastructure/${c.agentId}`}>{c.target}</Link>
                    <span className={s.feedActor}>
                      {c.requestedBy} · {c.reason}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Деплои"
          action={
            <LinkButton to="/deploys" small>
              Все
            </LinkButton>
          }
        >
          {!o?.deploys.length ? (
            <Empty title="Деплоев нет" icon="rocket">
              Подключите GitHub в «Настройки → Интеграции».
            </Empty>
          ) : (
            <ul className={s.feed}>
              {o.deploys.map((d) => (
                <li key={d.id} className={s.feedItem}>
                  <span className={s.feedTime} title={dateTime(d.finishedAt ?? d.createdAt)}>
                    {timeShort(d.finishedAt ?? d.createdAt)}
                  </span>
                  <span className={ui.row}>
                    <StatusBadge status={deployStatus(d)[0]} label={deployStatus(d)[1]} />
                    <a href={d.url} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  )
}
