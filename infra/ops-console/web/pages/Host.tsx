/**
 * Страница хоста: шапка (окружение, ОС, ресурсы, свежесть агента, «Настроить алерты», «Техработы»)
 * и вкладки — обзор, контейнеры, метрики, алерты, события.
 */
import { useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { bytesPerSec, compact, duration, fullDateTime, timeAgo, timeShort, uptimeSec } from '../lib/format'
import type { Alert, AgentSummary, Command, Container } from '../lib/types'
import { CommandBadge, SeverityBadge, StatusBadge } from '../ui/Badge'
import { Button, LinkButton, Tabs } from '../ui/Controls'
import { Empty, LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { RestartDialog } from './RestartDialog'
import { ConnectSteps, ContainersTable, decodeHashName, MetricChart, ResourceCards, type Range } from './host/HostParts'
import { VpnPanel } from './host/VpnPanel'
import { MaintenanceDialog } from './maintenance/MaintenanceDialog'
import { EventFilterBar, EventsFeed, type EventFilters } from './EventsFeed'

interface HostResponse {
  agent: AgentSummary
  containers: Container[]
  alerts: Alert[]
  commands: Command[]
  restartCooldownSec: number
  restarts10m: Record<string, number>
}

const RANGES: Array<{ id: Range; label: string }> = [
  { id: '1', label: '1 ч' },
  { id: '6', label: '6 ч' },
  { id: '24', label: '24 ч' },
  { id: '168', label: '7 дней' },
]

type HostTab = 'overview' | 'containers' | 'metrics' | 'alerts' | 'events'

/** «Ubuntu 24.04 · 4 vCPU · 16 ГБ RAM». */
function specLine(agent: AgentSummary): string {
  const snap = agent.snapshot
  const ram = snap?.memory?.totalMb ? `${Math.round(snap.memory.totalMb / 1024)} ГБ RAM` : ''
  return [snap?.osName || snap?.os || '', snap?.cpu?.cores ? `${snap.cpu.cores} vCPU` : '', ram].filter(Boolean).join(' · ')
}

function FiringPanel({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null
  return (
    <Panel title="Горит на этом сервере">
      <div className={s.attention}>
        {alerts.map((a) => (
          <Link key={a.id} to={`/alerts?focus=${a.id}`} className={s.attentionItem}>
            <SeverityBadge severity={a.severity} />
            <span>
              <span className={s.attentionTitle}>{a.title}</span>
              <span className={s.attentionMeta}>
                {' '}
                · {a.object} · {duration(a.startedAt)}
              </span>
            </span>
            <span className={s.attentionValue}>{a.value}</span>
          </Link>
        ))}
      </div>
    </Panel>
  )
}

function RestartsPanel({ commands }: { commands: Command[] }) {
  return (
    <Panel title="Перезапуски на этом сервере">
      {commands.length === 0 ? (
        <Empty title="Перезапусков не было" icon="restart" />
      ) : (
        <ul className={s.feed}>
          {commands.map((c) => (
            <li key={c.id} className={s.feedItem}>
              <span className={s.feedTime} title={fullDateTime(c.requestedAt)}>
                {timeShort(c.requestedAt)}
              </span>
              <span>
                <span className={ui.row}>
                  <CommandBadge status={c.status} />
                  <strong>{c.target}</strong>
                  <span className={s.feedActor}>{c.requestedBy}</span>
                </span>
                <span className={s.feedActor}>
                  {c.reason}
                  {c.output ? ` → ${c.output}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TrafficPanel({ agent }: { agent: AgentSummary }) {
  const nginx = agent.snapshot?.nginx
  const business = Object.entries(agent.snapshot?.business ?? {})
  return (
    <Panel title="Трафик и бизнес-метрики" hint="Запросы через nginx за последнюю минуту (все домены сервера) и числа из команд агента">
      {nginx ? (
        <dl className={ui.kv}>
          <dt>Запросов / мин</dt>
          <dd>{nginx.requestsPerMin}</dd>
          <dt>4xx / мин</dt>
          <dd>{nginx.errors4xxPerMin}</dd>
          <dt>5xx / мин</dt>
          <dd className={nginx.errors5xxPerMin ? s.danger : undefined}>{nginx.errors5xxPerMin}</dd>
          {nginx.topPaths.slice(0, 5).map(([path, n]) => (
            <span key={path} style={{ display: 'contents' }}>
              <dt className={s.code}>{path}</dt>
              <dd>{n}</dd>
            </span>
          ))}
        </dl>
      ) : (
        <p className={ui.muted}>
          Агент не видит лог nginx. nginx в Docker агент находит сам — сервис <code>nginx</code> в проекте <code>OPS_COMPOSE_PROJECT</code> или имя в{' '}
          <code>NGINX_CONTAINER</code>; nginx на самом сервере — путь в <code>NGINX_ACCESS_LOG</code>. Всё — в <code>/etc/hrh-ops-agent.env</code>.
        </p>
      )}
      <hr className={ui.divider} />
      {business.length ? (
        <dl className={ui.kv}>
          {business.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{compact(v)}</dd>
            </span>
          ))}
        </dl>
      ) : (
        <p className={ui.muted}>
          Бизнес-метрик нет: их задаёт администратор сервера в <code>BUSINESS_CMDS</code> (<code>/etc/hrh-ops-agent.env</code>) — команды, печатающие одно
          число: размер базы, число компаний, очередь задач. Агент запускает их раз в 5 минут.
        </p>
      )}
    </Panel>
  )
}

function Metrics({ agentId, hasNginx, hasVpn }: { agentId: string; hasNginx: boolean; hasVpn: boolean }) {
  const [range, setRange] = useState<Range>('6')
  return (
    <>
      <div className={s.toolbar}>
        <h2 className={ui.panelTitle}>Метрики</h2>
        <Tabs label="Период" value={range} onChange={setRange} items={RANGES} />
      </div>
      <div className={s.grid2}>
        <MetricChart agentId={agentId} metric="cpu_pct" hours={range} label="CPU, %" format={(v) => `${Math.round(v)}%`} yMax={100} />
        <MetricChart agentId={agentId} metric="mem_pct" hours={range} label="Память, %" format={(v) => `${Math.round(v)}%`} yMax={100} />
        <MetricChart agentId={agentId} metric="disk_pct" hours={range} label="Диск (самый заполненный), %" format={(v) => `${Math.round(v)}%`} yMax={100} />
        {hasNginx ? (
          <MetricChart agentId={agentId} metric="nginx_rpm" hours={range} label="nginx: запросов в минуту" format={(v) => compact(v)} />
        ) : (
          <MetricChart agentId={agentId} metric="load1" hours={range} label="Load average (1 мин)" format={(v) => v.toFixed(1)} />
        )}
        {hasVpn ? (
          <>
            <MetricChart agentId={agentId} metric="vpn_tx_bps" hours={range} label="VPN: к клиентам" format={bytesPerSec} />
            <MetricChart agentId={agentId} metric="vpn_rx_bps" hours={range} label="VPN: от клиентов" format={bytesPerSec} />
          </>
        ) : null}
      </div>
    </>
  )
}

function HostAlerts({ agentId }: { agentId: string }) {
  const q = useQuery({
    queryKey: ['alerts', 'host', agentId],
    queryFn: () => api.get<{ alerts: Alert[] }>(`/alerts?status=all&days=30&agent=${encodeURIComponent(agentId)}`),
  })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  return (
    <Panel title="Алерты за 30 дней" flush>
      {!q.data ? (
        <Skeleton height={120} />
      ) : q.data.alerts.length === 0 ? (
        <Empty title="Алертов не было" icon="bell" />
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Алерт</th>
                <th>Важность</th>
                <th>Начало</th>
                <th>Длительность</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {q.data.alerts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link className={ui.rowLink} to={`/alerts?focus=${a.id}`}>
                      {a.title}
                    </Link>
                    <span className={ui.cellSub}>{a.object}</span>
                  </td>
                  <td>
                    <SeverityBadge severity={a.severity} />
                  </td>
                  <td className={ui.num}>{fullDateTime(a.startedAt)}</td>
                  <td className={ui.num}>{duration(a.startedAt, a.resolvedAt ?? Date.now())}</td>
                  <td>{a.status === 'firing' ? <StatusBadge status="critical" label="Горит" /> : a.resolution || 'восстановлен'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

export function HostPage() {
  const { id = '' } = useParams()
  const { hash } = useLocation()
  const [params, setParams] = useSearchParams()
  const focusContainer = hash.startsWith('#c-') ? decodeHashName(hash.slice(3)) : null
  const { can } = useSession()
  const [target, setTarget] = useState<Container | null>(null)
  const [maint, setMaint] = useState(false)
  const [events, setEvents] = useState<EventFilters>({ kind: '', hours: '168', q: '' })
  const tab = (params.get('tab') as HostTab | null) ?? (focusContainer ? 'containers' : 'overview')
  const q = useQuery({
    queryKey: ['host', id],
    queryFn: () => api.get<HostResponse>(`/infra/agents/${encodeURIComponent(id)}`),
    // Пока есть команды в работе — опрос чаще, чтобы увидеть результат перезапуска.
    refetchInterval: (query) => (query.state.data?.commands.some((c) => c.status === 'pending' || c.status === 'claimed') ? 3_000 : 15_000),
  })
  const endMaint = useAction((wid: number) => api.post(`/maintenance/${wid}/end`), {
    success: 'Техработы завершены — алерты снова поднимаются',
    invalidate: [['host', id], ['maintenance'], ['overview']],
  })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <Skeleton height={300} />

  const { agent, containers, alerts, commands, restarts10m } = q.data
  const snap = agent.snapshot
  const pending = new Set(commands.filter((c) => c.status === 'pending' || c.status === 'claimed').map((c) => c.target))
  const loops = Object.values(restarts10m ?? {}).filter(Boolean).length
  const containersTable = (
    <ContainersTable
      containers={containers}
      restarts10m={restarts10m}
      canRestart={can('operator')}
      pending={pending}
      onRestart={setTarget}
      focus={focusContainer}
    />
  )

  return (
    <>
      <p className={ui.small}>
        <Link to="/infrastructure">Инфраструктура</Link> <span className={ui.faint}>/ Хосты / {agent.name}</span>
      </p>
      <PageHero
        eyebrow={[agent.environment, specLine(agent), `агент ${snap?.agentVersion ?? '—'}`].filter(Boolean).join(' · ')}
        title={agent.name}
        titleAside={<StatusBadge status={agent.status} />}
        lead={
          agent.lastSeenAt
            ? `${snap?.hostname ?? ''} · аптайм ${uptimeSec(snap?.uptimeSec)} · ${
                agent.status === 'unknown' ? 'агент молчит: последний отчёт' : 'агент на связи, отчёт'
              } ${timeAgo(agent.lastSeenAt)} (каждые ${agent.reportIntervalSec} с)`
            : 'Агент ещё ни разу не прислал отчёт — он не установлен на сервере или не достаёт до консоли.'
        }
        actions={
          <>
            <LinkButton to={`/alerts?tab=rules&agent=${encodeURIComponent(agent.id)}`} icon="bell">
              Настроить алерты
            </LinkButton>
            {can('operator') ? (
              agent.maintenance ? (
                <Button icon="wrench" busy={endMaint.isPending} onClick={() => endMaint.mutate(agent.maintenance!.id)}>
                  Завершить техработы
                </Button>
              ) : (
                <Button icon="wrench" onClick={() => setMaint(true)}>
                  Техработы
                </Button>
              )
            ) : null}
          </>
        }
      />

      {agent.maintenance ? (
        <div className={s.maintBanner} role="status">
          🛠 Идут техработы до {fullDateTime(agent.maintenance.endsAt)} — {agent.maintenance.reason} ({agent.maintenance.createdBy}). Алерты по
          серверу не поднимаются.
        </div>
      ) : null}
      {!agent.lastSeenAt ? <ConnectSteps agentId={agent.id} /> : null}
      {snap?.dockerError ? (
        <div className={ui.formError} role="alert">
          Docker недоступен агенту: {snap.dockerError}. Состояние контейнеров не обновляется, их алерты заморожены.
        </div>
      ) : null}

      <Tabs
        label="Раздел хоста"
        value={tab}
        onChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
        items={[
          { id: 'overview', label: 'Обзор' },
          { id: 'containers', label: `Контейнеры ${containers.length}${loops ? ` · ⚠ ${loops}` : ''}` },
          { id: 'metrics', label: 'Метрики' },
          { id: 'alerts', label: alerts.length ? `Алерты · ${alerts.length}` : 'Алерты' },
          { id: 'events', label: 'События' },
        ]}
      />

      {tab === 'overview' ? (
        <>
          <ResourceCards agent={agent} />
          <FiringPanel alerts={alerts} />
          <Panel title="Контейнеры" hint="Перезапуск — через очередь команд: контроллер выполнит его при следующем отчёте" flush>
            {containersTable}
          </Panel>
          <div className={s.grid2}>
            <RestartsPanel commands={commands} />
            <TrafficPanel agent={agent} />
          </div>
          <VpnPanel agent={agent} />
        </>
      ) : null}
      {tab === 'containers' ? (
        <Panel title="Контейнеры" hint="Перезапуск — через очередь команд: контроллер выполнит его при следующем отчёте" flush>
          {containersTable}
        </Panel>
      ) : null}
      {tab === 'metrics' ? <Metrics agentId={id} hasNginx={Boolean(snap?.nginx)} hasVpn={Boolean(snap?.vpn)} /> : null}
      {tab === 'alerts' ? (
        <>
          <FiringPanel alerts={alerts} />
          <HostAlerts agentId={id} />
        </>
      ) : null}
      {tab === 'events' ? (
        <>
          <EventFilterBar value={events} onChange={setEvents} exportRoute={`/infrastructure/${encodeURIComponent(id)}`} />
          <EventsFeed filters={events} route={`/infrastructure/${encodeURIComponent(id)}`} />
        </>
      ) : null}

      <RestartDialog agentId={id} container={target} onClose={() => setTarget(null)} />
      <MaintenanceDialog scope="agent" target={agent.id} name={agent.name} open={maint} onClose={() => setMaint(false)} />
    </>
  )
}
