/**
 * «Больше информации» под отчётом — подробный отчёт (тот же, что у ИИ-совета) по разделам в одном
 * сообщении: кнопки разделов переключают его на месте; «Весь отчёт» — прежняя выдача всеми
 * разделами подряд. Отчёт за период строится один раз и держится в памяти 2 минуты: листание
 * разделов не пересчитывает его на каждое нажатие.
 */
import type { OpsReport } from '../../../shared/report-contract'
import { buildReport } from '../../reports/build'
import { detailSections, periodLine, type ReportSectionKey } from '../../reports/telegram'
import { cb, e, fit, pairs, type Button, type View, type ViewCtx } from './ui'

export const SECTION_KEYS: readonly ReportSectionKey[] = ['sum', 'av', 'inc', 'hst', 'dep', 'tls', 'rec']

const TTL_MS = 2 * 60_000
const cache = new Map<number, { at: number; report: Promise<OpsReport> }>()

export function resetReportCacheForTests(): void {
  cache.clear()
}

/** Конец периода (мин): не в будущем и не старше 30 дней — старше данных уже нет. */
export function clampEndMin(endMin: number, now = Date.now()): number {
  const nowMin = Math.floor(now / 60_000)
  return Math.min(Math.max(endMin, nowMin - 30 * 24 * 60), nowMin)
}

/** Есть ли готовый отчёт за период (кнопки разделов листаются без пересчёта). */
export function reportCached(endMinRaw: number, now = Date.now()): boolean {
  const hit = cache.get(clampEndMin(endMinRaw, now))
  return Boolean(hit && now - hit.at <= TTL_MS)
}

/** Отчёт, только что отправленный карточкой (суточный, срочный), — в кэш: «Больше информации» не пересчитывает его. */
export function rememberReport(report: OpsReport, now = Date.now()): void {
  const endMin = Math.floor(new Date(report.period.end).getTime() / 60_000)
  cache.set(endMin, { at: now, report: Promise.resolve(report) })
  while (cache.size > 10) cache.delete(cache.keys().next().value as number)
}

function reportFor(endMin: number, now: number): Promise<OpsReport> {
  for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k)
  const hit = cache.get(endMin)
  if (hit) return hit.report
  const report = buildReport('daily', new Date(endMin * 60_000))
  cache.set(endMin, { at: now, report })
  report.catch(() => cache.delete(endMin))
  // Не больше 10 периодов в памяти (кнопки под старыми отчётами за разные дни).
  while (cache.size > 10) cache.delete(cache.keys().next().value as number)
  return report
}

export async function reportSectionView(ctx: ViewCtx, key: ReportSectionKey, endMinRaw: number): Promise<View> {
  const endMin = clampEndMin(endMinRaw, ctx.now)
  const report = await reportFor(endMin, ctx.now)
  const sections = detailSections(report, ctx.tz, ctx.now)
  const current = sections.find((s) => s.key === key) ?? sections[0]!
  const lines = current.key === 'sum' ? current.lines : [`📋 <b>${e(report.source.console)} · подробный отчёт</b>`, `<i>${e(periodLine(report, ctx.tz))}</i>`, '', ...current.lines]
  const buttons: Button[] = sections.map((s) => cb(s.key === current.key ? `• ${s.button} •` : s.button, `rs:${s.key}:${endMin}`))
  const rows = pairs(buttons)
  rows.push([cb('📄 Весь отчёт', `rs:all:${endMin}`), cb('📈 Графики', `rep:charts:${endMin}`)])
  rows.push([cb('🏠 Меню', 'm:home')])
  return { html: fit(lines), rows }
}
