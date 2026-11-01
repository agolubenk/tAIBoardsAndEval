/**
 * Графики консоли (SVG без библиотек). Один ряд — без легенды: ряд называет заголовок панели.
 * Перекрестие ищет ближайшую точку по X; значение — в подсказке и в таблице под графиком.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UptimeDay } from '../lib/types'
import s from './charts.module.css'

type Point = [number, number]

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const norm = raw / mag
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry?.contentRect.width ?? 0)))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const timeLabel = (t: number, long: boolean) =>
  new Date(t).toLocaleString('ru-RU', long ? { day: '2-digit', month: '2-digit' } : { hour: '2-digit', minute: '2-digit' })

export function TimeSeriesChart({
  points,
  label,
  format,
  height = 150,
  yMax,
  threshold,
  markers,
  emptyText = 'Недостаточно точек — данные появятся после пары отчётов агента',
}: {
  points: Point[]
  label: string
  format: (v: number) => string
  height?: number
  yMax?: number
  threshold?: number
  /** Вертикальные метки событий (сбои проверки): время и подпись для подсказки. */
  markers?: Array<{ t: number; label: string }>
  emptyText?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const m = { l: 44, r: 10, t: 10, b: 22 }
  const geo = useMemo(() => {
    if (points.length < 2 || width < 80) return null
    const t0 = points[0]![0]
    const t1 = points[points.length - 1]![0]
    const values = points.map((p) => p[1])
    const top = yMax ?? Math.max(...values, threshold ?? 0) * 1.1
    const step = niceStep(top || 1, 4)
    const yTop = Math.max(step, Math.ceil((top || 1) / step) * step)
    const iw = width - m.l - m.r
    const ih = height - m.t - m.b
    const x = (t: number) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * iw
    const y = (v: number) => m.t + ih - (Math.min(v, yTop) / yTop) * ih
    // Разрыв линии там, где агент молчал дольше 3 медианных интервалов.
    const gaps = points
      .slice(1)
      .map((p, i) => p[0] - points[i]![0])
      .sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)] ?? 60_000
    let d = ''
    let area = ''
    let segStart = 0
    points.forEach((p, i) => {
      const broken = i > 0 && p[0] - points[i - 1]![0] > median * 3
      if (i === 0 || broken) {
        if (broken) area += `L${x(points[i - 1]![0])},${m.t + ih}L${x(points[segStart]![0])},${m.t + ih}Z`
        d += `M${x(p[0])},${y(p[1])}`
        area += `M${x(p[0])},${y(p[1])}`
        segStart = i
      } else {
        d += `L${x(p[0])},${y(p[1])}`
        area += `L${x(p[0])},${y(p[1])}`
      }
    })
    area += `L${x(points[points.length - 1]![0])},${m.t + ih}L${x(points[segStart]![0])},${m.t + ih}Z`
    const yTicks = Array.from({ length: Math.round(yTop / step) + 1 }, (_, i) => i * step)
    const long = t1 - t0 > 36 * 3_600_000
    const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4)
    return { x, y, d, area, yTicks, xTicks, long, ih, iw, t0, t1 }
  }, [points, width, height, yMax, threshold, m.l, m.r, m.t, m.b])

  const stats = useMemo(() => {
    if (!points.length) return null
    const v = points.map((p) => p[1])
    return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, last: v[v.length - 1]! }
  }, [points])

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!geo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left + m.l
    let best = 0
    let bestD = Infinity
    points.forEach((p, i) => {
      const dist = Math.abs(geo.x(p[0]) - px)
      if (dist < bestD) {
        bestD = dist
        best = i
      }
    })
    setHover(best)
  }

  const hp = hover !== null ? points[hover] : null
  const summary = stats
    ? `${label}: сейчас ${format(stats.last)}, минимум ${format(stats.min)}, среднее ${format(stats.avg)}, максимум ${format(stats.max)}`
    : `${label}: нет данных`

  return (
    <figure className={s.figure} ref={ref}>
      {!geo ? (
        <div className={s.empty} style={{ height }}>
          {points.length < 2 ? emptyText : ''}
        </div>
      ) : (
        <svg className={s.svg} width={width} height={height} role="img" aria-label={summary}>
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className={s.grid} x1={m.l} x2={width - m.r} y1={geo.y(v)} y2={geo.y(v)} />
              <text className={s.axisText} x={m.l - 6} y={geo.y(v) + 4} textAnchor="end">
                {format(v)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t, i) => (
            <text key={t} className={s.axisText} x={geo.x(t)} y={height - 4} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
              {timeLabel(t, geo.long)}
            </text>
          ))}
          {threshold !== undefined ? (
            <line className={s.threshold} x1={m.l} x2={width - m.r} y1={geo.y(threshold)} y2={geo.y(threshold)} />
          ) : null}
          <path className={s.area} d={geo.area} />
          <path className={s.line} d={geo.d} />
          {(markers ?? [])
            .filter((mk) => mk.t >= geo.t0 && mk.t <= geo.t1)
            .slice(0, 200)
            .map((mk) => (
              <line key={mk.t} className={s.marker} x1={geo.x(mk.t)} x2={geo.x(mk.t)} y1={m.t} y2={m.t + geo.ih}>
                <title>{mk.label}</title>
              </line>
            ))}
          {hp ? (
            <>
              <line className={s.cross} x1={geo.x(hp[0])} x2={geo.x(hp[0])} y1={m.t} y2={m.t + geo.ih} />
              <circle className={s.dot} cx={geo.x(hp[0])} cy={geo.y(hp[1])} r={4} />
            </>
          ) : null}
          <rect
            x={m.l}
            y={m.t}
            width={geo.iw}
            height={geo.ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {geo && hp ? (
        <div className={s.tooltip} style={{ left: Math.min(Math.max(geo.x(hp[0]) - 60, 0), width - 140), top: 0 }}>
          <div className={s.tooltipValue}>
            <span className={s.tooltipKey} />
            {format(hp[1])}
          </div>
          <div className={s.tooltipTime}>
            {new Date(hp[0]).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ) : null}
      {stats ? (
        <details className={s.tableToggle}>
          <summary>Таблица значений</summary>
          <table className={s.miniTable}>
            <tbody>
              <tr>
                <th>Сейчас</th>
                <td>{format(stats.last)}</td>
              </tr>
              <tr>
                <th>Минимум</th>
                <td>{format(stats.min)}</td>
              </tr>
              <tr>
                <th>Среднее</th>
                <td>{format(stats.avg)}</td>
              </tr>
              <tr>
                <th>Максимум</th>
                <td>{format(stats.max)}</td>
              </tr>
            </tbody>
          </table>
        </details>
      ) : null}
    </figure>
  )
}

function barTone(pct: number | null): string {
  if (pct === null) return ''
  if (pct >= 99.9) return s.barOk ?? ''
  if (pct >= 99) return s.barWarn ?? ''
  return s.barBad ?? ''
}

export function UptimeBars({ days, label }: { days: UptimeDay[]; label: string }) {
  const [tip, setTip] = useState<{ i: number; left: number } | null>(null)
  const measured = days.filter((d) => d.pct !== null)
  const bad = measured.filter((d) => (d.pct ?? 100) < 99.9).length
  const summary = measured.length ? `${label}: ${measured.length} дней с данными, дней с деградацией — ${bad}` : `${label}: данных пока нет`
  const tipDay = tip ? days[tip.i] : null
  return (
    <div className={s.figure}>
      <div className={`${s.bars} ${days.length > 45 ? s.barsDense : ''}`} role="img" aria-label={summary} onPointerLeave={() => setTip(null)}>
        {days.map((d, i) => (
          <span
            key={d.day}
            className={`${s.bar} ${barTone(d.pct)}`}
            onPointerEnter={(e) => setTip({ i, left: (e.currentTarget as HTMLElement).offsetLeft })}
          />
        ))}
      </div>
      {tipDay ? (
        <div className={s.tooltip} style={{ left: Math.max(0, (tip?.left ?? 0) - 50), top: -48 }}>
          <div className={s.tooltipValue}>{tipDay.pct === null ? 'нет проверок' : `${tipDay.pct}%`}</div>
          <div className={s.tooltipTime}>{new Date(tipDay.day).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' })}</div>
        </div>
      ) : null}
      <div className={s.barsLegend}>
        <span>{days.length} дней назад</span>
        <span>сегодня</span>
      </div>
    </div>
  )
}
