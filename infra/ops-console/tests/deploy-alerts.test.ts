/**
 * Алерты по событиям деплоя (OPS-DEPLOY-VIS, фаза 2): провал и rollback-prev по deploy_done, долгий деплой на тике,
 * контекст для «Сайт недоступен», границы доверия между агентами и опросом GitHub, апгрейд встроенного «Деплой упал».
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { api, freshApp, login, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { alertRules, alerts, deployProgress, deploys, monitors, ruleStreaks } from '../server/db/schema'
import { ensureBuiltinRules } from '../server/alerts/builtin'
import { observe } from '../server/alerts/store'
import { recordCheck } from '../server/monitors/checks'
import { runTick } from '../server/scheduler/tick'
import { writeMarker } from '../server/settings/store'
import { AFTER_DEPLOY_WINDOW_MS, deployContext, deployEventFingerprint, deployFailedFingerprint, evaluateDeploySlow } from '../server/deploys/alerts'
import { DEPLOY_EVENT_PATH } from '../shared/deploy-events-contract'

type App = Awaited<ReturnType<typeof freshApp>>
type Phase = { key: string; status: string; startedAt: number | null; endedAt: number | null; rc: number | null }
type Check = { key: string | null; url: string; status: string; rc: number | null; startedAt: number | null; endedAt: number | null }
type Rollback = { changed: number; failed: number; stuck: number }

let app: App
let owner: ReturnType<typeof api>
const secrets: Record<string, string> = {}

const SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const WORKFLOW = 'deploy-contabo.yml'
const OBJECT = `Деплой · ${WORKFLOW}`
const nowSec = () => Math.floor(Date.now() / 1000)

const ph = (key: string, status: string, at: number, rc: number | null = status === 'running' ? null : status === 'ok' ? 0 : 1): Phase => ({
  key,
  status,
  startedAt: at,
  endedAt: status === 'running' ? null : at + 1,
  rc,
})
const ck = (key: string, path: string, status: string, at: number, rc: number | null = status === 'ok' ? 0 : 22): Check => ({
  key,
  url: `https://app.example.test${path}`,
  status,
  rc,
  startedAt: at,
  endedAt: at + 1,
})

function event(t0: number, seq: number, type: string, at: number, phases: Phase[], extra: { checks?: Check[]; rollback?: Rollback | null; rc?: number | null } = {}) {
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

const started = (t0: number) => event(t0, 1, 'deploy_start', t0, [ph('preflight', 'running', t0)])

/** Итог одним событием (накопленная сводка): консоль собирает карточку и без середины. */
function deployDone(t0: number, at: number, opts: { rc?: number; phases?: Phase[]; checks?: Check[]; rollback?: Rollback | null } = {}) {
  const phases = opts.phases ?? [
    ph('preflight', 'ok', t0),
    ph('prepare', 'ok', t0 + 5),
    ph('build', 'ok', t0 + 60),
    ph('rollback_prev', 'ok', at - 30),
    ph('cleanup', 'ok', at - 25),
    ph('nginx', 'ok', at - 20),
    ph('checks', 'ok', at - 10),
  ]
  return event(t0, 8, 'deploy_done', at, phases, {
    checks: opts.checks ?? [ck('api_ready', '/api/v1/health/ready', 'ok', at - 9), ck('spa', '/', 'ok', at - 8)],
    rollback: opts.rollback === undefined ? { changed: 3, failed: 0, stuck: 0 } : opts.rollback,
    rc: opts.rc ?? 0,
  })
}
const buildFailed = (t0: number, at: number, rc = 1) => deployDone(t0, at, { rc, phases: [ph('preflight', 'ok', t0), ph('build', 'failed', t0 + 60, rc)], checks: [], rollback: null })

async function send(body: unknown, agent = 'prod') {
  const res = await app.request(DEPLOY_EVENT_PATH, signedAgentRequest(agent, secrets[agent]!, body, { path: DEPLOY_EVENT_PATH }))
  expect(res.status, await res.clone().text()).toBe(200)
}

/** Запуск GitHub этого деплоя в таблице опроса: по нему карточка «подтверждена». */
async function githubRun(t0: number, status: 'in_progress' | 'completed', conclusion: string | null) {
  await getDb()
    .insert(deploys)
    .values({
      runKey: `run-${t0}`,
      workflow: WORKFLOW,
      status,
      conclusion,
      headSha: SHA.slice(0, 12),
      title: 'feat: деплой',
      url: `https://github.com/o/r/actions/runs/${t0}`,
      startedAt: new Date((t0 - 20) * 1000),
      finishedAt: status === 'completed' ? new Date() : null,
      createdAt: new Date(),
    })
}

const builtinRule = async (kind: (typeof alertRules.$inferSelect)['kind']) =>
  (await getDb().query.alertRules.findFirst({ where: and(eq(alertRules.kind, kind), eq(alertRules.builtin, true)) }))!
const lastAlert = (fingerprint: string) => getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, fingerprint), orderBy: desc(alerts.id) })
const facts = (row: { factsJson: string } | undefined) => new Map(JSON.parse(row?.factsJson ?? '[]') as Array<[string, string]>)

beforeAll(async () => {
  app = await freshApp()
  owner = api(app, await login(app))
  secrets.prod = (await owner.post('/admin/agents', { id: 'prod', name: 'Contabo · prod' })).json.secret
  secrets.stage = (await owner.post('/admin/agents', { id: 'stage', name: 'Stage' })).json.secret
})

beforeEach(async () => {
  const db = getDb()
  await db.delete(alerts)
  await db.delete(ruleStreaks)
  await db.delete(deployProgress)
  await db.delete(deploys)
})

describe('встроенные правила деплоя', () => {
  it('v5: «Деплой идёт слишком долго» (60 мин) и «Откат по rollback-prev недоступен» — warning; «Деплой упал» — critical', async () => {
    expect(await builtinRule('deploy_slow')).toMatchObject({ threshold: 60, severity: 'warning', forSamples: 1, enabled: true })
    expect(await builtinRule('deploy_rollback_prev')).toMatchObject({ severity: 'warning', forSamples: 1, enabled: true })
    expect(await builtinRule('deploy_failed')).toMatchObject({ name: 'Деплой упал', severity: 'critical' })
  })

  it('в работающей консоли «Деплой упал» warning → critical один раз; правленное владельцем не трогается', async () => {
    const db = getDb()
    const rule = await builtinRule('deploy_failed')
    const marker = 'builtin_upgrade_deploy_failed_critical'
    // Консоль до фазы 2: строка v1 с warning, отметки апгрейда нет.
    await db.update(alertRules).set({ severity: 'warning' }).where(eq(alertRules.id, rule.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect((await builtinRule('deploy_failed')).severity).toBe('critical')
    // Владелец вернул warning после апгрейда — отметка стоит, повторно не поднимаем.
    await db.update(alertRules).set({ severity: 'warning' }).where(eq(alertRules.id, rule.id))
    await ensureBuiltinRules()
    expect((await builtinRule('deploy_failed')).severity).toBe('warning')
    // Владелец переименовал правило ещё до апгрейда — его строку не трогаем.
    await db.update(alertRules).set({ name: 'Мой деплой' }).where(eq(alertRules.id, rule.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await db.query.alertRules.findFirst({ where: eq(alertRules.id, rule.id) })).toMatchObject({ name: 'Мой деплой', severity: 'warning' })
    await db.update(alertRules).set({ name: 'Деплой упал', severity: 'critical' }).where(eq(alertRules.id, rule.id))
  })
})

describe('итог деплоя (deploy_done) → алерты', () => {
  it('упавшая проверка: critical сразу, с фазой, проверкой и своим объектом; зелёный следующий деплой закрывает', async () => {
    const rule = await builtinRule('deploy_failed')
    const fp = deployEventFingerprint(rule.id, 'failed', 'prod')
    const t0 = nowSec() - 3000
    const at = t0 + 2500
    await send(
      deployDone(t0, at, {
        rc: 22,
        phases: [ph('preflight', 'ok', t0), ph('build', 'ok', t0 + 60), ph('nginx', 'ok', at - 20), ph('checks', 'failed', at - 10, 22)],
        checks: [ck('api_ready', '/api/v1/health/ready', 'ok', at - 9), ck('spa', '/', 'failed', at - 8, 22)],
      }),
    )
    const fired = await lastAlert(fp)
    expect(fired).toMatchObject({ status: 'firing', severity: 'critical', title: 'Проверка после деплоя не прошла', object: OBJECT, route: '/deploys' })
    expect(fired?.value).toBe('не отвечает: SPA — https://app.example.test/')
    const f = facts(fired)
    expect(f.get('Коммит')).toBe(SHA.slice(0, 7))
    expect(f.get('Код выхода')).toBe('22')
    expect(f.get('Упала фаза')).toBe('Проверки по публичным адресам (код 22)')
    expect(f.get('Не прошли проверки')).toBe('SPA — https://app.example.test/')
    expect(fired?.hint).toContain('Новая версия выкачена')

    const t1 = nowSec() - 600
    await send(deployDone(t1, t1 + 500))
    expect(await lastAlert(fp)).toMatchObject({ id: fired!.id, status: 'resolved' })
  })

  it('упала сборка: заголовок правила и подсказка про частичный выкат; прерванный (143) — «задачу остановили»', async () => {
    const rule = await builtinRule('deploy_failed')
    const fp = deployEventFingerprint(rule.id, 'failed', 'prod')
    const t0 = nowSec() - 4000
    await send(buildFailed(t0, t0 + 900))
    const built = await lastAlert(fp)
    expect(built).toMatchObject({ status: 'firing', title: 'Деплой упал', value: 'упала сборка, миграции или подъём стека (код 1)' })
    expect(facts(built).get('Упала фаза')).toBe('Сборка, миграции, подъём стека (код 1)')

    const t1 = nowSec() - 2000
    await send(buildFailed(t1, t1 + 300, 143))
    expect(await lastAlert(fp)).toMatchObject({ id: built!.id, status: 'firing', value: 'задачу остановили (код 143)' })
  })

  it('rollback-prev не поставлен: warning; деплой без итога rollback-prev алерт не трогает; полный — закрывает', async () => {
    const rule = await builtinRule('deploy_rollback_prev')
    const fp = deployEventFingerprint(rule.id, 'rollback', 'prod')
    const t0 = nowSec() - 5000
    await send(deployDone(t0, t0 + 2000, { rollback: { changed: 3, failed: 2, stuck: 0 } }))
    const fired = await lastAlert(fp)
    expect(fired).toMatchObject({ status: 'firing', severity: 'warning', object: OBJECT, value: '2 из 3 сменивших образ — без rollback-prev' })
    expect(facts(fired).get('Без rollback-prev')).toBe('2')

    // Упал до фазы rollback-prev: о закреплении ничего не известно.
    const t1 = nowSec() - 2500
    await send(deployDone(t1, t1 + 200, { rc: 1, phases: [ph('preflight', 'failed', t1, 1)], checks: [], rollback: null }))
    expect(await lastAlert(fp)).toMatchObject({ id: fired!.id, status: 'firing' })

    const t2 = nowSec() - 1200
    await send(deployDone(t2, t2 + 1000, { rollback: { changed: 2, failed: 0, stuck: 1 } }))
    expect(await lastAlert(fp)).toMatchObject({ id: fired!.id, status: 'resolved' })
  })
})

describe('границы доверия', () => {
  it('итог другого агента не закрывает алерт prod; события не закрывают алерт опроса GitHub', async () => {
    const rule = await builtinRule('deploy_failed')
    const prodFp = deployEventFingerprint(rule.id, 'failed', 'prod')
    const githubFp = deployFailedFingerprint(rule.id, WORKFLOW)
    await observe({ rule, fingerprint: githubFp, breached: true, title: rule.name, object: OBJECT })
    const t0 = nowSec() - 3000
    await send(buildFailed(t0, t0 + 600))
    expect(await lastAlert(prodFp)).toMatchObject({ status: 'firing' })

    const t1 = nowSec() - 1000
    await send(deployDone(t1, t1 + 500), 'stage')
    expect(await lastAlert(prodFp)).toMatchObject({ status: 'firing' })
    expect(await lastAlert(deployEventFingerprint(rule.id, 'failed', 'stage'))).toBeUndefined()

    const t2 = nowSec() - 500
    await send(deployDone(t2, t2 + 400))
    expect(await lastAlert(prodFp)).toMatchObject({ status: 'resolved' })
    // Алерт опроса GitHub закрывает только следующий успешный запуск GitHub.
    expect(await lastAlert(githubFp)).toMatchObject({ status: 'firing' })
  })

  it('fingerprint опроса GitHub — та же строка, что до фазы 2: горящие алерты опроса не становятся сиротами', () => {
    expect(deployFailedFingerprint(7, 'deploy-contabo.yml')).toBe('rule:7:deploy:deploy-contabo.yml')
  })
})

describe('деплой идёт слишком долго', () => {
  it('за порогом — warning с текущей фазой; итог закрывает; до порога — тишина', async () => {
    const rule = await builtinRule('deploy_slow')
    const fp = deployEventFingerprint(rule.id, 'slow', 'prod')
    const t0 = nowSec() - 30 * 60
    await send(started(t0))
    await send(event(t0, 3, 'build_start', t0 + 60, [ph('preflight', 'ok', t0), ph('build', 'running', t0 + 60)]))
    await evaluateDeploySlow()
    expect(await lastAlert(fp)).toBeUndefined()

    // Тот же деплой через 61 минуту от старта.
    await evaluateDeploySlow(Date.now() + 31 * 60_000)
    const fired = await lastAlert(fp)
    expect(fired).toMatchObject({ status: 'firing', severity: 'warning', object: OBJECT })
    expect(facts(fired).get('Фаза')).toMatch(/^Сборка, миграции, подъём стека, /)

    await send(deployDone(t0, nowSec()))
    await evaluateDeploySlow()
    expect(await lastAlert(fp)).toMatchObject({ id: fired!.id, status: 'resolved' })
  })

  it('деплой без событий дольше 150 мин («прервался») алерт не держит; новая карточка другого агента его не закрывает', async () => {
    const rule = await builtinRule('deploy_slow')
    const fp = deployEventFingerprint(rule.id, 'slow', 'prod')
    const t0 = nowSec() - 70 * 60
    await send(started(t0))
    await send(started(nowSec() - 60), 'stage')
    await evaluateDeploySlow()
    expect(await lastAlert(fp)).toMatchObject({ status: 'firing' })
    await evaluateDeploySlow(Date.now() + 151 * 60_000)
    expect(await lastAlert(fp)).toMatchObject({ status: 'resolved' })
  })

  it('горящий алерт агента без карточки за сутки (ретенция, удалён агент) закрывается', async () => {
    const rule = await builtinRule('deploy_slow')
    const fp = deployEventFingerprint(rule.id, 'slow', 'gone')
    await observe({ rule, fingerprint: fp, breached: true, title: rule.name, object: OBJECT })
    expect(await lastAlert(fp)).toMatchObject({ status: 'firing' })
    await evaluateDeploySlow()
    expect(await lastAlert(fp)).toMatchObject({ status: 'resolved', resolution: 'карточки деплоя больше нет' })
  })

  it('проводка: тик планировщика поднимает алерт (и лёгкий, из отчёта агента)', async () => {
    const rule = await builtinRule('deploy_slow')
    await send(started(nowSec() - 61 * 60))
    await runTick({ light: true })
    expect(await lastAlert(deployEventFingerprint(rule.id, 'slow', 'prod'))).toMatchObject({ status: 'firing' })
  })
})

describe('контекст для «Сайт недоступен»', () => {
  it('только с подтверждением запуском GitHub: идёт → «Идёт деплой»; зелёный в окне → «После деплоя»', async () => {
    const t0 = nowSec() - 600
    await send(started(t0))
    // Одних данных агента мало.
    expect(await deployContext()).toBeNull()
    await githubRun(t0, 'in_progress', null)
    expect((await deployContext())?.fact).toEqual(['Идёт деплой', `${SHA.slice(0, 7)}, 10 мин`])

    await send(deployDone(t0, nowSec() - 300))
    await getDb().update(deploys).set({ status: 'completed', conclusion: 'success', finishedAt: new Date() })
    const after = await deployContext()
    expect(after?.fact[0]).toBe('После деплоя')
    expect(after?.hint).toContain('регрессия')
    expect(await deployContext(Date.now() + AFTER_DEPLOY_WINDOW_MS)).toBeNull()

    // GitHub считает запуск неуспешным — не «зелёный деплой».
    await getDb().update(deploys).set({ conclusion: 'failure' })
    expect(await deployContext()).toBeNull()
  })

  it('проводка: алерт монитора получает факт и подсказку деплоя', async () => {
    const t0 = nowSec() - 900
    await send(started(t0))
    await githubRun(t0, 'in_progress', null)
    const id = (await owner.post('/monitors', { name: 'app', url: 'https://app.example.test/' })).json.monitor.id as number
    const m = (await getDb().query.monitors.findFirst({ where: eq(monitors.id, id) }))!
    try {
      await recordCheck(m, { ok: false, statusCode: 502, latencyMs: 5, error: 'HTTP 502' })
      await recordCheck(m, { ok: false, statusCode: 502, latencyMs: 5, error: 'HTTP 502' })
      const rule = await builtinRule('monitor_down')
      const fired = await lastAlert(`rule:${rule.id}:monitor:${id}`)
      expect(fired).toMatchObject({ status: 'firing' })
      expect(facts(fired).get('Идёт деплой')).toBe(`${SHA.slice(0, 7)}, 15 мин`)
      expect(fired?.hint).toMatch(/^Идёт деплой: /)
    } finally {
      await getDb().delete(monitors).where(eq(monitors.id, id))
    }
  })
})
