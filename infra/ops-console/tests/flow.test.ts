/**
 * Сквозной сценарий консоли на настоящей БД (временный файл SQLite): вход → агент → отчёты →
 * алерт и инцидент → перезапуск через очередь команд → восстановление → отчёт ИИ-совету.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { eq, like } from 'drizzle-orm'
import { getDb } from '../server/db/client'
import { commands as commandsTable, metricSamples } from '../server/db/schema'
import { runTick } from '../server/scheduler/tick'
import { writeMarker } from '../server/settings/store'
import { ensureBuiltinRules } from '../server/alerts/builtin'

type App = Awaited<ReturnType<typeof freshApp>>

const received: Array<{ headers: IncomingHttpHeaders; body: string }> = []
const hook = createServer((req, res) => {
  let body = ''
  req.on('data', (c: Buffer) => (body += c.toString()))
  req.on('end', () => {
    received.push({ headers: req.headers, body })
    res.writeHead(204).end()
  })
})

let app: App
let owner: ReturnType<typeof api>
let agentSecret = ''
let hookUrl = ''

const ctr = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  image: `${name}:latest`,
  state: 'running',
  health: 'healthy',
  status: 'Up 1 hour',
  restartCount: 0,
  composeService: name,
  restartPolicy: 'unless-stopped',
  ...over,
})

const send = (body: unknown, ts?: number) => app.request('/api/agent/report', signedAgentRequest('main-vps', agentSecret, body, { ts }))

beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()))
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`
  app = await freshApp()
  owner = api(app, await login(app))
})

afterAll(() => hook.close())

describe('доступ', () => {
  it('без сессии API закрыт, без CSRF-заголовка изменения запрещены', async () => {
    expect((await app.request('/api/overview')).status).toBe(401)
    const cookie = await login(app)
    const res = await app.request('/api/incidents', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('неверный пароль — 401, после 5 ошибок — 429', async () => {
    const bad = () =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@ops.test', password: 'nope' }),
      })
    for (let i = 0; i < 5; i += 1) expect((await bad()).status).toBe(401)
    expect((await bad()).status).toBe(429)
  })
})

describe('агент, алерты, перезапуск', () => {
  it('владелец заводит webhook-канал и агента; секрет показывается один раз', async () => {
    // Приёмник теста — на 127.0.0.1: без явного разрешения владельца консоль туда не ходит (SSRF).
    const general = (await owner.get('/settings')).json.general
    expect((await owner.put('/settings/general', { ...general, privateEgressHosts: '127.0.0.1' })).status).toBe(200)
    const ch = await owner.post('/channels', {
      kind: 'webhook',
      name: 'Дежурный webhook',
      config: { url: hookUrl },
      secrets: { signingSecret: 'hook-secret-123' },
    })
    expect(ch.status).toBe(201)
    expect(JSON.stringify(ch.json)).not.toContain('hook-secret-123')

    const created = await owner.post('/admin/agents', { id: 'main-vps', name: 'main-vps', environment: 'production' })
    expect(created.status).toBe(201)
    agentSecret = created.json.secret
    expect(created.json.env).toContain('OPS_AGENT_SECRET=hrhops_')
    const list = await owner.get('/admin/agents')
    expect(JSON.stringify(list.json)).not.toContain(agentSecret)
  })

  it('подпись агента: чужой секрет — 401, повтор метки времени — 409', async () => {
    const body = report([ctr('backend')])
    const forged = signedAgentRequest('main-vps', 'wrong-secret', body)
    expect((await app.request('/api/agent/report', forged)).status).toBe(401)
    const ts = Date.now() + 10
    expect((await send(body, ts)).status).toBe(200)
    expect((await send(body, ts)).status).toBe(409)
  })

  it('упавший контейнер → алерт после 2 отчётов → инцидент → подписанный webhook', async () => {
    const containers = [
      ctr('backend'),
      ctr('postgres'),
      ctr('worker', { state: 'exited', health: 'none', exitCode: 1, status: 'Exited (1)' }),
    ]
    expect((await send(report(containers))).status).toBe(200)
    let firing = await owner.get('/alerts?status=firing')
    expect(firing.json.alerts.filter((a: any) => a.object.startsWith('worker'))).toHaveLength(0)

    expect((await send(report(containers))).status).toBe(200)
    firing = await owner.get('/alerts?status=firing')
    const alert = firing.json.alerts.find((a: any) => a.object === 'worker · main-vps')
    expect(alert).toMatchObject({ severity: 'critical', title: 'Контейнер остановлен' })
    expect(alert.incidentId).toBeTruthy()

    const delivered = received.find((r) => r.body.includes('"event":"firing"'))
    expect(delivered).toBeTruthy()
    const ts = String(delivered?.headers['x-ops-timestamp'])
    const expected = `sha256=${createHmac('sha256', 'hook-secret-123').update(`${ts}.${delivered?.body}`).digest('hex')}`
    const got = String(delivered?.headers['x-ops-signature'])
    expect(got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))).toBe(true)
  })

  it('stateful-контейнер перезапускается только с вводом имени; есть очередь и cooldown', async () => {
    const pg = await owner.post('/infra/agents/main-vps/containers/postgres/restart', { reason: 'проверка' })
    expect(pg.status).toBe(422)
    const pgOk = await owner.post('/infra/agents/main-vps/containers/postgres/restart', { reason: 'проверка', confirmName: 'postgres' })
    expect(pgOk.status).toBe(202)

    const w = await owner.post('/infra/agents/main-vps/containers/worker/restart', { reason: 'упал с кодом 1' })
    expect(w.status).toBe(202)
    expect((await owner.post('/infra/agents/main-vps/containers/worker/restart', { reason: 'ещё раз' })).status).toBe(409)

    const res = await send(report([ctr('backend'), ctr('postgres'), ctr('worker', { state: 'exited', exitCode: 1 })]))
    const body = (await res.json()) as { commands: Array<{ id: number; target: string }> }
    expect(body.commands.map((c) => c.target).sort()).toEqual(['postgres', 'worker'])

    const results = body.commands.map((c) => ({ id: c.id, status: 'succeeded', output: 'restarted' }))
    await send(report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })], { commandResults: results }))
    const cmds = await owner.get('/infra/commands')
    expect(cmds.json.commands.filter((c: any) => c.status === 'succeeded')).toHaveLength(2)
    expect((await owner.post('/infra/agents/main-vps/containers/worker/restart', { reason: 'снова' })).status).toBe(429)
  })

  it('восстановление закрывает алерт и инцидент', async () => {
    const healthy = report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })])
    await send(healthy)
    await send(healthy)
    const firing = await owner.get('/alerts?status=firing')
    expect(firing.json.alerts.find((a: any) => a.object === 'worker · main-vps')).toBeUndefined()
    const incidents = await owner.get('/incidents?status=all')
    expect(incidents.json.incidents[0].status).toBe('resolved')
    const detail = await owner.get(`/incidents/${incidents.json.incidents[0].id}`)
    const kinds = detail.json.events.map((e: any) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['opened', 'alert', 'action', 'resolved']))
  })

  it('пока агент перезапускает контейнер по команде, «контейнер остановлен» не стреляет', async () => {
    expect((await owner.post('/infra/agents/main-vps/containers/backend/restart', { reason: 'плановый перезапуск' })).status).toBe(202)
    const res = await send(report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]))
    const { commands } = (await res.json()) as { commands: Array<{ id: number; target: string }> }
    expect(commands.map((c) => c.target)).toEqual(['backend'])
    const stopped = [ctr('backend', { state: 'exited', exitCode: 137 }), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    await send(report(stopped))
    await send(report(stopped))
    let firing = await owner.get('/alerts?status=firing')
    expect(firing.json.alerts.find((a: any) => a.object === 'backend · main-vps')).toBeUndefined()

    // Команда завершилась, а контейнер так и не поднялся — теперь это авария.
    await send(report(stopped, { commandResults: [{ id: commands[0]!.id, status: 'succeeded', output: 'restarted' }] }))
    await send(report(stopped))
    firing = await owner.get('/alerts?status=firing')
    expect(firing.json.alerts.find((a: any) => a.object === 'backend · main-vps')).toMatchObject({ title: 'Контейнер остановлен' })
    await send(report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]))
  })

  it('health=starting не меняет unhealthy-алерт; закрытие — после 2 нормальных отчётов подряд', async () => {
    const sick = [ctr('backend', { health: 'unhealthy' }), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    await send(report(sick))
    await send(report(sick))
    const before = (await owner.get('/alerts?status=firing')).json.alerts.find(
      (a: any) => a.title === 'Контейнер unhealthy' && a.object === 'backend · main-vps',
    )
    expect(before).toBeTruthy()
    await send(report([ctr('backend', { health: 'starting' }), ctr('postgres'), ctr('worker', { restartCount: 1 })]))
    const during = (await owner.get('/alerts?status=firing')).json.alerts.find((a: any) => a.id === before.id)
    expect(during).toBeTruthy()
    const healthy = report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })])
    await send(healthy)
    // Один нормальный отчёт — ещё не восстановление: правило «2 подряд» работает в обе стороны.
    expect((await owner.get('/alerts?status=firing')).json.alerts.find((a: any) => a.id === before.id)).toBeTruthy()
    await send(healthy)
    expect((await owner.get('/alerts?status=firing')).json.alerts.find((a: any) => a.id === before.id)).toBeUndefined()
  })

  it('команда, которую агент забрал, но не подтвердил, истекает через 10 минут и не блокирует новые перезапуски', async () => {
    const base = report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 }), ctr('cache')])
    await send(base)
    expect((await owner.post('/infra/agents/main-vps/containers/cache/restart', { reason: 'ответ потеряется' })).status).toBe(202)
    const res = await send(base)
    const { commands } = (await res.json()) as { commands: Array<{ id: number; target: string }> }
    expect(commands.map((c) => c.target)).toEqual(['cache'])
    // Ответ консоли до агента не дошёл: команда «в работе», повторный перезапуск заблокирован.
    expect((await owner.post('/infra/agents/main-vps/containers/cache/restart', { reason: 'ещё раз' })).status).toBe(409)
    await getDb()
      .update(commandsTable)
      .set({ claimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(commandsTable.id, commands[0]!.id))
    await send(base)
    const list = await owner.get('/infra/commands')
    expect(list.json.commands.find((c: any) => c.id === commands[0]!.id)).toMatchObject({ status: 'expired' })
    expect((await owner.post('/infra/agents/main-vps/containers/cache/restart', { reason: 'после истечения' })).status).toBe(202)
  })

  it('попутный тик из отчёта агента — лёгкий: без GitHub, TLS, ретенции, дайджеста и отчёта', async () => {
    const tick = await runTick({ light: true })
    expect(tick.ran).toBe(true)
    // «Деплой идёт долго» — только БД, без внешних API: ему место и в лёгком тике.
    expect(Object.keys(tick.tasks).sort()).toEqual(['agents', 'checks', 'deploySlow', 'flaps', 'heartbeat'])
  })

  it('docker не отвечает агенту: контейнерные алерты заморожены, после 4 отчётов — «Docker не отвечает»', async () => {
    await ensureBuiltinRules()
    const rules = (await owner.get('/alerts/rules')).json.rules.filter((r: any) => r.name === 'Docker не отвечает')
    expect(rules).toHaveLength(1)

    const hung = report([], { containers: undefined, dockerError: 'docker CLI не отвечает (последний ответ 45 с назад)' })
    for (let i = 0; i < 4; i += 1) await send(hung)
    const firing = (await owner.get('/alerts?status=firing')).json.alerts
    expect(firing.find((a: any) => a.title === 'Docker не отвечает' && a.object === 'main-vps')).toBeTruthy()
    // Состав контейнеров неизвестен: по отчётам без контейнеров новых контейнерных алертов не появляется.
    expect(firing.filter((a: any) => a.object.endsWith(' · main-vps'))).toHaveLength(0)

    const healthy = report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })])
    for (let i = 0; i < 4; i += 1) await send(healthy)
    expect((await owner.get('/alerts?status=firing')).json.alerts.find((a: any) => a.title === 'Docker не отвечает')).toBeUndefined()
  })

  it('P0: правила бизнес-метрик считают замеры, а не отчёты; объект — подсистема; разрыв обнуляет серии', async () => {
    await ensureBuiltinRules()
    const healthy = [ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    let at = 1_800_000_000
    // Один замер агент повторяет в каждом отчёте (раз в 15 с), пока не посчитает следующий.
    const measure = async (business: Record<string, number>, businessFailed: string[] = [], reports = 2) => {
      at += 300
      for (let i = 0; i < reports; i += 1) await send(report(healthy, { business, businessAt: at, businessFailed }))
    }
    const firing = async () => (await owner.get('/alerts?status=firing')).json.alerts as any[]
    const find = async (title: string) => (await firing()).find((a) => a.title === title)
    const STUCK = 'STT: записи застряли в обработке'
    const STORM = 'Telegram: шторм выселений сессий'
    const BROKEN = 'Бизнес-метрики не считаются'

    // Застрявшая запись — critical с первого замера, объект — подсистема (инцидент не смешается с диском сервера).
    // Шторм выселений (2 замера) не поднимается от первого замера, сколько бы отчётов его ни повторило.
    await measure({ stt_stuck: 1, tg_evictions_1h: 40 }, [], 25)
    expect((await find(STUCK))?.object).toBe('STT · main-vps')
    expect(await find(STORM)).toBeUndefined()

    await measure({ stt_stuck: 0, tg_evictions_1h: 40 })
    const storm = await find(STORM)
    expect(storm?.object).toBe('Telegram · main-vps')
    expect(JSON.stringify(storm.facts)).toContain('2 замера подряд')
    expect(await find(STUCK)).toBeUndefined() // порог в 1 замер — и закрытие с первого нормального замера

    // Закрытие: один нормальный замер (в нескольких отчётах), затем пропуск метрики, затем нормальный — всё ещё
    // горит: разрыв обнуляет и серию «в норме». Второй нормальный подряд закрывает.
    await measure({ stt_stuck: 0, tg_evictions_1h: 0 }, [], 3)
    expect(await find(STORM)).toBeTruthy()
    await measure({ stt_stuck: 0 }, ['tg_evictions_1h'])
    await measure({ stt_stuck: 0, tg_evictions_1h: 0 })
    expect(await find(STORM)).toBeTruthy()
    await measure({ stt_stuck: 0, tg_evictions_1h: 0 })
    expect(await find(STORM)).toBeUndefined()

    // Порог до и после пропуска — это не «2 замера подряд»: серия начинается заново.
    await measure({ stt_stuck: 0, tg_evictions_1h: 40 })
    await measure({ stt_stuck: 0 }, ['tg_evictions_1h'])
    await measure({ stt_stuck: 0, tg_evictions_1h: 40 })
    expect(await find(STORM)).toBeUndefined()
    await measure({ stt_stuck: 0, tg_evictions_1h: 40 })
    expect(await find(STORM)).toBeTruthy()

    // Скрипт падает: «Бизнес-метрики не считаются» со второго замера, в фактах — какие команды.
    await measure({ tg_evictions_1h: 0 }, ['stt_failed_1h', 'stt_stuck'])
    await measure({ tg_evictions_1h: 0 }, ['stt_failed_1h', 'stt_stuck', 'tg_api_5xx_pct'])
    const broken = await find(BROKEN)
    expect(broken?.object).toBe('main-vps')
    expect(JSON.stringify(broken.facts)).toContain('stt_failed_1h, stt_stuck, tg_api_5xx_pct')
    await measure({ tg_evictions_1h: 0, stt_stuck: 0 })
    await measure({ tg_evictions_1h: 0, stt_stuck: 0 })
    expect((await firing()).filter((a) => [STUCK, STORM, BROKEN].includes(a.title))).toHaveLength(0)
  })

  it('P0: сбой распознавания будит, только если держится дольше часа (13 замеров), а не от одиночного сбоя', async () => {
    const healthy = [ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    let at = 1_900_000_000
    const measure = async (business: Record<string, number>) => {
      at += 300
      await send(report(healthy, { business, businessAt: at, businessFailed: [] }))
    }
    const firing = async () => ((await owner.get('/alerts?status=firing')).json.alerts as any[]).map((a) => a.title)
    // Один сбой держится в окне «за час» 12 замеров — это не повод будить.
    for (let i = 0; i < 12; i += 1) await measure({ stt_failed_1h: 1 })
    expect(await firing()).not.toContain('STT: сбои распознавания за час')
    await measure({ stt_failed_1h: 1 })
    expect(await firing()).toContain('STT: сбои распознавания за час')
    for (let i = 0; i < 13; i += 1) await measure({ stt_failed_1h: 0 })
    expect(await firing()).not.toContain('STT: сбои распознавания за час')
  })

  it('P0: критичные алерты разных подсистем — разные инциденты, отдельно от диска сервера', async () => {
    const at = 2_000_000_000
    const full = report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })], {
      disks: [{ mount: '/', totalGb: 100, usedGb: 97 }],
      business: { hf_refresh_rejected: 1, stt_stuck: 1 },
      businessAt: at,
      businessFailed: [],
    })
    await send(full)
    const open = (await owner.get('/incidents?status=open')).json.incidents as any[]
    const titles = open.map((i) => i.title)
    expect(titles).toContain('Huntflow: сервис отклонил токен, нужен вход: Huntflow · main-vps')
    expect(titles).toContain('STT: записи застряли в обработке: STT · main-vps')
    expect(titles.some((t) => t.startsWith('Диск заполнен > 95%: main-vps'))).toBe(true)
    // Уборка: нормальный замер и диск закрывают свои алерты.
    await send(report([ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })], {
      business: { hf_refresh_rejected: 0, stt_stuck: 0 },
      businessAt: at + 300,
      businessFailed: [],
    }))
  })

  it('нехватка памяти в контейнере: точка отсчёта, приросты за 10 мин — алерт и событие, окно прошло — закрытие', async () => {
    await ensureBuiltinRules()
    const oo = (oomKills: number | undefined, over: Record<string, unknown> = {}) =>
      ctr('onlyoffice', { memMb: 300, memLimitMb: 4096, memPeakMb: 2300, swapPeakMb: 1200, oomKills, oomVictims: 'pluginsmanager ×4', ...over })
    const others = [ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    const title = 'Нехватка памяти в контейнере'
    const firing = async () => ((await owner.get('/alerts?status=firing')).json.alerts as any[]).find((a) => a.title === title)

    // Старые 4 случая (18.10, до учёта) — точка отсчёта: ни алерта, ни события.
    await send(report([...others, oo(4)]))
    await send(report([...others, oo(4)]))
    expect(await firing()).toBeUndefined()

    // Ядро убило главный процесс: контейнер перезапустился (новый startedAt), итог по журналу вырос на 1.
    await send(report([...others, oo(5, { startedAt: '2026-10-20T09:00:00Z' })]))
    const alert = await firing()
    expect(alert?.object).toBe('onlyoffice · main-vps')
    expect(alert?.value).toContain('ядро убило 1 за 10 мин')
    const facts = JSON.stringify(alert.facts)
    for (const f of ['Пик памяти с запуска', 'Пик swap с запуска', 'Убито ядром (OOM), всего', 'pluginsmanager ×4']) expect(facts).toContain(f)
    const events = (await owner.get('/events/activity')).json
    expect(JSON.stringify(events)).toContain(
      'onlyoffice · main-vps: ядро убило 1 процесс по нехватке памяти (всего у контейнера — 5; пик памяти 2.2 ГБ из 4.0 ГБ; swap 1.2 ГБ; за 3 сут.: pluginsmanager ×4)',
    )

    // Приросты в окне суммируются: ещё 3 — всего 4.
    await send(report([...others, oo(8)]))
    expect((await firing())?.value).toContain('ядро убило 4 за 10 мин')
    // Пересоздан (новый id, итог с нуля) — не «убито»; дальше счёт от новой точки: +2.
    await send(report([...others, oo(0)]))
    await send(report([...others, oo(2)]))
    expect((await firing())?.value).toContain('ядро убило 6 за 10 мин')

    // Окно прошло, а в отчёте нет итога (агент старше 1.4 или учёт выключен) — алерт закрывается, а не висит.
    await getDb()
      .update(metricSamples)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(like(metricSamples.metric, 'oomnew:%'))
    await send(report([...others, oo(undefined)]))
    expect(await firing()).toBeUndefined()
  })

  it('перезапуск по кругу после месяца тишины: последний замер счётчика переживает срок хранения истории', async () => {
    await ensureBuiltinRules()
    const others = [ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    const loop = (restartCount: number) => ctr('loop', { restartCount })
    const firing = async () =>
      ((await owner.get('/alerts?status=firing')).json.alerts as any[]).find(
        (a) => a.title === 'Перезапуски контейнера (restart loop)' && a.object === 'loop · main-vps',
      )
    await send(report([...others, loop(5)]))
    const old = new Date(Date.now() - 40 * 86_400_000)
    await getDb().update(metricSamples).set({ createdAt: old }).where(eq(metricSamples.metric, 'restarts:loop'))
    await writeMarker('cleanup', 0)
    await runTick()
    const kept = await getDb().select().from(metricSamples).where(eq(metricSamples.metric, 'restarts:loop'))
    expect(kept.map((r) => r.value)).toEqual([5])
    for (const n of [6, 7, 8]) await send(report([...others, loop(n)]))
    expect((await firing())?.value).toContain('3 перезапусков демоном за 10 мин')
    await send(report([...others]))
  })

  it('агент до 1.3 (без времени замера): P0 не оценивается, своё правило владельца по biz_* считает отчёты', async () => {
    const healthy = [ctr('backend'), ctr('postgres'), ctr('worker', { restartCount: 1 })]
    const created = await owner.post('/alerts/rules', {
      name: 'Компаний меньше 2',
      kind: 'host_metric',
      metric: 'biz_companies',
      op: 'lt',
      threshold: 2,
      forSamples: 2,
      severity: 'warning',
    })
    expect(created.status).toBe(201)
    const legacy = report(healthy, { agentVersion: '1.2.1', business: { companies: 1, stt_stuck: 3, tg_api_5xx_pct: 50 } })
    for (let i = 0; i < 3; i += 1) await send(legacy)
    const titles = ((await owner.get('/alerts?status=firing')).json.alerts as any[]).map((a) => a.title)
    expect(titles).toContain('Компаний меньше 2')
    expect(titles).not.toContain('STT: записи застряли в обработке')
    expect(titles).not.toContain('Telegram: ошибки API больше 5% (кроме 503)')
  })

  it('секрет канала не переносится на новый адрес', async () => {
    const created = await owner.post('/channels', {
      kind: 'email',
      name: 'Почта дежурных',
      config: { host: 'smtp.example.com', port: 587, user: 'ops@example.com', to: 'oncall@example.com' },
      secrets: { password: 'smtp-pass-1' },
    })
    expect(created.status).toBe(201)
    const id = created.json.channel.id
    // Меняем только получателей — пароль остаётся.
    expect(
      (
        await owner.patch(`/channels/${id}`, {
          config: { host: 'smtp.example.com', port: 587, user: 'ops@example.com', to: 'team@example.com' },
        })
      ).status,
    ).toBe(200)
    expect((await owner.get('/channels')).json.channels.find((c: any) => c.id === id).secretMasks.password).toBe('••••ss-1')
    // Новый SMTP-хост без нового пароля — отказ; с паролем — можно.
    const moved = { host: 'smtp.attacker.example', port: 587, user: 'ops@example.com', to: 'team@example.com' }
    expect((await owner.patch(`/channels/${id}`, { config: moved })).status).toBe(400)
    expect((await owner.patch(`/channels/${id}`, { config: moved, secrets: { password: 'smtp-pass-2' } })).status).toBe(200)
    expect((await owner.get('/channels')).json.channels.find((c: any) => c.id === id).secretMasks.password).toBe('••••ss-2')

    // То же для приёмника отчётов ИИ-совету.
    const base = { enabled: false, period: 'daily', hourUtc: 6 }
    expect(
      (await owner.put('/settings/reports', { ...base, destinationUrl: 'https://council.example.com/in', secret: 'report-key-1' })).status,
    ).toBe(200)
    expect((await owner.put('/settings/reports', { ...base, destinationUrl: 'https://other.example.com/in' })).status).toBe(400)
    expect((await owner.put('/settings/reports', { ...base, destinationUrl: 'https://council.example.com/in' })).status).toBe(200)
    // Убираем приёмник: дальше сценарий проверяет отчёт без него.
    expect((await owner.put('/settings/reports', { ...base, destinationUrl: '', clearSecret: true })).status).toBe(200)
  })

  it('наблюдатель видит, но не перезапускает', async () => {
    expect((await owner.post('/admin/users', { email: 'viewer@ops.test', role: 'viewer', password: 'viewer-password-1' })).status).toBe(201)
    const viewer = api(app, await login(app, 'viewer@ops.test', 'viewer-password-1'))
    expect((await viewer.get('/overview')).status).toBe(200)
    expect((await viewer.post('/infra/agents/main-vps/containers/backend/restart', { reason: 'хочу' })).status).toBe(403)
    expect((await viewer.get('/admin/users')).status).toBe(403)
  })

  it('отчёт ИИ-совету содержит перезапуски и не уходит без приёмника', async () => {
    const preview = await owner.post('/reports/preview', { period: 'daily' })
    expect(preview.json.report.schema).toBe('hrh.ops.report/v1')
    expect([...new Set(preview.json.report.restarts.map((r: any) => r.container))].sort()).toEqual([
      'backend',
      'cache',
      'postgres',
      'worker',
    ])
    const sent = await owner.post('/reports/send', { period: 'daily' })
    expect(sent.json.status).toBe('not_configured')
  })

  it('нельзя лишить консоль последнего владельца', async () => {
    const users = await owner.get('/admin/users')
    const me = users.json.users.find((u: any) => u.role === 'owner')
    expect((await owner.patch(`/admin/users/${me.id}`, { role: 'viewer' })).status).toBe(409)
  })
})
