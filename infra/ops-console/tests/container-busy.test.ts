/**
 * «Занят ≠ завис» (s-diar-busy, 21.10): unhealthy пакетного сервиса из списка правила, который считает длинную
 * задачу, не поднимает алерт — только тихие отметки в ленте; unhealthy при простое, дольше 90 минут или у сервиса вне
 * списка — тревога, как раньше. Сквозь приём отчёта агента, на настоящей БД и webhook-приёмнике. Приёмка «Контроля»:
 * переразметка часовой записи — ни одного уведомления, искусственное зависание — алерт.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { activity, alertRules, alerts, ruleStreaks } from '../server/db/schema'
import { ensureBuiltinRules } from '../server/alerts/builtin'
import { writeMarker } from '../server/settings/store'
import { BUSY_GRACE_MS, BUSY_MAX_MS, BUSY_SETTLE_MS, batchServices, busyNow, isBatchService } from '../server/alerts/container-busy'
import { runTick } from '../server/scheduler/tick'
import { ruleCondition } from '../web/pages/AlertRules'

const events: Array<Record<string, unknown>> = []
const hook = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk: Buffer) => (body += chunk.toString()))
  req.on('end', () => {
    events.push(JSON.parse(body) as Record<string, unknown>)
    res.writeHead(204).end()
  })
})

let app: Awaited<ReturnType<typeof freshApp>>
let owner: ReturnType<typeof api>
let secret = ''

const ctr = (name: string, composeService: string, over: Record<string, unknown> = {}) => ({
  name,
  image: `${composeService}:1`,
  state: 'running',
  health: 'healthy',
  status: 'Up',
  restartCount: 0,
  composeService,
  restartPolicy: 'unless-stopped',
  ...over,
})
const diar = (over: Record<string, unknown> = {}) => ctr('backend-diarization-1', 'diarization', over)
const send = (containers: Array<Record<string, unknown>>) =>
  app.request('/api/agent/report', signedAgentRequest('prod', secret, report(containers)))
const times = async (n: number, c: Array<Record<string, unknown>>) => {
  for (let i = 0; i < n; i++) await send(c)
}
const firing = () => getDb().query.alerts.findMany({ where: eq(alerts.status, 'firing') })
/** Тихие отметки «занят ≠ завис» — без записей ленты о самих алертах. */
const marks = async () => (await getDb().query.activity.findMany()).map((m) => m.message).filter((m) => /^[🟡🟢]/u.test(m))
/** Здоровый замер, затем здоровье «устоялось» BUSY_SETTLE_MS — эпизод закрывается отметкой 🟢. */
const settleHealthy = async (c: Array<Record<string, unknown>>) => {
  await times(1, c)
  await ago('busyok', BUSY_SETTLE_MS + 1_000)
  await times(1, c)
}
const unhealthyRule = () => getDb().query.alertRules.findFirst({ where: and(eq(alertRules.builtin, true), eq(alertRules.kind, 'container_unhealthy')) })
/** Сдвинуть время строк эпизода назад — вместо ожидания в реальном времени. */
const ago = (prefix: 'busy' | 'busyfrom' | 'busyok', ms: number) =>
  getDb().update(ruleStreaks).set({ updatedAt: new Date(Date.now() - ms) }).where(like(ruleStreaks.fingerprint, `${prefix}:%`))

beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()))
  app = await freshApp()
  owner = api(app, await login(app))
  const general = (await owner.get('/settings')).json.general
  await owner.put('/settings/general', { ...general, privateEgressHosts: '127.0.0.1' })
  await owner.post('/channels', {
    kind: 'webhook',
    name: 'hook',
    config: { url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook` },
    secrets: { signingSecret: 'k-123456' },
  })
  secret = (await owner.post('/admin/agents', { id: 'prod', name: 'Contabo · prod' })).json.secret
})

afterAll(() => hook.close())

beforeEach(async () => {
  // Каждый сценарий — с чистого листа: здоровые контейнеры закрывают прошлое, следы эпизодов стёрты.
  await times(3, [diar(), ctr('backend-backend-1', 'backend')])
  await getDb().update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.status, 'firing'))
  await getDb().delete(ruleStreaks)
  await getDb().delete(activity)
  events.length = 0
})

describe('занят ≠ завис: пакетный сервис из списка правила', () => {
  it('переразметка: unhealthy, CPU 198% — ни алерта, ни уведомления; отметки в ленте — начало и итог', async () => {
    await times(12, [diar({ health: 'unhealthy', healthLog: 'curl: (28) Operation timed out', cpuPct: 198.4 })])
    expect(await firing()).toHaveLength(0)
    expect(events).toHaveLength(0)
    // Здоровые замеры эпизод сразу не закрывают: healthcheck может мигать на грани таймаута — ждём BUSY_SETTLE_MS.
    await times(2, [diar({ cpuPct: 0.5 })])
    expect((await marks()).filter((m) => m.startsWith('🟢'))).toEqual([])
    await settleHealthy([diar({ cpuPct: 0.5 })])
    expect(await marks()).toEqual([
      '🟡 backend-diarization-1 · Contabo · prod (diarization): healthcheck не отвечает, но контейнер занят (CPU 198%) — это не зависание, алерта нет',
      '🟢 backend-diarization-1 · Contabo · prod (diarization): healthcheck снова отвечает — был занят 0 мин, CPU до 198%',
    ])
    expect(events).toHaveLength(0)
  })

  it('задача кончилась, docker ещё держит unhealthy: CPU упал — запас BUSY_GRACE_MS, алерта нет', async () => {
    await times(3, [diar({ health: 'unhealthy', cpuPct: 150 })])
    await times(4, [diar({ health: 'unhealthy', cpuPct: 0.4 })])
    expect(await firing()).toHaveLength(0)
    await times(2, [diar({ cpuPct: 0.4 })])
    expect(events).toHaveLength(0)
  })

  it('зависание: unhealthy при простое дольше запаса — тревога, с выводом проверки', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 150 })])
    await ago('busy', BUSY_GRACE_MS + 1_000)
    await times(2, [diar({ health: 'unhealthy', healthLog: 'curl: (28) Operation timed out', cpuPct: 0.2 })])
    const fired = await firing()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ severity: 'critical', value: 'unhealthy: curl: (28) Operation timed out' })
    expect(events.map((e) => e.event)).toEqual(['firing'])
  })

  it('занят дольше 90 минут подряд — тревога «занят слишком долго»: зацикливание с CPU 100% не молчит', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    await ago('busyfrom', BUSY_MAX_MS + 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    const fired = await firing()
    expect(fired).toHaveLength(1)
    expect(fired[0]!.value).toBe('занят дольше 90 мин без ответа healthcheck (CPU до 100%)')
    expect(fired[0]!.hint).toMatch(/^Сервис 91 мин не отвечает на healthcheck при работающем CPU — возможно, зациклился\. Перезапуск прервёт/)
  })

  it('эпизод дольше 90 минут, а CPU только что упал — в запасе после занятости тоже тревога, не тишина', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    await ago('busyfrom', BUSY_MAX_MS + 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 1 })])
    const fired = await firing()
    expect(fired).toHaveLength(1)
    // Пик эпизода, а не последний замер: «занят» рядом с 1 % сбивал бы с толку.
    expect(fired[0]!.value).toBe('занят дольше 90 мин без ответа healthcheck (CPU до 100%)')
  })

  it('висел без нагрузки и пошёл в работу — алерт закрывается без заверения «не завис»: причину надо проверить', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 0 })])
    expect(await firing()).toHaveLength(1)
    const [hung] = await firing()
    await times(2, [diar({ health: 'unhealthy', cpuPct: 120 })])
    expect(await firing()).toHaveLength(0)
    // Из базы, а не из webhook: уведомление о восстановлении молчит, если алерт этого объекта «мигает» за час.
    const row = await getDb().query.alerts.findFirst({ where: eq(alerts.id, hung!.id) })
    expect(row).toMatchObject({
      status: 'resolved',
      resolution: 'контейнер снова занят (CPU 120%) — тревога снята; до этого он не отвечал при низком CPU, проверьте, что задача идёт',
    })
  })

  it('CPU неизвестен (docker stats не ответил) — как раньше: unhealthy тревожит', async () => {
    await times(2, [diar({ health: 'unhealthy' })])
    expect(await firing()).toHaveLength(1)
  })

  it('между задачами healthcheck прошёл — следующая задача начинает новый эпизод, а не продолжает старый', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 180 })])
    await ago('busyfrom', BUSY_MAX_MS - 60_000)
    await settleHealthy([diar({ cpuPct: 1 })])
    await times(2, [diar({ health: 'unhealthy', cpuPct: 180 })])
    expect(await firing()).toHaveLength(0)
    expect((await marks()).filter((m) => m.startsWith('🟡'))).toHaveLength(2)
  })

  it('низкий CPU внутри задачи (загрузка файла или модели) — до 10 минут тихо, а не P0 через 2 минуты', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 160 })])
    await ago('busy', 5 * 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 1 })])
    expect(await firing()).toHaveLength(0)
    expect(BUSY_GRACE_MS).toBe(10 * 60_000)
  })

  it('пропуски отчётов агента (хост придушен) не сбрасывают потолок 90 минут', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    await ago('busyfrom', BUSY_MAX_MS + 60_000)
    await ago('busy', 20 * 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    expect(await firing()).toHaveLength(1)
    expect((await marks()).filter((m) => m.startsWith('🟡'))).toHaveLength(1)
  })

  it('агент молчал дольше потолка — новый эпизод, а не тревога «занят слишком долго» по старому началу', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    await ago('busyfrom', 3 * BUSY_MAX_MS)
    await ago('busy', BUSY_MAX_MS + 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 100 })])
    expect(await firing()).toHaveLength(0)
    expect((await marks()).filter((m) => m.startsWith('🟡'))).toHaveLength(2)
  })

  it('healthcheck мигает на грани таймаута — одна задача, одна отметка, и потолок 90 минут не обнуляется', async () => {
    await times(2, [diar({ health: 'unhealthy', cpuPct: 150 })])
    await times(1, [diar({ cpuPct: 150 })])
    await times(2, [diar({ health: 'unhealthy', cpuPct: 150 })])
    await times(1, [diar({ cpuPct: 150 })])
    await times(1, [diar({ health: 'unhealthy', cpuPct: 150 })])
    expect(await marks()).toHaveLength(1)
    expect(await firing()).toHaveLength(0)
    // unhealthy обнуляет отсчёт устойчивого здоровья: старый первый здоровый замер эпизод не закроет.
    await ago('busyok', BUSY_SETTLE_MS + 1_000)
    await times(1, [diar({ cpuPct: 150 })])
    expect((await marks()).filter((m) => m.startsWith('🟢'))).toEqual([])
    await ago('busyfrom', BUSY_MAX_MS + 60_000)
    await times(2, [diar({ health: 'unhealthy', cpuPct: 150 })])
    expect(await firing()).toHaveLength(1)
  })
})

describe('занят ≠ завис: остальные сервисы и настройки правила', () => {
  it('backend вне списка: unhealthy при CPU 300% — авария (горячий цикл или заблокированный event loop), тревога', async () => {
    await times(2, [ctr('backend-backend-1', 'backend', { health: 'unhealthy', cpuPct: 300 })])
    const fired = await firing()
    expect(fired).toHaveLength(1)
    expect(fired[0]!.object).toBe('backend-backend-1 · Contabo · prod')
    expect(await marks()).toEqual([])
  })

  it('порог 0 или пустой список — занятость не учитывается (владелец может выключить)', async () => {
    const rule = (await unhealthyRule())!
    for (const off of [{ threshold: 0 }, { metric: null }]) {
      await getDb().update(alertRules).set(off).where(eq(alertRules.id, rule.id))
      try {
        await times(2, [diar({ health: 'unhealthy', cpuPct: 199 })])
        expect(await firing()).toHaveLength(1)
      } finally {
        await getDb().update(alertRules).set({ threshold: 20, metric: 'diarization,whisper' }).where(eq(alertRules.id, rule.id))
        await times(3, [diar()])
      }
    }
  })

  it('новая консоль: порог 20% и список сразу; работающая — один раз; правленое владельцем не трогается', async () => {
    const db = getDb()
    const rule = (await unhealthyRule())!
    expect(rule).toMatchObject({ threshold: 20, metric: 'diarization,whisper' })
    const marker = 'builtin_upgrade_unhealthy_busy_cpu'
    // Консоль до 22.10: строка v1 без порога и списка, отметки нет.
    await db.update(alertRules).set({ threshold: 0, metric: null }).where(eq(alertRules.id, rule.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await unhealthyRule()).toMatchObject({ threshold: 20, metric: 'diarization,whisper' })
    // Владелец поставил свой порог до апгрейда — строку не трогаем.
    await db.update(alertRules).set({ threshold: 50, metric: null }).where(eq(alertRules.id, rule.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await unhealthyRule()).toMatchObject({ threshold: 50, metric: null })
    // Владелец оставил порог, но свой список — тоже не трогаем.
    await db.update(alertRules).set({ threshold: 0, metric: 'diarization' }).where(eq(alertRules.id, rule.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await unhealthyRule()).toMatchObject({ threshold: 0, metric: 'diarization' })
    await db.update(alertRules).set({ threshold: 20, metric: 'diarization,whisper' }).where(eq(alertRules.id, rule.id))
  })

  it('список сервисов: compose-сервис, имя контейнера без compose; условие правила — человеческими словами', () => {
    const list = batchServices(' diarization, Whisper ,,')
    expect([...list]).toEqual(['diarization', 'whisper'])
    expect(isBatchService({ name: 'x', composeService: 'diarization' }, list)).toBe(true)
    expect(isBatchService({ name: 'backend-diarization-1', composeService: 'backend' }, list)).toBe(false)
    expect(isBatchService({ name: 'backend-whisper-1' }, list)).toBe(true)
    expect(isBatchService({ name: 'whisperer' }, list)).toBe(false)
    expect(isBatchService({ name: 'backend-diarization-1' }, new Set())).toBe(false)
    expect(ruleCondition({ kind: 'container_unhealthy', metric: 'diarization,whisper', op: 'gt', threshold: 20, forSamples: 2 }))
      .toBe('healthcheck не проходит, 2 раза подряд; у diarization, whisper — тревога, только если CPU ниже 20% (или неизвестен) либо тишина дольше 90 мин')
    expect(ruleCondition({ kind: 'container_unhealthy', metric: null, op: 'gt', threshold: 20, forSamples: 2 }))
      .toBe('healthcheck не проходит, 2 раза подряд')
    expect(busyNow(20, 20)).toBe(true)
    expect(busyNow(19.9, 20)).toBe(false)
    expect(busyNow(null, 20)).toBe(false)
    expect(busyNow(Number.NaN, 20)).toBe(false)
    expect(busyNow(300, 0)).toBe(false)
  })

  it('список с запятой проходит проверку API правила', async () => {
    const rule = (await unhealthyRule())!
    const res = await owner.patch(`/alerts/rules/${rule.id}`, { metric: 'diarization,whisper,stt' })
    expect(res.status).toBe(200)
    expect((await unhealthyRule())!.metric).toBe('diarization,whisper,stt')
    await getDb().update(alertRules).set({ metric: 'diarization,whisper' }).where(eq(alertRules.id, rule.id))
  })

  it('запятая у правила по метрике — опечатка, 400: такое правило молча не совпало бы ни с одной метрикой', async () => {
    const created = await owner.post('/alerts/rules', { name: 'CPU', kind: 'host_metric', metric: 'cpu_pct,', threshold: 90 })
    expect(created.status).toBe(400)
    const ok = await owner.post('/alerts/rules', { name: 'CPU', kind: 'host_metric', metric: 'cpu_pct', threshold: 90 })
    expect(ok.status).toBe(201)
    const patched = await owner.patch(`/alerts/rules/${ok.json.rule.id}`, { metric: 'cpu_pct,mem_pct' })
    expect(patched.status).toBe(400)
    await getDb().delete(alertRules).where(eq(alertRules.id, ok.json.rule.id as number))
  })

  it('ежедневная уборка убирает строки эпизодов старше суток и не трогает свежие и чужие', async () => {
    const db = getDb()
    const old = new Date(Date.now() - 25 * 3_600_000)
    await db.insert(ruleStreaks).values([
      { fingerprint: 'busy:rule:1:prod:gone-1', streak: 50, updatedAt: old },
      { fingerprint: 'busyfrom:rule:1:prod:gone-1', streak: 0, updatedAt: old },
      { fingerprint: 'busyok:rule:1:prod:gone-1', streak: 0, updatedAt: old },
      { fingerprint: 'busy:rule:1:prod:live-1', streak: 50, updatedAt: new Date() },
      { fingerprint: 'rule:1:prod:gone-1', streak: 3, updatedAt: old },
    ])
    // Через ежедневную уборку планировщика, а не прямым вызовом: проверяется и то, что уборка её зовёт.
    await writeMarker('cleanup', 0)
    await runTick()
    const left = (await db.query.ruleStreaks.findMany()).map((r) => r.fingerprint).sort()
    expect(left).toEqual(['busy:rule:1:prod:live-1', 'rule:1:prod:gone-1'])
  })
})
