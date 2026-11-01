/**
 * Снимки графиков для Telegram: SVG строится здесь же (тот же визуальный язык, что у графиков
 * консоли), растр — resvg (без браузера и без Chromium). Шрифт — файлами: в образе стоит
 * fonts-dejavu-core (кириллица), локально — системные шрифты ОС.
 *
 * Размер — под телефон: холст 720 логических пикселей с текстом 22–30 px (на экране ~360 dp это
 * 11–15 dp), растр 900 px — Telegram всё равно пережимает фото в JPEG, а больше пикселей — больше
 * трафика у получателя (альбом ~230 КБ). Пустые графики не отправляются.
 *
 * Данные — из metric_samples (хосты) и check_rollups (проверки доступности), за сутки, с
 * усреднением по корзинам. Растр — в пуле libuv по одному графику, между запросами — уступка циклу
 * событий: иначе ~0,2 с синхронной работы задерживают проверки доступности, идущие параллельно.
 * Набор снимков кэшируется на минуту: суточный отчёт приходит во все чаты разом, и кнопку
 * «Графики» жмут одновременно.
 */
import { existsSync } from 'node:fs'
import { Resvg, renderAsync } from '@resvg/resvg-js'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, checkRollups, metricSamples, monitors } from '../db/schema'
import { clock } from '../lib/time'

export interface Series {
  label: string
  color: string
  points: Array<[number, number]>
}

export interface ChartSpec {
  title: string
  unit: string
  /** Фиксированный максимум оси (проценты — 100); иначе по данным. */
  yMax?: number
  series: Series[]
  timeZone: string
  from: number
  to: number
  /** Горизонтальная линия порога (например, 90% диска). */
  threshold?: number
}

const W = 720
const H = 460
const RASTER_W = 900
const PAD = { l: 84, r: 24, t: 70, b: 54 }
const LEGEND_ROW = 30
const LABEL_MAX = 18
const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif'
export const PALETTE = ['#2563EB', '#D84A35', '#087F5B', '#B86700', '#7C3AED', '#0E7490']

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

const short = (label: string) => (label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label)

/** Легенда — строками: длинные имена хостов не уезжают за край картинки. */
function legendLayout(series: Series[]): Array<{ s: Series; label: string; x: number; row: number }> {
  const out: Array<{ s: Series; label: string; x: number; row: number }> = []
  let x = PAD.l
  let row = 0
  for (const s of series) {
    const label = short(s.label)
    const w = 34 + label.length * 12
    if (x > PAD.l && x + w > W - PAD.r) {
      row++
      x = PAD.l
    }
    out.push({ s, label, x, row })
    x += w + 14
  }
  return out
}

export function chartSvg(spec: ChartSpec): string {
  const all = spec.series.flatMap((s) => s.points.map((p) => p[1]))
  const yMax = spec.yMax ?? niceMax(Math.max(1, ...all, spec.threshold ?? 0) * 1.1)
  const legend = legendLayout(spec.series)
  const legendRows = legend.length ? Math.max(...legend.map((l) => l.row)) + 1 : 0
  const height = H + Math.max(0, legendRows - 1) * LEGEND_ROW
  const bottom = PAD.b + legendRows * LEGEND_ROW
  const iw = W - PAD.l - PAD.r
  const ih = height - PAD.t - bottom
  const x = (t: number) => PAD.l + ((t - spec.from) / Math.max(1, spec.to - spec.from)) * iw
  const y = (v: number) => PAD.t + ih - (Math.min(v, yMax) / yMax) * ih
  const text = (attrs: string, size: number, fill: string, body: string) =>
    `<text ${attrs} font-family="${FONT}" font-size="${size}" fill="${fill}">${esc(body)}</text>`
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">`,
    `<rect width="${W}" height="${height}" fill="#F7F8FA"/>`,
    text(`x="${PAD.l - 60}" y="42" font-weight="bold"`, 30, '#111827', spec.title),
  ]
  // Сетка и подписи оси Y: 4 деления (0/25/50/75/100%) — на узкой картинке больше не читается.
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i
    const yy = y(v)
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}" stroke="#E5E7EB" stroke-width="1.5"/>`)
    parts.push(text(`x="${PAD.l - 10}" y="${yy + 7}" text-anchor="end"`, 20, '#6B7280', `${Math.round(v * 10) / 10}${spec.unit}`))
  }
  // Подписи оси X: 4 метки времени.
  for (let i = 0; i <= 3; i++) {
    const t = spec.from + ((spec.to - spec.from) / 3) * i
    const anchor = i === 0 ? 'start' : i === 3 ? 'end' : 'middle'
    parts.push(text(`x="${x(t)}" y="${height - bottom + 30}" text-anchor="${anchor}"`, 20, '#6B7280', clock(t, spec.timeZone, spec.to)))
  }
  if (spec.threshold !== undefined) {
    const ty = y(spec.threshold)
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${ty}" y2="${ty}" stroke="#C52222" stroke-width="2" stroke-dasharray="8 6"/>`)
  }
  for (const s of spec.series) {
    if (s.points.length === 1) {
      const [t, v] = s.points[0]!
      parts.push(`<circle cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5" fill="${s.color}"/>`)
      continue
    }
    if (s.points.length < 2) continue
    const d = s.points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`)
  }
  for (const l of legend) {
    const ly = height - bottom + 54 + l.row * LEGEND_ROW
    parts.push(`<rect x="${l.x}" y="${ly - 16}" width="18" height="18" rx="4" fill="${l.s.color}"/>`)
    parts.push(text(`x="${l.x + 26}" y="${ly}"`, 22, '#374151', l.label))
  }
  if (!all.length) parts.push(text(`x="${W / 2}" y="${PAD.t + ih / 2}" text-anchor="middle"`, 24, '#6B7280', 'Нет данных за период'))
  parts.push('</svg>')
  return parts.join('')
}

/**
 * Шрифты — конкретными файлами, без сканирования системы (оно занимает секунды на каждую картинку):
 * в образе — DejaVu (fonts-dejavu-core), локально на macOS — Arial. Нет ни одного — системные.
 */
const FONT_FILES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].filter((f) => existsSync(f))

const fontOptions = () =>
  FONT_FILES.length
    ? { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: FONT_FILES[0]!.includes('DejaVu') ? 'DejaVu Sans' : 'Arial' }
    : { loadSystemFonts: true }

/** Синхронный растр — для тестов и разовых картинок. */
export function renderPng(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { font: fontOptions(), fitTo: { mode: 'width', value: RASTER_W } }).render().asPng())
}

/** Растр в пуле libuv: основной поток (агенты, проверки, вебхук) не ждёт. */
async function renderPngAsync(svg: string): Promise<Buffer> {
  const img = await renderAsync(svg, { font: fontOptions(), fitTo: { mode: 'width', value: RASTER_W } })
  return Buffer.from(img.asPng())
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

const BUCKETS = 96

/** Средние по корзинам — в SQL: на 6 хостов за сутки ~600 строк вместо ~8,6 тыс. */
async function metricSeries(agentIds: string[], metric: string, from: number, to: number): Promise<Map<string, Array<[number, number]>>> {
  if (!agentIds.length) return new Map()
  const size = Math.ceil((to - from) / BUCKETS)
  const rows = await getDb()
    .select({
      agentId: metricSamples.agentId,
      bucket: sql<number>`cast((${metricSamples.createdAt} - ${from}) / ${size} as integer)`,
      avg: sql<number>`avg(${metricSamples.value})`,
    })
    .from(metricSamples)
    .where(
      and(
        inArray(metricSamples.agentId, agentIds),
        eq(metricSamples.metric, metric),
        gte(metricSamples.createdAt, new Date(from)),
        lt(metricSamples.createdAt, new Date(to)),
      ),
    )
    .groupBy(metricSamples.agentId, sql`2`)
    .limit(agentIds.length * (BUCKETS + 1))
  const by = new Map<string, Array<[number, number]>>()
  for (const r of rows) {
    const list = by.get(r.agentId) ?? []
    list.push([from + size * (Number(r.bucket) + 0.5), Number(r.avg)])
    by.set(r.agentId, list)
  }
  for (const list of by.values()) list.sort((a, b) => a[0] - b[0])
  return by
}

export interface Snapshot {
  name: string
  caption: string
  png: Buffer
}

const SNAPSHOT_TTL_MS = 60_000
const snapshotCache = new Map<string, { at: number; shots: Promise<Snapshot[]> }>()

export function resetSnapshotCacheForTests(): void {
  snapshotCache.clear()
}

/**
 * Снимки за сутки, заканчивающиеся в `to`: CPU, память, диск по хостам, задержка проверок,
 * ошибки nginx — только графики, где есть данные. Одинаковый запрос в течение минуты (кнопка под
 * суточным отчётом во всех чатах) получает уже готовый набор.
 */
export function buildSnapshots(timeZone: string, to = Date.now(), agentId?: string): Promise<Snapshot[]> {
  const key = `${timeZone}|${Math.floor(to / SNAPSHOT_TTL_MS)}|${agentId ?? '*'}`
  const now = Date.now()
  for (const [k, v] of snapshotCache) if (now - v.at > SNAPSHOT_TTL_MS) snapshotCache.delete(k)
  const hit = snapshotCache.get(key)
  if (hit) return hit.shots
  const shots = renderSnapshots(timeZone, to, agentId)
  snapshotCache.set(key, { at: now, shots })
  shots.catch(() => snapshotCache.delete(key))
  return shots
}

/** agentId — графики одного хоста (кнопка «Графики хоста» в боте): без общих проверок доступности. */
async function renderSnapshots(timeZone: string, to: number, agentId?: string): Promise<Snapshot[]> {
  const from = to - 86_400_000
  const db = getDb()
  const hosts = await db.query.agents.findMany({
    where: agentId ? and(eq(agents.enabled, true), eq(agents.id, agentId)) : eq(agents.enabled, true),
    orderBy: asc(agents.name),
    limit: 6,
  })
  const ids = hosts.map((h) => h.id)
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id
  const series: Record<string, Map<string, Array<[number, number]>>> = {}
  for (const metric of ['cpu_pct', 'mem_pct', 'disk_pct', 'nginx_5xx_rpm']) {
    series[metric] = await metricSeries(ids, metric, from, to)
    await yieldLoop()
  }
  const hostSeries = (m: Map<string, Array<[number, number]>> | undefined) =>
    [...(m ?? new Map<string, Array<[number, number]>>())]
      .filter(([, points]) => points.length)
      .map(([id, points], i) => ({ label: nameOf(id), color: PALETTE[i % PALETTE.length] ?? '#2563EB', points }))
  const base = { timeZone, from, to }
  const specs: Array<[string, string, ChartSpec]> = [
    ['cpu', 'Загрузка CPU за сутки', { ...base, title: 'CPU, %', unit: '%', yMax: 100, series: hostSeries(series.cpu_pct) }],
    ['memory', 'Память за сутки', { ...base, title: 'Память, %', unit: '%', yMax: 100, series: hostSeries(series.mem_pct), threshold: 90 }],
    ['disk', 'Диск за сутки', { ...base, title: 'Диск, % (самый полный)', unit: '%', yMax: 100, series: hostSeries(series.disk_pct), threshold: 90 }],
  ]
  // Проверки доступности: средняя задержка по часам (check_rollups).
  const mons = agentId ? [] : await db.query.monitors.findMany({ where: eq(monitors.enabled, true), orderBy: asc(monitors.sortOrder), limit: 6 })
  if (mons.length) {
    const rollups = await db
      .select()
      .from(checkRollups)
      .where(
        and(
          inArray(checkRollups.monitorId, mons.map((m) => m.id)),
          eq(checkRollups.grain, 'h'),
          gte(checkRollups.bucketStart, from),
          lt(checkRollups.bucketStart, to),
        ),
      )
      .limit(2000)
    const latency = mons
      .map((m, i) => ({
        label: m.name,
        color: PALETTE[i % PALETTE.length] ?? '#2563EB',
        points: rollups
          .filter((r) => r.monitorId === m.id && r.latencyCount > 0)
          .sort((a, b) => a.bucketStart - b.bucketStart)
          .map((r) => [r.bucketStart + 1_800_000, r.latencySum / r.latencyCount] as [number, number]),
      }))
      .filter((x) => x.points.length)
    specs.push(['latency', 'Задержка проверок за сутки', { ...base, title: 'Задержка проверок, мс', unit: '', series: latency }])
  }
  specs.push(['nginx5xx', 'Ошибки 5xx nginx за сутки', { ...base, title: 'nginx: 5xx в минуту', unit: '', series: hostSeries(series.nginx_5xx_rpm) }])
  const out: Snapshot[] = []
  for (const [name, caption, spec] of specs) {
    if (!spec.series.length) continue
    out.push({ name, caption, png: await renderPngAsync(chartSvg(spec)) })
  }
  return out
}
