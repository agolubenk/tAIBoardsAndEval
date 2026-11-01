/**
 * Единая таблица объектов: хосты, контейнеры, внешние сервисы (проверки), домены (TLS: мониторы и nginx хостов) — тип,
 * состояние, нагрузка, связанные горящие алерты, свежесть. Вкладки по типу, поиск по имени,
 * адресу и окружению, фильтр по состоянию. Всё собирается на клиенте из уже существующих API.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { hostMetrics, isExpectedExit, projectLabel } from '../../lib/host'
import { mergeDomains, type DomainView } from '../../lib/domains'
import { mb, pct, timeAgo } from '../../lib/format'
import type { AgentDomain, AgentSummary, Alert, Container, Monitor, TlsCert, UiStatus } from '../../lib/types'
import { StatusBadge } from '../../ui/Badge'
import { Input, Select, Tabs } from '../../ui/Controls'
import { Icon, type IconName } from '../../ui/Icon'
import { Empty, Panel, Skeleton } from '../../ui/Glass'
import { DomainsNote } from './DomainsNote'
import ui from '../../ui/styles'
import s from '../pages.module.css'

export type ObjectType = 'host' | 'container' | 'service' | 'domain'

/** Больше строк браузер слабого телефона рисует заметно дольше; остальное — через поиск и вкладки. */
const ROW_LIMIT = 300

const TYPE_LABEL: Record<ObjectType, string> = { host: 'Хост', container: 'Контейнер', service: 'Сервис', domain: 'Домен' }
const TYPE_ICON: Record<ObjectType, IconName> = { host: 'server', container: 'box', service: 'globe', domain: 'shield' }

interface Row {
  key: string
  type: ObjectType
  name: string
  sub: string
  status: UiStatus
  load: string
  issues: Alert[]
  updatedAt: number | null
  to: string
  search: string
}

function containerStatus(c: Container): UiStatus {
  if (c.health === 'unhealthy' || c.state === 'restarting') return 'critical'
  if (c.state === 'running') return c.health === 'starting' ? 'warning' : 'healthy'
  return isExpectedExit(c) ? 'unknown' : 'critical'
}

function domainRow(v: DomainView): Row {
  const host = v.hosts[0]
  const where = [
    v.external ? 'внешняя проверка' : '',
    ...v.hosts.slice(0, 2).map((h) => `nginx ${h.source}${h.stale ? ' (не перечитан)' : ''} · ${h.agentName}`),
    v.hosts.length > 2 ? `ещё ${v.hosts.length - 2}` : '',
  ].filter(Boolean)
  return {
    key: `d:${v.domain}`,
    type: 'domain',
    name: v.domain,
    sub: [v.issuer, ...where].filter(Boolean).join(' · ') || 'TLS',
    status: v.status,
    load: v.problem ?? (v.daysLeft !== null ? `TLS ${v.daysLeft} дн.` : v.tls ? '—' : 'без TLS'),
    issues: v.issues,
    updatedAt: v.checkedAt,
    to: v.external || !host ? '/monitoring?tab=tls' : `/infrastructure/${encodeURIComponent(host.agentId)}`,
    search: `${v.domain} ${v.issuer} ${where.join(' ')}`.toLowerCase(),
  }
}

export function buildRows(
  agents: AgentSummary[],
  ctrs: Container[],
  monitors: Monitor[],
  certs: TlsCert[],
  firing: Alert[],
  hosted: AgentDomain[] = [],
): Row[] {
  const byRoute = (route: string) => firing.filter((a) => a.route === route || a.route.startsWith(`${route}?`))
  const rows: Row[] = []
  const agentName = new Map(agents.map((a) => [a.id, a.name]))
  for (const a of agents) {
    const hm = hostMetrics(a.snapshot)
    const route = `/infrastructure/${encodeURIComponent(a.id)}`
    rows.push({
      key: `h:${a.id}`,
      type: 'host',
      name: a.name,
      sub: [a.snapshot?.hostname, a.environment].filter(Boolean).join(' · '),
      status: a.status,
      load: hm.cpu === null ? '—' : `CPU ${pct(hm.cpu, 0)} · RAM ${pct(hm.memPct, 0)}${hm.disk ? ` · диск ${pct(hm.disk.pct, 0)}` : ''}`,
      issues: byRoute(route).filter((x) => !x.object.includes(' · ')),
      updatedAt: a.lastSeenAt,
      to: route,
      search: `${a.name} ${a.id} ${a.snapshot?.hostname ?? ''} ${a.environment}`.toLowerCase(),
    })
  }
  for (const c of ctrs) {
    const host = agentName.get(c.agentId) ?? c.agentId
    const route = `/infrastructure/${encodeURIComponent(c.agentId)}`
    rows.push({
      key: `c:${c.agentId}:${c.name}`,
      type: 'container',
      name: c.name,
      sub: `${host} · ${projectLabel(c)} · ${c.image}`,
      status: containerStatus(c),
      load: c.memMb === null ? '—' : `${mb(c.memMb)}${c.memLimitMb ? ` / ${mb(c.memLimitMb)}` : ''}${c.cpuPct !== null ? ` · CPU ${c.cpuPct.toFixed(0)}%` : ''}`,
      issues: byRoute(route).filter((x) => x.object.startsWith(`${c.name} · `)),
      updatedAt: c.updatedAt,
      to: `${route}?tab=containers#c-${encodeURIComponent(c.name)}`,
      search: `${c.name} ${c.image} ${host} ${c.composeService} ${projectLabel(c)}`.toLowerCase(),
    })
  }
  for (const m of monitors) {
    const route = `/monitoring?monitor=${m.id}`
    rows.push({
      key: `m:${m.id}`,
      type: 'service',
      name: m.name,
      sub: `${m.type.toUpperCase()} · ${m.url}`,
      status: m.maintenance ? 'maintenance' : !m.enabled ? 'unknown' : m.lastOk === null ? 'pending' : m.lastOk ? 'healthy' : 'critical',
      load: m.latency24h?.p95 ? `p95 ${m.latency24h.p95} мс · ${pct(m.uptime24h, 2)}` : m.lastLatencyMs !== null ? `${m.lastLatencyMs} мс` : '—',
      issues: byRoute(route),
      updatedAt: m.lastCheckedAt,
      to: route,
      search: `${m.name} ${m.url} ${m.tags}`.toLowerCase(),
    })
  }
  for (const v of mergeDomains(certs, hosted, firing)) rows.push(domainRow(v))
  const rank: Record<UiStatus, number> = { critical: 0, warning: 1, unknown: 2, pending: 3, maintenance: 4, healthy: 5 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name))
}

export interface ObjectFilters {
  type: ObjectType | 'all'
  q: string
  status: '' | 'problem' | UiStatus
}

export function ObjectsTable({
  agents,
  containers,
  filters,
  onFilters,
}: {
  agents: AgentSummary[] | undefined
  containers: Container[]
  filters: ObjectFilters
  onFilters: (f: ObjectFilters) => void
}) {
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => api.get<{ monitors: Monitor[] }>('/monitors'), refetchInterval: 30_000 })
  const certs = useQuery({ queryKey: ['tls'], queryFn: () => api.get<{ certificates: TlsCert[] }>('/monitors/tls') })
  const hosted = useQuery({ queryKey: ['infra', 'domains'], queryFn: () => api.get<{ domains: AgentDomain[] }>('/infra/domains') })
  const firing = useQuery({ queryKey: ['alerts', 'active'], queryFn: () => api.get<{ alerts: Alert[] }>('/alerts?status=firing'), refetchInterval: 15_000 })
  const rows = useMemo(
    () =>
      buildRows(agents ?? [], containers, monitors.data?.monitors ?? [], certs.data?.certificates ?? [], firing.data?.alerts ?? [], hosted.data?.domains ?? []),
    [agents, containers, monitors.data, certs.data, firing.data, hosted.data],
  )
  const q = filters.q.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (filters.type === 'all' || r.type === filters.type) &&
      (!q || r.search.includes(q)) &&
      (!filters.status || (filters.status === 'problem' ? r.status === 'critical' || r.status === 'warning' : r.status === filters.status)),
  )
  const count = (t: ObjectType) => rows.filter((r) => r.type === t).length
  return (
    <>
      <Tabs
        label="Тип объектов"
        value={filters.type}
        onChange={(type) => onFilters({ ...filters, type })}
        items={[
          { id: 'all', label: `Все объекты · ${rows.length}` },
          { id: 'host', label: `Хосты · ${count('host')}` },
          { id: 'container', label: `Контейнеры · ${count('container')}` },
          { id: 'service', label: `Сервисы · ${count('service')}` },
          { id: 'domain', label: `Домены · ${count('domain')}` },
        ]}
      />
      <div className={s.filterBar}>
        <Input
          type="search"
          aria-label="Поиск объектов"
          placeholder="Поиск по имени, адресу, образу, проекту или окружению"
          value={filters.q}
          onChange={(e) => onFilters({ ...filters, q: e.target.value })}
        />
        <Select aria-label="Состояние" value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value as ObjectFilters['status'] })}>
          <option value="">Все состояния</option>
          <option value="problem">Требуют внимания</option>
          <option value="critical">Критично</option>
          <option value="warning">Внимание</option>
          <option value="healthy">В норме</option>
          <option value="maintenance">Техработы</option>
          <option value="unknown">Нет данных</option>
        </Select>
      </div>
      {filters.type === 'domain' ? <DomainsNote agents={agents ?? []} certs={certs.data?.certificates ?? []} hosted={hosted.data?.domains ?? []} /> : null}
      <Panel flush>
        {!agents ? (
          <div style={{ padding: 20 }}>
            <Skeleton height={160} />
          </div>
        ) : shown.length === 0 ? (
          <Empty title="Ничего не найдено" icon="search">
            {rows.length ? 'Ослабьте фильтры или очистите поиск.' : 'Объектов пока нет — подключите сервер или добавьте проверку.'}
          </Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Объект</th>
                  <th>Тип</th>
                  <th>Состояние</th>
                  <th>Нагрузка</th>
                  <th>Связанные проблемы</th>
                  <th>Обновлено</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, ROW_LIMIT).map((r) => (
                  <tr key={r.key}>
                    <td>
                      <span className={s.objectCell}>
                        <span className={s.objectIcon}>
                          <Icon name={TYPE_ICON[r.type]} size={15} />
                        </span>
                        <span>
                          <Link className={ui.rowLink} to={r.to}>
                            {r.name}
                          </Link>
                          <span className={ui.cellSub}>{r.sub}</span>
                        </span>
                      </span>
                    </td>
                    <td>{TYPE_LABEL[r.type]}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className={ui.num}>{r.load}</td>
                    <td>
                      {r.issues.length ? (
                        <Link to={`/alerts?focus=${r.issues[0]!.id}`} className={s.critical}>
                          {r.issues.length === 1 ? r.issues[0]!.title : `${r.issues.length} алерта · ${r.issues[0]!.title}`}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={ui.num}>{r.updatedAt ? timeAgo(r.updatedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > ROW_LIMIT ? (
              <p className={ui.cellSub} style={{ padding: '10px 16px' }}>
                Показаны первые {ROW_LIMIT} из {shown.length} (проблемные — всегда сверху) — сузьте поиск или выберите тип объектов.
              </p>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  )
}
