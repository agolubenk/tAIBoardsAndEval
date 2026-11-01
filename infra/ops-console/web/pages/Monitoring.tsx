import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { pct, timeAgo } from '../lib/format'
import type { Monitor, TlsCert } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button, Tabs } from '../ui/Controls'
import { UptimeBars } from '../ui/Charts'
import { Empty, LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { MonitorDialog } from './MonitorDialog'
import { MonitorDetailPanel } from './monitoring/MonitorDetail'

export const monitorStatus = (m: Monitor) =>
  m.maintenance ? 'maintenance' : !m.enabled ? 'unknown' : m.lastOk === null ? 'pending' : m.lastOk ? 'healthy' : 'critical'
export const monitorLabel = (m: Monitor) =>
  m.maintenance ? 'Техработы' : !m.enabled ? 'Выключен' : m.lastOk === null ? 'Ждёт проверки' : m.lastOk ? 'Доступен' : 'Недоступен'

export const msFmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} с` : `${v} мс`)

type MonTab = 'http' | 'dns' | 'tcp' | 'tls'
const TYPE_HINT: Record<Exclude<MonTab, 'tls'>, string> = {
  http: 'Добавьте, например, https://app.hrhelper.space/api/v1/health/ready с проверкой health-JSON.',
  dns: 'Проверка записи DNS: имя хоста, тип записи и (необязательно) ожидаемое значение.',
  tcp: 'Проверка порта: «хост:порт» — база, Redis, SMTP. Внутренние адреса — только из разрешённых в настройках.',
}

function TlsPanel() {
  const { can } = useSession()
  const q = useQuery({ queryKey: ['tls'], queryFn: () => api.get<{ certificates: TlsCert[] }>('/monitors/tls') })
  const run = useAction(() => api.post<{ domains: number }>('/monitors/tls/check'), {
    success: (r) => `Проверено доменов: ${r.domains}`,
    invalidate: [['tls']],
  })
  return (
    <Panel
      title="TLS-сертификаты"
      hint="Домены из HTTPS-мониторов, проверка раз в 6 часов. Алерт — за 14 и за 3 дня до истечения."
      action={
        can('operator') ? (
          <Button small icon="refresh" busy={run.isPending} onClick={() => run.mutate(undefined)}>
            Проверить сейчас
          </Button>
        ) : null
      }
      flush
    >
      {!q.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={80} />
        </div>
      ) : q.data.certificates.length === 0 ? (
        <Empty title="Сертификаты ещё не проверялись" icon="lock" />
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Домен</th>
                <th>Статус</th>
                <th>Действует до</th>
                <th>Издатель</th>
                <th>Проверен</th>
              </tr>
            </thead>
            <tbody>
              {q.data.certificates.map((c) => (
                <tr key={c.domain}>
                  <td className={ui.cellMain}>{c.domain}</td>
                  <td>
                    {c.error ? (
                      <StatusBadge status="critical" label={c.error} />
                    ) : (
                      <StatusBadge
                        status={c.daysLeft === null ? 'unknown' : c.daysLeft < 3 ? 'critical' : c.daysLeft < 14 ? 'warning' : 'healthy'}
                        label={c.daysLeft === null ? 'нет данных' : `${c.daysLeft} дн.`}
                      />
                    )}
                  </td>
                  <td className={ui.num}>{c.validTo ? new Date(c.validTo).toLocaleDateString('ru-RU') : '—'}</td>
                  <td>{c.issuer || '—'}</td>
                  <td className={ui.num}>{timeAgo(c.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

export function MonitoringPage() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<Monitor | null | undefined>(undefined)
  const raw = params.get('tab')
  const tab: MonTab = raw === 'tls' || raw === 'dns' || raw === 'tcp' ? raw : 'http'
  const selected = Number(params.get('monitor')) || null
  const q = useQuery({ queryKey: ['monitors'], queryFn: () => api.get<{ monitors: Monitor[] }>('/monitors'), refetchInterval: 20_000 })
  const detailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!selected) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    detailRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }, [selected])
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const all = q.data?.monitors
  const monitors = tab === 'tls' ? all : all?.filter((m) => m.type === tab)
  const count = (t: Monitor['type']) => all?.filter((m) => m.type === t).length ?? 0

  return (
    <>
      <PageHero
        eyebrow="Мониторинг"
        title="Доступность снаружи"
        lead="Проверки снаружи — HTTP, DNS, TCP и TLS: два сбоя подряд — критичный алерт и инцидент. Задержка успешных проверок считается отдельно от ошибок. Работают независимо от агента на сервере."
        actions={
          can('operator') ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing(null)}>
              Добавить монитор
            </Button>
          ) : null
        }
      />
      <Tabs
        label="Раздел мониторинга"
        value={tab}
        onChange={(v) => setParams(v === 'http' ? {} : { tab: v })}
        items={[
          { id: 'http', label: `HTTP · ${count('http')}` },
          { id: 'dns', label: `DNS · ${count('dns')}` },
          { id: 'tcp', label: `TCP · ${count('tcp')}` },
          { id: 'tls', label: 'TLS-сертификаты' },
        ]}
      />
      {tab === 'tls' ? (
        <TlsPanel />
      ) : (
        <>
          <Panel title="Мониторы" hint="Нажмите на монитор, чтобы увидеть историю проверок и задержку" flush>
            {!monitors ? (
              <div style={{ padding: 20 }}>
                <Skeleton height={120} />
              </div>
            ) : monitors.length === 0 ? (
              <Empty title="Мониторов нет" icon="pulse">
                {TYPE_HINT[tab]}
              </Empty>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Сервис</th>
                      <th>Статус</th>
                      <th>Доступность 24 ч</th>
                      <th>p50</th>
                      <th>p95</th>
                      <th style={{ minWidth: 180 }}>30 дней</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monitors.map((m) => (
                      <tr
                        key={m.id}
                        aria-selected={selected === m.id}
                        style={selected === m.id ? { background: 'var(--lg-accent-soft)' } : undefined}
                      >
                        <td>
                          <button
                            type="button"
                            className={`${ui.rowLink} ${ui.rowButton}`}
                            onClick={() => setParams({ monitor: String(m.id) })}
                          >
                            {m.name}
                          </button>
                          <span className={ui.cellSub}>
                            {m.type === 'dns' ? `${m.dnsRecord} ${m.url}` : m.url}
                            {m.description ? ` · ${m.description}` : ''}
                          </span>
                        </td>
                        <td>
                          <StatusBadge status={monitorStatus(m)} label={monitorLabel(m)} />
                        </td>
                        <td className={ui.num}>{pct(m.uptime24h, 2)}</td>
                        <td className={ui.num}>{msFmt(m.latency24h?.p50)}</td>
                        <td className={ui.num}>{msFmt(m.latency24h?.p95)}</td>
                        <td>
                          <UptimeBars days={m.uptime30d} label={m.name} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {selected ? (
            <div ref={detailRef} className={s.scrollTarget}>
              <MonitorDetailPanel id={selected} onEdit={(m) => setEditing(m)} />
            </div>
          ) : null}
        </>
      )}
      <MonitorDialog monitor={editing} onClose={() => setEditing(undefined)} />
    </>
  )
}
