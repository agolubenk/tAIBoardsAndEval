/**
 * «Ресурсы под наблюдением»: только близкое к порогу, быстро растущее или то, что заполнится в
 * обозримое время (сервер отбирает и сортирует). Окно — 6 ч / 24 ч / 7 дней.
 */
import { Link } from 'react-router-dom'
import type { ResourceWindow, WatchedResource } from '../../lib/types'
import { Tabs } from '../../ui/Controls'
import { Empty, Meter, Panel, Skeleton } from '../../ui/Glass'
import { plural } from '../../../shared/plural'
import s from '../pages.module.css'

const METRIC: Record<WatchedResource['metric'], string> = { cpu_pct: 'CPU', mem_pct: 'Память', disk_pct: 'Диск' }
const WINDOW_LABEL: Record<ResourceWindow, string> = { '6h': '6 часов', '24h': '24 часа', '7d': '7 дней' }
const WINDOW_SHORT: Record<ResourceWindow, string> = { '6h': 'за 6 ч', '24h': 'за сутки', '7d': 'за неделю' }

function forecast(hours: number | null): string | null {
  if (hours === null) return null
  if (hours < 1) return 'заполнится в течение часа'
  if (hours < 48) return `заполнится через ~${plural(Math.round(hours), ['час', 'часа', 'часов'])}`
  const days = Math.round(hours / 24)
  return days > 60 ? null : `заполнится через ~${plural(days, ['день', 'дня', 'дней'])}`
}

function trend(delta: number | null, window: ResourceWindow): string {
  if (delta === null) return 'истории пока мало'
  if (Math.abs(delta) < 2) return `стабильно ${WINDOW_SHORT[window]}`
  return `${delta > 0 ? '+' : '−'}${Math.abs(Math.round(delta * 10) / 10)} п.п. ${WINDOW_SHORT[window]}`
}

/** Мини-график без подписей: форма тренда, не значения. */
function Sparkline({ points, label }: { points: Array<[number, number]>; label: string }) {
  if (points.length < 2) return null
  const t0 = points[0]![0]
  const t1 = points.at(-1)![0]
  const lo = Math.min(...points.map((p) => p[1]))
  const hi = Math.max(...points.map((p) => p[1]))
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 116 + 2
  const y = (v: number) => 26 - ((v - lo) / Math.max(1, hi - lo)) * 22
  const d = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')
  return (
    <svg className={s.sparkline} viewBox="0 0 120 28" role="img" aria-label={`Тренд: ${label}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function WatchedResources({
  window,
  onWindow,
  data,
}: {
  window: ResourceWindow
  onWindow: (w: ResourceWindow) => void
  data: WatchedResource[] | undefined
}) {
  return (
    <Panel
      id="resources"
      title="Ресурсы под наблюдением"
      hint="Только то, что у порога, быстро растёт или заполнится в обозримое время"
      action={
        <Tabs
          label="Окно"
          value={window}
          onChange={onWindow}
          items={(['6h', '24h', '7d'] as const).map((id) => ({ id, label: WINDOW_LABEL[id] }))}
        />
      }
    >
      {!data ? (
        <Skeleton height={96} />
      ) : data.length === 0 ? (
        <Empty title="Ресурсы в норме" icon="gauge">
          Ни CPU, ни память, ни диски не подходят к порогам и не растут.
        </Empty>
      ) : (
        <div className={s.resourceGrid}>
          {data.slice(0, 9).map((r) => {
            const fc = r.metric === 'cpu_pct' ? null : forecast(r.fullInHours)
            return (
              <Link key={`${r.agentId}:${r.metric}`} to={`/infrastructure/${encodeURIComponent(r.agentId)}`} className={s.resource}>
                <span className={s.resourceTop}>
                  <b>
                    {r.host} · {METRIC[r.metric]}
                  </b>
                  <span className={r.level === 'critical' ? s.critical : r.level === 'warning' ? s.warning : undefined}>
                    {Math.round(r.value * 10) / 10}%
                  </span>
                </span>
                <Meter value={r.value} label={`${METRIC[r.metric]} ${r.host}`} />
                <span className={s.resourceSub}>
                  {r.detail}
                  {r.threshold !== null ? ` · порог ${r.threshold}%` : ''}
                </span>
                <span className={s.resourceTrend}>
                  <Sparkline points={r.points} label={`${METRIC[r.metric]} ${r.host}`} />
                  <span>
                    {trend(r.delta, window)}
                    {fc ? <b className={s.warning}> · {fc}</b> : null}
                  </span>
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
