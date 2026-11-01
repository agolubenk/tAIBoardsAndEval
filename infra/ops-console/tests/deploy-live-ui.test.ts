/**
 * Живая карточка деплоя в интерфейсе: статусы, тикающие длительности, подписи rollback-prev (чистые функции) и
 * рендер компонента (react-dom/server, кэш запросов заполнен заранее — без сети и браузера).
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { DeployCard, DeployLiveResponse } from '../shared/deploy-events-contract'
import { checkBadge, deployBadge, failedPhase, liveMs, phaseBadge, rollbackSummary } from '../web/pages/deploys/deployLive'
import { LiveDeploy } from '../web/pages/deploys/LiveDeploy'

function render(data: DeployLiveResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(['deploy-live'], data)
  return renderToString(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(LiveDeploy))))
}

const card = (over: Partial<DeployCard> = {}): DeployCard => ({
  id: 1,
  agentId: 'prod',
  agentName: 'prod',
  deployId: `${'a'.repeat(40)}-1792215000`,
  sha: 'a'.repeat(40),
  status: 'running',
  startedAt: 1_792_215_000_000,
  finishedAt: null,
  durationMs: 60_000,
  lastEventAt: 1_792_215_060_000,
  rc: null,
  phases: [
    { key: 'preflight', status: 'ok', startedAt: 0, endedAt: 5_000, durationMs: 5_000, rc: 0 },
    { key: 'build', status: 'running', startedAt: 5_000, endedAt: null, durationMs: 55_000, rc: null },
    { key: 'rollback_prev', status: 'pending', startedAt: null, endedAt: null, durationMs: null, rc: null },
  ],
  checks: [],
  rollback: null,
  events: { received: 3, lastSeq: 3, missing: [] },
  run: null,
  ...over,
})

describe('живая карточка деплоя', () => {
  it('идущая фаза тикает только у идущего деплоя; у деплоя без событий она «прервана»', () => {
    const c = card()
    expect(liveMs(55_000, true, 4_000)).toBe(59_000)
    expect(liveMs(55_000, false, 4_000)).toBe(55_000)
    expect(phaseBadge(c.phases[1]!, c)).toEqual(['pending', 'Идёт'])
    expect(phaseBadge(c.phases[1]!, card({ status: 'stale' }))).toEqual(['unknown', 'Прервана'])
    expect(deployBadge(card({ status: 'stale' }))).toEqual(['unknown', 'Нет событий'])
  })

  it('итог и первая упавшая фаза; проверка — код curl или «не прошла» у site-config', () => {
    const failed = card({
      status: 'failed',
      rc: 22,
      phases: [{ key: 'checks', status: 'failed', startedAt: 0, endedAt: 1, durationMs: 1000, rc: 22 }],
    })
    expect(deployBadge(failed)).toEqual(['critical', 'Упал · код 22'])
    expect(failedPhase(failed)?.key).toBe('checks')
    const check = { key: 'spa', url: 'https://app.example.test/', status: 'failed' as const, rc: 22, durationMs: 1000 }
    expect(checkBadge(check, failed)).toEqual(['critical', 'Ошибка · curl 22'])
    expect(checkBadge({ ...check, key: 'site_config', rc: 1 }, failed)).toEqual(['critical', 'Не прошла'])
  })

  it('rollback-prev: ещё не ставился, не дошёл, не менялся, частично', () => {
    expect(rollbackSummary(card())).toBe('ещё не ставился')
    const skipped = card({ status: 'failed', phases: [{ key: 'rollback_prev', status: 'skipped', startedAt: null, endedAt: null, durationMs: null, rc: null }] })
    expect(rollbackSummary(skipped)).toMatch(/^не ставился/)
    const done = (r: DeployCard['rollback']) =>
      card({ rollback: r, phases: [{ key: 'rollback_prev', status: 'ok', startedAt: 1, endedAt: 2, durationMs: 1000, rc: 0 }] })
    expect(rollbackSummary(done({ changed: 0, failed: 0, stuck: 0 }))).toMatch(/тег не менялся/)
    expect(rollbackSummary(done({ changed: 3, failed: 1, stuck: 0 }))).toBe(
      'поставлен для 2 из 3 сменившихся сервисов; не поставлен для 1 — их откат только пересборкой',
    )
  })

  it('компонент рисует идущий деплой, итог с проверками и пустое состояние', () => {
    const running = render({ serverTime: 1_792_215_060_000, card: card({ run: { runKey: '9', url: 'https://github.com/o/r/actions/runs/9', title: 'feat: x', status: 'in_progress', conclusion: null } }) })
    expect(running).toContain('Идёт деплой')
    expect(running).toContain('Сборка, миграции, подъём стека')
    expect(running).toContain('href="https://github.com/o/r/actions/runs/9"')
    expect(running).toContain('Ещё не начинались')

    const done = render({
      serverTime: 1_792_215_060_000,
      card: card({
        status: 'failed',
        rc: 22,
        phases: [{ key: 'checks', status: 'failed', startedAt: 0, endedAt: 1, durationMs: 1000, rc: 22 }],
        checks: [{ key: 'spa', url: 'https://app.example.test/', status: 'failed', rc: 22, durationMs: 1000 }],
        events: { received: 2, lastSeq: 8, missing: [2, 3, 4, 5, 6, 7] },
        // Не https — ссылкой не рисуется.
        run: { runKey: '9', url: 'javascript:alert(1)', title: '', status: 'completed', conclusion: 'failure' },
      }),
    })
    expect(done).toContain('Последний деплой')
    expect(done).toContain('Упал · код 22')
    expect(done).toContain('app.example.test/')
    expect(done).toContain('потеряны № 2, 3, 4, 5, 6, 7')
    expect(done).not.toContain('javascript:')

    expect(render({ serverTime: 1, card: null })).toContain('Событий деплоя ещё не было')
  })
})
