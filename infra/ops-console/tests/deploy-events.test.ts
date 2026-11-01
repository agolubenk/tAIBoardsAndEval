/**
 * События деплоя (POST /api/agent/deploy-events) → живая карточка «Деплоев»: подпись учёткой агента,
 * идемпотентная сборка из накопленных сводок, хранение, доступ к карточке.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { deployProgress, deploys, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import { runTick } from '../server/scheduler/tick'
import { writeMarker } from '../server/settings/store'
import { matchRun } from '../server/deploys/card'
import { DEPLOY_PROGRESS_KEEP } from '../server/deploys/progress'
import { DEPLOY_EVENT_PATH, type DeployCard } from '../shared/deploy-events-contract'

type App = Awaited<ReturnType<typeof freshApp>>

let app: App
let owner: ReturnType<typeof api>
let viewer: ReturnType<typeof api>
let secret = ''

const SHA = '3f4dd207a82581968d76f09b7f4a0cc4deadbeef'

type Phase = { key: string; status: string; startedAt: number | null; endedAt: number | null; rc: number | null }
type Check = { key: string | null; url: string; status: string; rc: number | null; startedAt: number | null; endedAt: number | null }

const ph = (key: string, status: string, startedAt: number, endedAt: number | null = null, rc: number | null = status === 'running' ? null : 0): Phase => ({
  key,
  status,
  startedAt,
  endedAt,
  rc,
})
const ck = (key: string, path: string, status: string, at: number, rc: number | null = status === 'ok' ? 0 : null): Check => ({
  key,
  url: `https://app.example.test${path}`,
  status,
  rc,
  startedAt: at,
  endedAt: status === 'running' ? null : at + 1,
})

function event(t0: number, seq: number, type: string, at: number, phases: Phase[], extra: { checks?: Check[]; rollback?: unknown; rc?: number | null } = {}) {
  return {
    v: 1,
    deployId: `${SHA}-${t0}`,
    seq,
    type,
    sha: SHA,
    startedAt: t0,
    at,
    phases,
    checks: extra.checks ?? [],
    rollback: extra.rollback ?? null,
    rc: extra.rc ?? null,
  }
}

/** Полный зелёный деплой: накопленная сводка на каждом из 8 событий, как их шлёт ops-deploy-events.sh. */
function fullDeploy(t0: number, finalRc = 0) {
  const pre = ph('preflight', 'ok', t0, t0 + 5)
  const prep = ph('prepare', 'ok', t0 + 5, t0 + 65)
  const build = ph('build', 'ok', t0 + 65, t0 + 2465)
  const rb = ph('rollback_prev', 'ok', t0 + 2465, t0 + 2470)
  const clean = ph('cleanup', 'ok', t0 + 2470, t0 + 2525)
  const ngx = ph('nginx', 'ok', t0 + 2525, t0 + 2530)
  const rollback = { changed: 3, failed: 0, stuck: 0 }
  const checks = [
    ck('api_ready', '/api/v1/health/ready', 'ok', t0 + 2531),
    ck('spa', '/', 'ok', t0 + 2533),
    ck('site_config', '/site-config.js', 'ok', t0 + 2535),
  ]
  const chk = ph('checks', 'ok', t0 + 2530, t0 + 2560)
  return [
    event(t0, 1, 'deploy_start', t0, [ph('preflight', 'running', t0)]),
    event(t0, 2, 'prepare', t0 + 5, [pre, ph('prepare', 'running', t0 + 5)]),
    event(t0, 3, 'build_start', t0 + 65, [pre, prep, ph('build', 'running', t0 + 65)]),
    event(t0, 4, 'build_done', t0 + 2465, [pre, prep, build]),
    event(t0, 5, 'rollback_prev', t0 + 2470, [pre, prep, build, rb, ph('cleanup', 'running', t0 + 2470)], { rollback }),
    event(t0, 6, 'nginx_apply', t0 + 2530, [pre, prep, build, rb, clean, ngx], { rollback }),
    event(t0, 7, 'health_checks', t0 + 2560, [pre, prep, build, rb, clean, ngx, chk], { rollback, checks }),
    event(t0, 8, 'deploy_done', t0 + 2561, [pre, prep, build, rb, clean, ngx, chk], { rollback, checks, rc: finalRc }),
  ]
}

const send = (body: unknown, opts: { ts?: number; secret?: string; agent?: string; raw?: string } = {}) =>
  app.request(DEPLOY_EVENT_PATH, signedAgentRequest(opts.agent ?? 'prod', opts.secret ?? secret, body, { ts: opts.ts, path: DEPLOY_EVENT_PATH, raw: opts.raw }))

const live = async (who = owner) => (await who.get('/events/deploys/live')).json as { serverTime: number; card: DeployCard | null }
const cardsOf = async (deployId: string) => getDb().select().from(deployProgress).where(eq(deployProgress.deployId, deployId))
const nowSec = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  app = await freshApp()
  owner = api(app, await login(app))
  secret = (await owner.post('/admin/agents', { id: 'prod', name: 'Contabo · prod' })).json.secret
  await getDb()
    .insert(users)
    .values({ email: 'viewer@ops.test', name: 'V', role: 'viewer', passwordHash: await hashPassword('viewer-password-1'), createdAt: new Date() })
  viewer = api(app, await login(app, 'viewer@ops.test', 'viewer-password-1'))
})

describe('события деплоя → карточка', () => {
  it('полная последовательность: фазы по порядку с длительностями, матрица проверок, rollback-prev, итог, запуск GitHub', async () => {
    const t0 = nowSec() - 3000
    await getDb()
      .insert(deploys)
      .values({
        runKey: '901',
        workflow: 'deploy-contabo.yml',
        status: 'completed',
        conclusion: 'success',
        headSha: SHA.slice(0, 12),
        title: 'feat: живой деплой',
        url: 'https://github.com/o/r/actions/runs/901',
        startedAt: new Date((t0 - 20) * 1000),
        finishedAt: new Date((t0 + 2570) * 1000),
        createdAt: new Date(),
      })
    for (const ev of fullDeploy(t0)) {
      const res = await send(ev)
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toEqual({ ok: true, duplicate: false })
    }
    const { card } = await live()
    expect(card).not.toBeNull()
    const c = card!
    expect(c).toMatchObject({ status: 'success', rc: 0, sha: SHA, agentName: 'Contabo · prod', durationMs: 2561_000 })
    expect(c.phases.map((p) => [p.key, p.status, p.durationMs])).toEqual([
      ['preflight', 'ok', 5_000],
      ['prepare', 'ok', 60_000],
      ['build', 'ok', 2_400_000],
      ['rollback_prev', 'ok', 5_000],
      ['cleanup', 'ok', 55_000],
      ['nginx', 'ok', 5_000],
      ['checks', 'ok', 30_000],
    ])
    expect(c.checks.map((x) => [x.key, x.url, x.status])).toEqual([
      ['api_ready', 'https://app.example.test/api/v1/health/ready', 'ok'],
      ['spa', 'https://app.example.test/', 'ok'],
      ['site_config', 'https://app.example.test/site-config.js', 'ok'],
    ])
    expect(c.rollback).toEqual({ changed: 3, failed: 0, stuck: 0 })
    expect(c.events).toEqual({ received: 8, lastSeq: 8, missing: [] })
    expect(c.run).toMatchObject({ runKey: '901', url: 'https://github.com/o/r/actions/runs/901', title: 'feat: живой деплой' })
  })

  it('повтор события дубля не даёт: тот же seq с новой подписью — duplicate, точный повтор запроса — 409', async () => {
    const t0 = nowSec() - 2900
    const evs = fullDeploy(t0)
    for (const ev of evs.slice(0, 5)) expect((await send(ev)).status).toBe(200)
    const again = await send(evs[3])
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true, duplicate: true })
    // Тот же запрос байт в байт (метка и подпись те же) — повтор отклоняется.
    const ts = Date.now() + 50
    const first = await send(evs[5], { ts })
    expect(first.status).toBe(200)
    expect((await send(evs[5], { ts })).status).toBe(409)
    const [row] = await cardsOf(`${SHA}-${t0}`)
    expect(JSON.parse(row!.eventsJson).map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(row!.lastSeq).toBe(6)
    // Опоздавшее старое событие (seq меньше) сводку не откатывает.
    expect((await send(evs[2])).status).toBe(200)
    const [after] = await cardsOf(`${SHA}-${t0}`)
    expect(after!.summaryJson).toBe(row!.summaryJson)
  })

  it('потеря середины: старт и финальная сводка дают полную карточку, пропуски видны', async () => {
    const t0 = nowSec() - 2800
    const evs = fullDeploy(t0)
    expect((await send(evs[0])).status).toBe(200)
    expect((await send(evs[7])).status).toBe(200)
    const { card } = await live()
    expect(card!.deployId).toBe(`${SHA}-${t0}`)
    expect(card!.status).toBe('success')
    expect(card!.phases.every((p) => p.status === 'ok')).toBe(true)
    expect(card!.checks).toHaveLength(3)
    expect(card!.events).toEqual({ received: 2, lastSeq: 8, missing: [2, 3, 4, 5, 6, 7] })
  })

  it('только финальное событие (все прежние потеряны) — карточка тоже полная', async () => {
    const t0 = nowSec() - 2700
    expect((await send(fullDeploy(t0)[7])).status).toBe(200)
    const { card } = await live()
    expect(card!.deployId).toBe(`${SHA}-${t0}`)
    expect(card!.phases.map((p) => p.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
  })

  it('идущий деплой: фаза сборки тикает, дальше — «ждёт»; красная проверка → failed с кодом', async () => {
    const t0 = nowSec() - 600
    const evs = fullDeploy(t0)
    for (const ev of evs.slice(0, 3)) expect((await send(ev)).status).toBe(200)
    const { card, serverTime } = await live()
    expect(card!.status).toBe('running')
    const build = card!.phases.find((p) => p.key === 'build')!
    expect(build.status).toBe('running')
    expect(build.durationMs).toBe(serverTime - (t0 + 65) * 1000)
    expect(card!.phases.slice(3).map((p) => p.status)).toEqual(['pending', 'pending', 'pending', 'pending'])

    const pre = ph('preflight', 'ok', t0, t0 + 5)
    const failed = event(t0, 9, 'deploy_done', t0 + 300, [pre, ph('checks', 'failed', t0 + 290, t0 + 300, 22)], {
      checks: [ck('api_ready', '/api/v1/health/ready', 'ok', t0 + 291), ck('spa', '/', 'failed', t0 + 293, 22)],
      rc: 22,
    })
    expect((await send(failed)).status).toBe(200)
    const done = (await live()).card!
    expect(done).toMatchObject({ status: 'failed', rc: 22 })
    expect(done.checks.map((x) => [x.key, x.status, x.rc])).toEqual([
      ['api_ready', 'ok', 0],
      ['spa', 'failed', 22],
    ])
    expect(done.phases.find((p) => p.key === 'nginx')!.status).toBe('skipped')
  })

  it('событие деплоя не сбивает метку повтора отчётов агента (общая учётка, разные метки)', async () => {
    const t0 = nowSec() - 500
    expect((await send(fullDeploy(t0)[0], { ts: Date.now() + 2000 })).status).toBe(200)
    // Отчёт подписан раньше события деплоя, а пришёл позже — принимается.
    const res = await app.request('/api/agent/report', signedAgentRequest('prod', secret, report([]), { ts: Date.now() + 1000 }))
    expect(res.status).toBe(200)
  })
})

describe('подпись и тело', () => {
  it('чужой секрет, неизвестный агент, просроченное время — 401, событие не записано', async () => {
    const t0 = nowSec() - 400
    const ev = fullDeploy(t0)[0]
    expect((await send(ev, { secret: 'wrong-secret' })).status).toBe(401)
    expect((await send(ev, { agent: 'ghost' })).status).toBe(401)
    expect((await send(ev, { ts: Date.now() - 6 * 60_000 })).status).toBe(401)
    expect(await cardsOf(`${SHA}-${t0}`)).toHaveLength(0)
  })

  it('тело больше 16 КБ — отказ; не по контракту и старт вне суток — 400; ничего не записано', async () => {
    const t0 = nowSec() - 300
    const ev = fullDeploy(t0)[0]
    const big = JSON.stringify({ ...ev, pad: 'x'.repeat(17 * 1024) })
    expect((await send(null, { raw: big })).status).toBe(400)
    expect((await send({ ...ev, deployId: `${SHA}-${t0 + 1}` })).status).toBe(400)
    expect((await send({ ...ev, rc: 0 })).status).toBe(400)
    const old = nowSec() - 2 * 86_400
    expect((await send(fullDeploy(old)[0])).status).toBe(400)
    expect(await cardsOf(`${SHA}-${t0}`)).toHaveLength(0)
    expect(await cardsOf(`${SHA}-${old}`)).toHaveLength(0)
  })

  it('новых карточек от агента за час — не больше 30', async () => {
    const created = await owner.post('/admin/agents', { id: 'flood', name: 'flood' })
    const t0 = nowSec() - 200
    for (let i = 0; i < 30; i += 1) expect((await send(fullDeploy(t0 - i)[0], { agent: 'flood', secret: created.json.secret })).status).toBe(200)
    expect((await send(fullDeploy(t0 - 30)[0], { agent: 'flood', secret: created.json.secret })).status).toBe(429)
  })
})

describe('доступ к карточке', () => {
  it('наблюдатель видит карточку, без сессии — 401', async () => {
    const res = await viewer.get('/events/deploys/live')
    expect(res.status).toBe(200)
    expect(res.json.card).not.toBeNull()
    expect((await app.request('/api/events/deploys/live')).status).toBe(401)
  })
})

describe('хранение', () => {
  const insertCard = (deployId: string, startedAt: number) =>
    getDb()
      .insert(deployProgress)
      .values({
        agentId: 'retention',
        deployId,
        sha: SHA,
        status: 'success',
        rc: 0,
        startedAt: new Date(startedAt),
        finishedAt: new Date(startedAt + 60_000),
        summaryJson: '{}',
        lastSeq: 1,
        lastEventTs: startedAt,
        lastEventAt: new Date(startedAt),
      })

  it('ежедневная чистка планировщика: старше 90 дней удаляются, всего — не больше 200 последних', async () => {
    const now = Date.now()
    await insertCard('old-1', now - 91 * 86_400_000)
    await insertCard('fresh-1', now - 86_400_000)
    await writeMarker('cleanup', 0)
    await runTick()
    expect(await cardsOf('old-1')).toHaveLength(0)
    expect(await cardsOf('fresh-1')).toHaveLength(1)

    for (let i = 0; i < DEPLOY_PROGRESS_KEEP + 5; i += 1) await insertCard(`bulk-${i}`, now - 3_600_000 + i * 1000)
    await writeMarker('cleanup', 0)
    await runTick()
    const all = await getDb().select({ deployId: deployProgress.deployId }).from(deployProgress)
    expect(all).toHaveLength(DEPLOY_PROGRESS_KEEP)
    // Остались самые новые: самые ранние bulk и fresh-1 (сутки назад) ушли.
    const ids = new Set(all.map((r) => r.deployId))
    expect(ids.has(`bulk-${DEPLOY_PROGRESS_KEEP + 4}`)).toBe(true)
    expect(ids.has('bulk-0')).toBe(false)
    expect(ids.has('fresh-1')).toBe(false)
  })
})

describe('сопоставление с запуском GitHub', () => {
  const run = (runKey: string, headSha: string, startedAt: number, finishedAt: number | null) => ({
    id: Number(runKey),
    runKey,
    workflow: 'deploy-contabo.yml',
    status: finishedAt ? 'completed' : 'in_progress',
    conclusion: finishedAt ? 'success' : null,
    headSha,
    title: '',
    actor: '',
    url: '',
    startedAt: new Date(startedAt),
    finishedAt: finishedAt ? new Date(finishedAt) : null,
    createdAt: new Date(startedAt),
  })
  const start = Date.UTC(2026, 9, 17, 8, 0, 0)

  it('по sha — ближайший по времени; ручной запуск (вершина ветки) — по времени; двусмысленно — никакой', () => {
    const push = run('1', SHA.slice(0, 12), start - 30_000, start + 2_000_000)
    const rerun = run('2', SHA.slice(0, 12), start - 7_200_000, start - 5_000_000)
    expect(matchRun(SHA, start, [rerun, push])?.runKey).toBe('1')
    const manual = run('3', 'ffffffffffff', start - 40_000, null)
    expect(matchRun(SHA, start, [manual])?.runKey).toBe('3')
    const other = run('4', 'eeeeeeeeeeee', start - 50_000, null)
    expect(matchRun(SHA, start, [manual, other])).toBeNull()
    expect(matchRun(SHA, start, [run('5', 'ffffffffffff', start - 5 * 3_600_000, null)])).toBeNull()
  })
})
