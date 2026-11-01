/**
 * Отчёт в каналы: цвет и заголовок — по тому, что горело за период, а не только по открытым
 * сейчас алертам. Регрессия 2026-10-09: сутки с закрывшимися к утру критичными сбоями приходили
 * в Telegram зелёными («Всё в норме»).
 */
import { describe, expect, it } from 'vitest'
import { digestLevel, digestSubject, periodHead } from '../server/reports/digest'
import { detailHtmlParts, digestText } from '../server/reports/telegram'
import { OPS_REPORT_SCHEMA, type OpsReport } from '../shared/report-contract'

const report = (
  over: {
    status?: OpsReport['summary']['status']
    critical?: number
    warning?: number
    incidents?: number
    failedDeploys?: number
    open?: number
  } = {},
): OpsReport => {
  const critical = over.critical ?? 0
  const warning = over.warning ?? 0
  const status = over.status ?? 'healthy'
  return {
    schema: OPS_REPORT_SCHEMA,
    source: { console: 'HRH Ops', url: 'https://ops.example.com' },
    period: { kind: 'daily', start: '2026-10-08T21:00:00.000Z', end: '2026-10-09T21:00:00.000Z' },
    generatedAt: '2026-10-09T21:00:00.000Z',
    summary: {
      status,
      headline: {
        healthy: 'Системы работают штатно',
        degraded: 'Есть деградация — требуется внимание',
        critical: 'Есть критичные проблемы',
      }[status],
      highlights: [],
    },
    availability: [{ monitor: 'app', url: 'https://app.example.com', uptimePct: 100, checks: 1440, avgLatencyMs: 210 }],
    incidents: Array.from({ length: over.incidents ?? 0 }, (_, i) => ({
      id: i + 1,
      title: 'сбой',
      severity: 'critical' as const,
      status: 'resolved',
      startedAt: '2026-10-09T02:00:00.000Z',
      resolvedAt: '2026-10-09T02:04:00.000Z',
      durationMin: 4,
    })),
    alerts: {
      fired: critical + warning,
      critical,
      warning,
      stillOpen: Array.from({ length: over.open ?? 0 }, () => ({ title: 't', object: 'o', severity: 'critical', since: '' })),
    },
    restarts: [],
    hosts: [],
    deploys: { total: 3, failed: over.failedDeploys ?? 0, recent: [] },
    tls: [],
    recommendations: [],
  }
}

const headLine = (text: string) => text.split('\n').find((l) => / — /.test(l) && !l.startsWith('🌐')) ?? ''

describe('отчёт в каналы: уровень за период', () => {
  it('тихие сутки — зелёный «Всё в норме»', () => {
    const r = report()
    expect(digestLevel(r)).toBe('healthy')
    expect(headLine(digestText(r, 'UTC'))).toBe('🟢 Всё в норме — сбоев за период не было')
  })

  it('критичные сбои закрылись к отправке — красный и честный заголовок, а не зелёный', () => {
    const r = report({ critical: 2, warning: 1, incidents: 2 })
    expect(digestLevel(r)).toBe('critical')
    expect(periodHead(r)).toBe('🔴 Были сбои, сейчас штатно')
    const text = digestText(r, 'UTC')
    expect(headLine(text)).toBe('🔴 Были сбои, сейчас штатно — 2 инцидента, все закрыты')
    expect(text).toContain('🚨 Инциденты: 2 · алерты: 3 (критичных 2)')
    expect(digestSubject(r)).toBe('HRH Ops: отчёт за сутки — 🔴 Были сбои, сейчас штатно')
    // Подробный отчёт («Подробнее») — тот же заголовок.
    expect(detailHtmlParts(r, 'UTC')[0]).toContain('<b>🔴 Были сбои, сейчас штатно</b>')
  })

  it('закрывшееся предупреждение или упавший деплой без инцидента — оранжевый, и причина не противоречит заголовку', () => {
    expect(headLine(digestText(report({ warning: 1 }), 'UTC'))).toBe('🟠 Были сбои, сейчас штатно — 1 алерт, закрыт')
    expect(headLine(digestText(report({ failedDeploys: 1 }), 'UTC'))).toBe('🟠 Были сбои, сейчас штатно — неудачных деплоев: 1')
  })

  it('статус «деградация», но за период был критичный алерт — красный', () => {
    const r = report({ status: 'degraded', critical: 1 })
    expect(digestLevel(r)).toBe('critical')
    expect(periodHead(r)).toBe('🔴 Есть деградация')
  })

  it('только предупреждения или упавший деплой — оранжевый', () => {
    expect(digestLevel(report({ warning: 1 }))).toBe('degraded')
    const r = report({ failedDeploys: 1 })
    expect(periodHead(r)).toBe('🟠 Были сбои, сейчас штатно')
    expect(digestText(r, 'UTC')).toContain('🚀 Деплои: 3 (упало 1)')
  })

  it('горит сейчас — заголовок о текущем состоянии', () => {
    const r = report({ status: 'critical', critical: 1, open: 1 })
    expect(headLine(digestText(r, 'UTC'))).toBe('🔴 Критично — горит 1 алерт')
  })
})
