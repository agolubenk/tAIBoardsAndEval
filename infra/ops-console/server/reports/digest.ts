/**
 * Цвет и заголовок отчёта в каналах (дайджест, подробный и срочный отчёт, тема письма) — по тому,
 * что горело ЗА ПЕРИОД, а не только по открытым сейчас алертам. `summary.status` отчёта описывает
 * текущий момент (его читает и ИИ-совет). До 2026-10-09 заголовок брал только его, поэтому сутки с
 * критичными сбоями, которые закрылись к моменту отправки, приходили зелёными «Всё в норме».
 */
import type { OpsReport } from '../../shared/report-contract'

export type DigestLevel = 'critical' | 'degraded' | 'healthy'

const ICON: Record<DigestLevel, string> = { critical: '🔴', degraded: '🟠', healthy: '🟢' }

const STATUS_LABEL: Record<OpsReport['summary']['status'], string> = {
  healthy: 'Всё в норме',
  degraded: 'Есть деградация',
  critical: 'Критично',
}

export function digestLevel(r: OpsReport): DigestLevel {
  if (r.summary.status === 'critical' || r.alerts.critical > 0) return 'critical'
  if (r.summary.status === 'degraded' || r.alerts.warning > 0 || r.incidents.length > 0 || r.deploys.failed > 0) return 'degraded'
  return 'healthy'
}

/**
 * «🔴 Были сбои, сейчас штатно» вместо зелёного, если сбои закрылись к отправке. Проблема — первой:
 * в теме письма на телефоне видно только начало.
 */
export function periodHead(r: OpsReport): string {
  const level = digestLevel(r)
  if (r.summary.status === 'healthy' && level !== 'healthy') return `${ICON[level]} Были сбои, сейчас штатно`
  // Цвет — по худшему за период: 5 минут критичного сбоя при доступности 99,6 % дают статус
  // «деградация», но сутки должны прийти красными.
  return `${ICON[level]} ${STATUS_LABEL[r.summary.status]}`
}

/** Тема письма суточного дайджеста: уровень за период — в начале, его видно на телефоне. */
export function digestSubject(r: OpsReport): string {
  return `${r.source.console}: отчёт за сутки — ${periodHead(r)}`
}
