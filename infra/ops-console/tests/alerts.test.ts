/**
 * Информативность и шум алертов: формат сообщения, объяснения причин, мигание, ручное
 * закрытие. Сквозная часть — на настоящей БД с webhook-приёмником (структурный payload).
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { alerts } from '../server/db/schema'
import { notifyStableFlaps } from '../server/alerts/store'
import { alertHtml, alertSubject, alertText, type AlertMessage } from '../server/notify/format'
import { explainCheckFailure, explainExit, explainUnhealthy, topConsumers, type ContainerView } from '../server/alerts/explain'
import { silenceVerdict, lastStateLine } from '../server/agents/silence'
import { clock, humanDuration } from '../server/lib/time'

const base: AlertMessage = {
  event: 'firing',
  alertId: 7,
  severity: 'critical',
  title: 'Агент сервера молчит',
  object: 'Contabo · prod',
  value: 'нет отчётов 3 мин',
  detail: '',
  facts: [
    ['Последний отчёт', '15:02:41'],
    ['Внешние проверки', '5/5 отвечают'],
  ],
  hint: 'Сайты отвечают — прод работает <проверьте агента>',
  links: [['Запуск в GitHub', 'https://github.com/acme/app/actions/runs/1?a=1&b=2']],
  link: 'https://ops.example.com/infrastructure/prod',
  startedAt: Date.UTC(2026, 9, 7, 12, 3),
  resolvedAt: null,
  resolution: '',
  closedBy: null,
  incidentId: 12,
  timeZone: 'Europe/Minsk',
  now: Date.UTC(2026, 9, 7, 12, 6),
}

describe('формат уведомления', () => {
  it('срабатывание: заголовок с важностью, сводка, факты, подсказка, время в поясе консоли, ссылки', () => {
    const html = alertHtml(base)
    expect(html).toContain('🔴 <b>КРИТИЧНО · Агент сервера молчит</b>')
    expect(html).toContain('<b>Contabo · prod</b> — нет отчётов 3 мин')
    expect(html).toContain('• Внешние проверки: <b>5/5 отвечают</b>')
    expect(html).toContain('💡 Сайты отвечают — прод работает &lt;проверьте агента&gt;')
    expect(html).toContain('🕒 с 15:03 · инцидент #12') // 12:03 UTC = 15:03 Minsk
    expect(html).toContain('<a href="https://ops.example.com/infrastructure/prod">Открыть в консоли</a>')
    expect(html).toContain('<a href="https://github.com/acme/app/actions/runs/1?a=1&amp;b=2">Запуск в GitHub</a>')
    expect(alertText(base)).toContain('Что сделать: Сайты отвечают')
  })

  it('восстановление: свежее описание и длительность, без устаревших фактов и подсказки', () => {
    const m: AlertMessage = {
      ...base,
      event: 'resolved',
      resolvedAt: Date.UTC(2026, 9, 7, 12, 8),
      resolution: 'снова на связи, отчёт 15:08:12',
    }
    const html = alertHtml(m)
    expect(html.startsWith('🔴 <b>КРИТИЧНО · Агент сервера молчит</b>\n')).toBe(true)
    expect(html).toContain('🟢 <b>ВОССТАНОВЛЕНО</b> · <b>Contabo · prod</b> — снова на связи')
    expect(alertSubject(m)).toBe('🟢 ВОССТАНОВЛЕНО (🔴 критично): Агент сервера молчит — Contabo · prod')
    expect(html).toContain('— снова на связи, отчёт 15:08:12')
    expect(html).toContain('⏱ длилось 5 мин (15:03 → 15:08)')
    expect(html).not.toContain('💡')
    expect(html).not.toContain('нет отчётов 3 мин')
  })

  it('срабатывание с видом: иконка вида в заголовке и теме', () => {
    const m: AlertMessage = { ...base, kind: 'agent_silent' }
    expect(alertHtml(m).startsWith('🔴 <b>КРИТИЧНО · 📡 Агент сервера молчит</b>\n')).toBe(true)
    expect(alertSubject(m)).toBe('🔴 КРИТИЧНО: 📡 Агент сервера молчит — Contabo · prod')
  })

  it('итог алерта с видом: уровень первым, иконка вида сохраняется в заголовке и теме', () => {
    const m: AlertMessage = { ...base, kind: 'monitor_down', event: 'resolved', resolvedAt: Date.UTC(2026, 9, 7, 12, 8), resolution: 'снова отвечает' }
    expect(alertHtml(m).startsWith('🔴 <b>КРИТИЧНО · 🌐 Агент сервера молчит</b>\n')).toBe(true)
    expect(alertSubject(m)).toBe('🟢 ВОССТАНОВЛЕНО (🔴 критично): 🌐 Агент сервера молчит — Contabo · prod')
  })

  it('ручное закрытие не называется восстановлением', () => {
    const html = alertHtml({ ...base, event: 'closed', closedBy: 'owner@ops.local', resolvedAt: Date.UTC(2026, 9, 7, 12, 10) })
    expect(html).toContain('⚪️ <b>ЗАКРЫТ ВРУЧНУЮ')
    expect(html).toContain('— закрыто: owner@ops.local')
    expect(html).toContain('откроется снова')
    expect(html).not.toContain('ВОССТАНОВЛЕНО')
  })

  it('мигание и «стабильно»', () => {
    expect(alertHtml({ ...base, event: 'flapping', flapCount: 4 })).toContain(
      '4-й сбой за час — сообщения о каждом сбое приостановлены на 30 мин',
    )
    const stable = alertHtml({ ...base, event: 'stable', flapCount: 5, quietMin: 16 })
    expect(stable.startsWith('🔴 <b>КРИТИЧНО · Агент сервера молчит</b>\n')).toBe(true)
    expect(stable).toContain('✅ <b>СТАБИЛЬНО')
    expect(alertSubject({ ...base, event: 'stable', flapCount: 5, quietMin: 16 })).toBe('✅ СТАБИЛЬНО (🔴 критично): Агент сервера молчит — Contabo · prod')
    expect(stable).toContain('16 мин без сбоев (сбоев за час: 5)')
  })

  it('время и длительности', () => {
    const now = Date.UTC(2026, 9, 7, 12, 0)
    expect(clock(Date.UTC(2026, 9, 7, 9, 5), 'Europe/Minsk', now)).toBe('12:05')
    expect(clock(Date.UTC(2026, 9, 6, 9, 5), 'Europe/Minsk', now)).toBe('06.10 12:05')
    expect(humanDuration(30_000)).toBe('< 1 мин')
    expect(humanDuration(130 * 60_000)).toBe('2 ч 10 мин')
    expect(humanDuration(50 * 3_600_000)).toBe('2 дн 2 ч')
  })
})

describe('объяснения причин', () => {
  const c: ContainerView = {
    name: 'backend-worker-1',
    image: 'hr/backend',
    state: 'exited',
    status: 'Exited (137)',
    health: 'none',
    healthLog: '',
    restartPolicy: 'unless-stopped',
    exitCode: 137,
    oomKilled: false,
    restartCount: 2,
    startedAt: null,
    cpuPct: null,
    memMb: null,
    memLimitMb: 1024,
  }

  it('коды выхода контейнера', () => {
    expect(explainExit(c)).toMatch(/137 = SIGKILL.*OOM.*лимит 1\.0 ГБ/)
    expect(explainExit({ ...c, oomKilled: true })).toMatch(/Убит ядром по нехватке памяти/)
    expect(explainExit({ ...c, exitCode: 1 })).toMatch(/ошибка приложения.*docker logs --tail 100 backend-worker-1/)
    expect(explainExit({ ...c, exitCode: 143 })).toMatch(/SIGTERM/)
    expect(explainExit({ ...c, exitCode: 0 })).toMatch(/штатно/)
  })

  it('unhealthy цитирует вывод проверки', () => {
    expect(explainUnhealthy({ name: 'api', healthLog: 'curl: (7) Failed to connect' })).toContain('«curl: (7) Failed to connect»')
  })

  it('сбой проверки доступности', () => {
    expect(explainCheckFailure({ statusCode: null, error: 'таймаут 8000 мс' }, 8000)).toMatch(/не ответил за 8000 мс/)
    expect(explainCheckFailure({ statusCode: null, error: 'fetch failed (ECONNREFUSED)' }, 8000)).toMatch(/не слушает порт/)
    expect(explainCheckFailure({ statusCode: 502, error: 'HTTP 502' }, 8000)).toMatch(/nginx не достучался/)
    expect(explainCheckFailure({ statusCode: 200, error: 'health: status=degraded' }, 8000)).toMatch(/БД или Redis/)
    expect(explainCheckFailure({ statusCode: 404, error: 'HTTP 404' }, 8000)).toMatch(/отказом/)
  })

  it('агент молчит: прод жив или нет — по внешним проверкам', () => {
    expect(silenceVerdict(5, 5).hint).toMatch(/прод работает/)
    expect(silenceVerdict(0, 5).hint).toMatch(/недоступен сам сервер/)
    expect(silenceVerdict(2, 5).fact).toBe('2/5 отвечают')
    expect(
      lastStateLine(
        JSON.stringify({
          cpu: { pct: 22.4 },
          memory: { totalMb: 1000, usedMb: 280 },
          disks: [{ totalGb: 100, usedGb: 32 }],
          containers: [{ state: 'running' }, { state: 'exited' }],
        }),
      ),
    ).toBe('CPU 22% · RAM 28% · диск 32% · контейнеров 1/2')
  })

  it('кто ест память', () => {
    const list = [
      { ...c, name: 'a', memMb: 300 },
      { ...c, name: 'b', memMb: 4200 },
      { ...c, name: 'c', memMb: 900 },
    ]
    expect(topConsumers(list, 'mem', 2)).toBe('b 4.1 ГБ · c 900 МБ')
  })
})

// ── Сквозной сценарий ──────────────────────────────────────────────────────

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

const ctr = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  image: `${name}:1`,
  state: 'running',
  health: 'healthy',
  status: 'Up',
  restartCount: 0,
  composeService: name,
  restartPolicy: 'unless-stopped',
  ...over,
})
const send = (containers: Array<Record<string, unknown>>) =>
  app.request('/api/agent/report', signedAgentRequest('prod', secret, report(containers)))
const sick = [ctr('api', { health: 'unhealthy', healthLog: 'curl: (7) Failed to connect to localhost port 3001' })]
const well = [ctr('api')]
const twice = async (c: Array<Record<string, unknown>>) => {
  await send(c)
  await send(c)
}

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

describe('шум и контекст алертов (сквозной)', () => {
  it('unhealthy: в уведомлении вывод healthcheck и подсказка', async () => {
    await twice(sick)
    const fired = events.at(-1) as { event: string; facts: Record<string, string>; hint: string; value: string }
    expect(fired.event).toBe('firing')
    expect(fired.facts['Последняя проверка']).toBe('curl: (7) Failed to connect to localhost port 3001')
    expect(fired.hint).toContain('docker inspect')
    expect(fired.value).toContain('unhealthy: curl: (7)')
  })

  it('мигание: третий сбой за час — одно «мигает», дальше тишина, затем «стабильно»', async () => {
    await twice(well) // resolved
    await twice(sick) // firing #2
    await twice(well) // resolved
    await twice(sick) // #3 → flapping
    await twice(well) // resolved — не рассылается, пока мигает
    await twice(sick) // #4 — подавлено (уведомление «мигает» было < 30 мин назад)
    await twice(well)
    expect(events.map((e) => e.event)).toEqual(['firing', 'resolved', 'firing', 'resolved', 'flapping'])
    expect((events.at(-1) as { flapCount: number }).flapCount).toBe(3)

    // 16 минут без сбоев → одно «стабильно».
    const last = await getDb().query.alerts.findFirst({ where: eq(alerts.status, 'resolved'), orderBy: (a, { desc }) => [desc(a.id)] })
    await getDb()
      .update(alerts)
      .set({ resolvedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(alerts.id, last!.id))
    expect(await notifyStableFlaps()).toBe(1)
    expect(await notifyStableFlaps()).toBe(0)
    expect(events.at(-1)?.event).toBe('stable')
  })

  it('ручное закрытие: событие closed с автором, а не «восстановлено»', async () => {
    await twice([ctr('api'), ctr('worker', { state: 'exited', exitCode: 137, health: 'none' })])
    const firing = (await owner.get('/alerts?status=firing')).json.alerts.find((a: { object: string }) => a.object.startsWith('worker'))
    expect(firing.hint).toMatch(/137 = SIGKILL/)
    expect((await owner.post(`/alerts/${firing.id}/resolve`)).status).toBe(200)
    const closed = events.at(-1) as { event: string; closedBy: string }
    expect(closed).toMatchObject({ event: 'closed', closedBy: 'owner@ops.test' })
    const row = await getDb().query.alerts.findFirst({ where: eq(alerts.id, firing.id) })
    expect(row?.resolvedBy).toBe('owner@ops.test')
  })
})
