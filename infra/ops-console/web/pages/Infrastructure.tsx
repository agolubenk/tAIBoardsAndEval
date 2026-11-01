/**
 * Инфраструктура: карточки серверов (нагрузка, контейнеры) и единая таблица объектов — хосты,
 * контейнеры, сервисы, домены — с вкладками по типу, поиском и фильтром состояния (в адресе страницы).
 */
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { hostMetrics, isExpectedExit } from '../lib/host'
import { pct, timeAgo } from '../lib/format'
import type { AgentSummary, Container } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { LinkButton } from '../ui/Controls'
import { Empty, LoadError, Meter, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { ObjectsTable, type ObjectFilters, type ObjectType } from './infra/ObjectsTable'

function HostCards({ agents, ctrs }: { agents: AgentSummary[]; ctrs: Container[] }) {
  return (
    <div className={s.grid3}>
      {agents.map((a) => {
        const hm = hostMetrics(a.snapshot)
        const own = ctrs.filter((c) => c.agentId === a.id)
        const bad = own.filter((c) => (c.state !== 'running' && !isExpectedExit(c)) || c.health === 'unhealthy').length
        return (
          <Link key={a.id} to={`/infrastructure/${a.id}`} className={`${ui.panel} ${s.hostCard}`}>
            <div className={s.hostHead}>
              <div>
                <div className={s.hostName}>{a.name}</div>
                <div className={s.hostMeta}>
                  {a.environment} · {a.snapshot?.osName ?? a.snapshot?.os ?? 'ОС неизвестна'} ·{' '}
                  {a.lastSeenAt ? `отчёт ${timeAgo(a.lastSeenAt)}` : 'ожидает подключения'}
                </div>
              </div>
              <StatusBadge status={a.status} />
            </div>
            <div className={s.hostMetrics}>
              {(
                [
                  ['CPU', hm.cpu],
                  ['RAM', hm.memPct],
                  ['Диск', hm.disk?.pct ?? null],
                ] as const
              ).map(([label, v]) => (
                <div key={label}>
                  <div className={s.metricLabel}>{label}</div>
                  <div className={s.metricValue}>{pct(v, 0)}</div>
                  <Meter value={v} label={`${label} ${a.name}`} />
                </div>
              ))}
            </div>
            <div className={s.hostMeta}>
              Контейнеры: {own.filter((c) => c.state === 'running').length} из {own.length} работают
              {bad ? ` · с проблемами: ${bad}` : ''}
            </div>
          </Link>
        )
      })}
    </div>
  )
}

const TYPES: ReadonlyArray<ObjectType | 'all'> = ['all', 'host', 'container', 'service', 'domain']

export function InfrastructurePage() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const q = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentSummary[]; containers: Container[] }>('/infra/agents'),
    refetchInterval: 15_000,
  })
  const rawType = params.get('type') as ObjectType | 'all' | null
  const filters: ObjectFilters = {
    type: rawType && TYPES.includes(rawType) ? rawType : 'all',
    q: params.get('q') ?? '',
    status: (params.get('status') as ObjectFilters['status'] | null) ?? '',
  }
  const setFilters = (f: ObjectFilters) => {
    const next: Record<string, string> = {}
    if (f.type !== 'all') next.type = f.type
    if (f.q) next.q = f.q
    if (f.status) next.status = f.status
    setParams(next, { replace: true })
  }
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const agents = q.data?.agents
  const ctrs = q.data?.containers ?? []

  return (
    <>
      <PageHero
        eyebrow="Инфраструктура"
        title="Хосты, контейнеры, сервисы и домены"
        lead="Каждый сервер присылает отчёт сам (входящих портов нет), сервисы и домены проверяются снаружи. Команды перезапуска агент забирает следующим отчётом."
        actions={
          can('owner') ? (
            <LinkButton to="/settings?tab=agents" icon="plus">
              Подключить сервер
            </LinkButton>
          ) : null
        }
      />
      {!agents ? (
        <Skeleton height={160} />
      ) : agents.length === 0 ? (
        <Panel>
          <Empty title="Подключите первый сервер" icon="server">
            «Настройки → Агенты» → создать агента → команда установки на сервере. После первого отчёта появятся CPU, память, диски и
            контейнеры.
          </Empty>
        </Panel>
      ) : (
        <HostCards agents={agents} ctrs={ctrs} />
      )}
      <ObjectsTable agents={agents} containers={ctrs} filters={filters} onFilters={setFilters} />
    </>
  )
}
