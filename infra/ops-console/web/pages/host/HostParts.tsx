/** Части страницы хоста: графики метрик, карточки ресурсов, таблица контейнеров, подключение агента. */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { groupByProject, hostMetrics, isExpectedExit, projectLabel } from '../../lib/host'
import { bytesPerSec, duration, mb, pct } from '../../lib/format'
import type { AgentSummary, Container } from '../../lib/types'
import { ContainerStateBadge, HealthBadge } from '../../ui/Badge'
import { Button } from '../../ui/Controls'
import { TimeSeriesChart } from '../../ui/Charts'
import { Empty, Meter, Panel, Skeleton } from '../../ui/Glass'
import { Icon } from '../../ui/Icon'
import ui from '../../ui/styles'
import s from '../pages.module.css'

export type Range = '1' | '6' | '24' | '168'

export function MetricChart({
  agentId,
  metric,
  hours,
  label,
  format,
  yMax,
  threshold,
}: {
  agentId: string
  metric: string
  hours: Range
  label: string
  format: (v: number) => string
  yMax?: number
  threshold?: number
}) {
  const q = useQuery({
    queryKey: ['series', agentId, metric, hours],
    queryFn: () =>
      api.get<{ points: Array<[number, number]> }>(`/infra/agents/${encodeURIComponent(agentId)}/series?metric=${metric}&hours=${hours}`),
    refetchInterval: 60_000,
  })
  return (
    <Panel title={label} compact>
      {q.data ? (
        <TimeSeriesChart points={q.data.points} label={label} format={format} yMax={yMax} threshold={threshold} />
      ) : (
        <Skeleton height={150} />
      )}
    </Panel>
  )
}

/** Самый заполненный по инодам раздел (агент ≥ 1.2); null — агент старше или не Linux. */
function worstInode(snap: AgentSummary['snapshot']): number | null {
  const v = (snap?.disks ?? []).map((d) => d.inodePct).filter((x): x is number => typeof x === 'number')
  return v.length ? Math.max(...v) : null
}

export function ResourceCards({ agent }: { agent: AgentSummary }) {
  const snap = agent.snapshot
  const hm = hostMetrics(snap)
  const cards = [
    {
      label: 'CPU',
      value: pct(hm.cpu, 0),
      meter: hm.cpu,
      sub: snap?.cpu ? `load ${snap.cpu.load1 ?? '—'} · ${snap.cpu.cores ?? '?'} ядер` : '—',
    },
    {
      label: 'Память',
      value: pct(hm.memPct, 0),
      meter: hm.memPct,
      sub: snap?.memory
        ? `${mb(snap.memory.usedMb)} из ${mb(snap.memory.totalMb)}${snap.memory.swapTotalMb ? ` · swap ${mb(snap.memory.swapUsedMb ?? 0)}` : ''}`
        : '—',
    },
    {
      label: `Диск ${hm.disk?.mount ?? ''}`,
      value: pct(hm.disk?.pct ?? null, 0),
      meter: hm.disk?.pct ?? null,
      sub: hm.disk
        ? `свободно ${hm.disk.freeGb.toFixed(1)} ГБ${typeof worstInode(snap) === 'number' ? ` · иноды ${pct(worstInode(snap), 0)}` : ''}`
        : '—',
    },
    {
      label: 'Сеть',
      value: snap?.network ? `${bytesPerSec(snap.network.rxBytesPerSec)} ↓` : '—',
      meter: null,
      sub: snap?.network
        ? `${bytesPerSec(snap.network.txBytesPerSec)} ↑${typeof snap.network.errors === 'number' ? ` · ошибок ${snap.network.errors}` : ''}`
        : 'нет данных (не Linux?)',
    },
  ]
  return (
    <div className={s.grid4}>
      {cards.map((c) => (
        <div key={c.label} className={`${ui.panel} ${ui.panelCompact} ${s.resourceCard}`}>
          <span className={s.metricLabel}>{c.label}</span>
          <span className={s.metricValue}>{c.value}</span>
          {c.meter !== null ? <Meter value={c.meter} label={c.label} /> : null}
          <span className={s.hostMeta}>{c.sub}</span>
        </div>
      ))}
    </div>
  )
}

export function ContainersTable({
  containers,
  canRestart,
  pending,
  onRestart,
  focus,
  restarts10m = {},
}: {
  containers: Container[]
  /** Перезапусков за 10 минут (restart loop) — по имени контейнера. */
  restarts10m?: Record<string, number>
  canRestart: boolean
  pending: Set<string>
  onRestart: (c: Container) => void
  /** Контейнер из ссылки поиска (#c-<имя>): прокрутить к нему и подсветить. */
  focus: string | null
}) {
  const found = Boolean(focus && containers.some((c) => c.name === focus))
  useEffect(() => {
    if (!found || !focus) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`c-${focus}`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [found, focus])
  if (!containers.length)
    return (
      <Empty title="Контейнеров нет" icon="box">
        Агент не видит docker или все контейнеры скрыты маской OPS_CONTAINER_EXCLUDE.
      </Empty>
    )
  const groups = groupByProject(containers)
  const columns = canRestart ? 8 : 7
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Контейнер</th>
            <th>Состояние</th>
            <th>Health</th>
            <th>Аптайм</th>
            <th>Рестарты</th>
            <th>CPU</th>
            <th>RAM / лимит</th>
            {canRestart ? <th aria-label="Действия" /> : null}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((g) => [
            groups.length > 1 ? (
              <tr key={`project:${g.project}`}>
                <th colSpan={columns} scope="colgroup" style={{ textAlign: 'left' }}>
                  {g.main ? `Стек продукта · ${g.project}` : `Проект ${projectLabel({ composeProject: g.project })}`} ·{' '}
                  {g.containers.length}
                </th>
              </tr>
            ) : null,
            ...g.containers.map((c) => (
              <tr
                key={c.name}
                id={`c-${c.name}`}
                aria-current={c.name === focus ? 'true' : undefined}
                style={c.name === focus ? { background: 'var(--lg-accent-soft)' } : undefined}
              >
                <td>
                  <span className={ui.cellMain}>{c.name}</span>{' '}
                  {c.stateful ? (
                    <span className={ui.chip} title="Хранит данные — перезапуск только с вводом имени">
                      <Icon name="database" size={12} /> данные
                    </span>
                  ) : null}
                  <span className={ui.cellSub}>{c.image}</span>
                </td>
                <td>
                  <ContainerStateBadge state={c.state} expectedExit={isExpectedExit(c)} />
                  {c.state === 'exited' && c.exitCode !== null && !isExpectedExit(c) ? (
                    <span className={ui.cellSub}>код {c.exitCode}</span>
                  ) : null}
                </td>
                <td>
                  <HealthBadge health={c.health} />
                </td>
                <td className={ui.num}>{c.state === 'running' && c.startedAt ? duration(c.startedAt) : '—'}</td>
                <td className={ui.num}>
                  {restarts10m[c.name] ? (
                    <b className={s.critical} title="Перезапусков за последние 10 минут">
                      {restarts10m[c.name]} / 10 мин
                    </b>
                  ) : (
                    c.restartCount
                  )}
                  {restarts10m[c.name] ? <span className={ui.cellSub}>всего {c.restartCount}</span> : null}
                </td>
                <td className={ui.num}>{c.cpuPct !== null ? `${c.cpuPct.toFixed(1)}%` : '—'}</td>
                <td className={ui.num}>
                  {mb(c.memMb)}
                  {c.memLimitMb ? ` / ${mb(c.memLimitMb)}` : ''}
                  {c.memLimitMb && c.memMb !== null ? <Meter value={(c.memMb / c.memLimitMb) * 100} label={`RAM ${c.name}`} /> : null}
                  {c.memPeakMb != null ? <span className={ui.cellSub}>пик {mb(c.memPeakMb)}</span> : null}
                  {c.swapPeakMb ? <span className={ui.cellSub}>swap {mb(c.swapPeakMb)}</span> : null}
                  {c.oomKills ? (
                    <b className={s.critical} title="Процессов, убитых ядром по нехватке памяти, всего у контейнера (по журналу ядра)">
                      OOM: {c.oomKills}
                    </b>
                  ) : null}
                </td>
                {canRestart ? (
                  <td>
                    <div className={s.actionsCell}>
                      {c.restartable === false ? (
                        <span
                          className={ui.cellSub}
                          title="Маски OPS_RESTART_PROJECTS / OPS_RESTART_ALLOW / OPS_RESTART_DENY в /etc/hrh-ops-agent.env хоста"
                        >
                          хост не перезапускает
                        </span>
                      ) : (
                        <Button small icon="restart" disabled={pending.has(c.name)} onClick={() => onRestart(c)}>
                          {pending.has(c.name) ? 'В очереди…' : 'Перезапустить'}
                        </Button>
                      )}
                    </div>
                  </td>
                ) : null}
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  )
}

/** Как подключить сервер, пока консоль работает локально (через обратный SSH-туннель). */
export function ConnectSteps({ agentId }: { agentId: string }) {
  const local = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  return (
    <Panel title="Как подключить сервер" hint="Нужен SSH с sudo на сервере. Секрет агента уже лежит в data/ рядом с консолью (права 600).">
      <div className={ui.stack}>
        {local ? (
          <>
            <span className={ui.small}>1. Установить агента (один раз), из каталога infra/ops-console:</span>
            <pre className={ui.pre}>scripts/connect-agent.sh install &lt;пользователь&gt;@&lt;сервер&gt; {agentId}</pre>
            <span className={ui.small}>2. Держать туннель, пока консоль работает на этом компьютере (сервер не видит localhost):</span>
            <pre className={ui.pre}>scripts/connect-agent.sh tunnel &lt;пользователь&gt;@&lt;сервер&gt;</pre>
          </>
        ) : (
          <span className={ui.small}>
            На сервере: agent/install.sh, затем в /etc/hrh-ops-agent.env — OPS_CONSOLE_URL={window.location.origin}, OPS_AGENT_ID={agentId}{' '}
            и секрет из «Настройки → Агенты».
          </span>
        )}
        <span className={ui.small}>
          Первый отчёт придёт в течение 15 секунд. Если нет — на сервере: <code>journalctl -u hrh-ops-agent -n 50</code>.
        </span>
      </div>
    </Panel>
  )
}

/** Имя контейнера из `#c-<имя>`: битый процент в ссылке (`#c-%`) — не падение страницы, а просто без подсветки. */
export function decodeHashName(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}
