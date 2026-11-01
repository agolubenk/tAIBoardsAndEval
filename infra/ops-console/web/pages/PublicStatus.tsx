import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { duration, fullDateTime, pct } from '../lib/format'
import type { UptimeDay } from '../lib/types'
import { Logo } from '../layout/Shell'
import { StatusBadge } from '../ui/Badge'
import { UptimeBars } from '../ui/Charts'
import { Empty, LoadError, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'

interface PublicIncident {
  severity: 'warning' | 'critical'
  status: string
  startedAt: number
  resolvedAt: number | null
  services: string[]
}

interface PublicStatus {
  title: string
  updatedAt: number
  services: Array<{
    name: string
    description: string
    status: 'up' | 'down' | 'unknown'
    uptime90d: UptimeDay[]
    uptimePct90: number | null
    uptime24h: number | null
  }>
  incidents: PublicIncident[]
  history: PublicIncident[]
}

/** Публичная страница без входа: только мониторы с флагом «публичный», без адресов и деталей. */
export function PublicStatusPage() {
  const q = useQuery({
    queryKey: ['public-status'],
    queryFn: () => api.get<PublicStatus>('/public/status'),
    refetchInterval: 60_000,
    retry: false,
  })
  const d = q.data
  const down = d?.services.filter((x) => x.status === 'down').length ?? 0
  return (
    <div className={s.publicWrap}>
      <div className={s.publicHead}>
        <Logo size={34} />
        <h1 className={ui.title} style={{ margin: 0 }}>
          {d?.title ?? 'Статус сервисов'}
        </h1>
      </div>
      {q.isError ? (
        <LoadError error={q.error} />
      ) : !d ? (
        <Skeleton height={200} />
      ) : (
        <>
          <Panel>
            <div className={ui.row}>
              <StatusBadge
                status={down ? 'critical' : d.incidents.length ? 'warning' : 'healthy'}
                label={down ? `Недоступно сервисов: ${down}` : d.incidents.length ? 'Идёт работа над инцидентом' : 'Все системы работают'}
              />
              <span className={ui.small}>Обновлено {fullDateTime(d.updatedAt)}</span>
            </div>
          </Panel>
          <Panel title="Сервисы · история за 90 дней">
            {d.services.length === 0 ? (
              <Empty title="Публичных сервисов нет" icon="pulse" />
            ) : (
              d.services.map((x) => (
                <div key={x.name} className={s.serviceRow}>
                  <span className={ui.row}>
                    <StatusBadge
                      status={x.status === 'up' ? 'healthy' : x.status === 'down' ? 'critical' : 'unknown'}
                      label={x.status === 'up' ? 'Работает' : x.status === 'down' ? 'Недоступен' : 'Нет данных'}
                    />
                    <span>
                      <span className={s.serviceName}>{x.name}</span>
                      {x.description ? <span className={ui.cellSub}>{x.description}</span> : null}
                    </span>
                  </span>
                  <span className={s.serviceNums}>
                    {pct(x.uptimePct90, 2)} за 90 дней · {pct(x.uptime24h, 2)} за 24 ч
                  </span>
                  <div className={s.serviceBars}>
                    <UptimeBars days={x.uptime90d} label={x.name} />
                  </div>
                </div>
              ))
            )}
          </Panel>
          <Panel title="История инцидентов · 90 дней">
            {d.history.length === 0 ? (
              <Empty title="Инцидентов не было" icon="check">
                За последние 90 дней публичные сервисы работали без сбоев.
              </Empty>
            ) : (
              <ul className={s.feed}>
                {d.history.map((i) => (
                  <li key={i.startedAt} className={s.feedItem} style={{ gridTemplateColumns: '170px minmax(0, 1fr)' }}>
                    <span className={s.feedTime}>{fullDateTime(i.startedAt)}</span>
                    <span>
                      <StatusBadge
                        status={i.resolvedAt ? 'healthy' : i.severity === 'critical' ? 'critical' : 'warning'}
                        label={i.resolvedAt ? `Решён · ${duration(i.startedAt, i.resolvedAt)}` : 'Идёт работа'}
                      />{' '}
                      {i.severity === 'critical' ? 'Сбой' : 'Деградация'}: {i.services.join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
