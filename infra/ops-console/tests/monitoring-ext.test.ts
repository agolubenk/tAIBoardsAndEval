/** Мониторинг: TCP и DNS-проверки, адрес по типу, фазы запроса, перцентили и разбивка ошибок. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { checkResults, monitors } from '../server/db/schema'
import { parseHostPort, recordCheck, runCheck } from '../server/monitors/checks'
import { percentile } from '../server/monitors/stats'
import { addressError } from '../server/routes/monitors'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

function listen(server: Server | net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

describe('типы проверок', () => {
  it('адрес под тип; хост:порт с IPv6', () => {
    expect(addressError('tcp', 'db.example.com:5432')).toBeNull()
    expect(addressError('tcp', 'db.example.com')).toMatch(/хост:порт/)
    expect(addressError('dns', 'app.example.com')).toBeNull()
    expect(addressError('dns', 'https://app')).toMatch(/имя хоста/)
    expect(addressError('http', 'ftp://x')).toMatch(/http/)
    expect(parseHostPort('[::1]:6379')).toEqual({ host: '::1', port: 6379 })
    expect(parseHostPort('x:70000')).toBeNull()
  })

  afterEach(() => vi.restoreAllMocks())

  it('DNS: внутренний адрес в ответе — сбой без самого адреса; из «Внутренних адресов» — OK', async () => {
    const m = {
      id: 1,
      type: 'dns',
      url: 'postgres',
      dnsRecord: 'A',
      expectValue: '172.18.0.5',
      timeoutMs: 2000,
    } as typeof monitors.$inferSelect
    vi.spyOn(dns.Resolver.prototype, 'resolve').mockResolvedValue(['172.18.0.5'] as never)
    const denied = await runCheck(m)
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/внутренний адрес/)
    expect(denied.error).not.toContain('172.18')
    expect((await runCheck(m, ['postgres'])).ok).toBe(true)
    // Имя не из разрешённых — через публичные резолверы, а не резолвер контейнера (перебор имён Docker).
    const servers = vi.spyOn(dns.Resolver.prototype, 'setServers')
    await runCheck({ ...m, url: 'backend', expectValue: null })
    expect(servers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8'])
    servers.mockClear()
    await runCheck(m, ['postgres'])
    expect(servers).not.toHaveBeenCalled()
    expect((await runCheck({ ...m, url: 'app.example.com', expectValue: null }, [])).ok).toBe(false)
    vi.spyOn(dns.Resolver.prototype, 'resolve').mockResolvedValue(['93.184.216.34'] as never)
    expect((await runCheck({ ...m, url: 'app.example.com', expectValue: '93.184' })).ok).toBe(true)
  })

  it('TCP: открытый порт — OK, закрытый — сбой; внутренний адрес — только из разрешённых', async () => {
    const srv = net.createServer((s) => s.end())
    const port = await listen(srv)
    const base = { id: 1, type: 'tcp', url: `127.0.0.1:${port}`, timeoutMs: 2000 } as typeof monitors.$inferSelect
    const denied = await runCheck(base)
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/внутренний адрес|запрещён/)
    // Имя, разрешившееся во внутренний адрес: в тексте имя, но не сам адрес.
    const byName = await runCheck({ ...base, url: `localhost:${port}` })
    expect(byName.error).toContain('localhost')
    expect(byName.error).not.toMatch(/127\.0\.0\.1|::1/)
    const ok = await runCheck(base, ['127.0.0.1'])
    expect(ok).toMatchObject({ ok: true, error: null })
    expect(ok.timings?.connectMs).not.toBeNull()
    srv.close()
    const closed = await runCheck(base, ['127.0.0.1'])
    expect(closed.ok).toBe(false)
  })

  it('HTTP: фазы запроса записываются; API создаёт DNS-монитор и отвергает кривой адрес', async () => {
    const srv = createServer((_req, res) => res.end('ok'))
    const port = await listen(srv)
    const m = {
      id: 1,
      type: 'http',
      url: `http://127.0.0.1:${port}/`,
      method: 'GET',
      timeoutMs: 3000,
      expectStatus: null,
      expectHealthJson: false,
      keyword: null,
      failStreak: 0,
    } as unknown as typeof monitors.$inferSelect
    const out = await runCheck(m, ['127.0.0.1'])
    expect(out.ok).toBe(true)
    expect(out.timings).toMatchObject({ dnsMs: expect.any(Number), connectMs: expect.any(Number), tlsMs: null, ttfbMs: expect.any(Number) })
    // Повторная проверка — тоже новое соединение: фаза соединения измеряется каждый раз.
    const again = await runCheck(m, ['127.0.0.1'])
    expect(again.timings?.connectMs).toEqual(expect.any(Number))
    srv.close()

    const owner = api(app, await login(app))
    expect((await owner.post('/monitors', { name: 'tcp', type: 'tcp', url: 'nope' })).status).toBe(400)
    const created = await owner.post('/monitors', {
      name: 'DNS app',
      type: 'dns',
      url: 'app.example.com',
      dnsRecord: 'A',
      expectValue: '1.2.3.4',
    })
    expect(created.status).toBe(201)
    expect(created.json.monitor).toMatchObject({ type: 'dns', dnsRecord: 'A', expectValue: '1.2.3.4' })
    // Смена типа на tcp без «хост:порт» — отказ.
    expect((await owner.patch(`/monitors/${created.json.monitor.id}`, { type: 'tcp' })).status).toBe(400)
  })
})

describe('статистика проверок', () => {
  it('перцентили только по успешным; ошибки — разбивкой и метками', async () => {
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50)).toBe(50)
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100)
    expect(percentile([], 50)).toBeNull()
    const owner = api(app, await login(app))
    const created = await owner.post('/monitors', { name: 'web', url: 'https://example.com/' })
    const id = created.json.monitor.id as number
    const m = (await getDb().query.monitors.findFirst({ where: eq(monitors.id, id) }))!
    for (let i = 1; i <= 20; i++)
      await recordCheck(m, {
        ok: true,
        statusCode: 200,
        latencyMs: i * 10,
        error: null,
        timings: { dnsMs: 5, connectMs: 10, tlsMs: 20, ttfbMs: 100 },
      })
    await recordCheck(m, { ok: false, statusCode: 502, latencyMs: 5000, error: 'HTTP 502' })
    await recordCheck(m, { ok: false, statusCode: 502, latencyMs: 4000, error: 'HTTP 502' })
    await recordCheck(m, { ok: false, statusCode: null, latencyMs: 8000, error: 'таймаут 8000 мс' })
    const d = (await owner.get(`/monitors/${id}?hours=24`)).json
    expect(d.stats.latency).toMatchObject({ p50: 100, p95: 190, p99: 200, samples: 20 })
    expect(d.stats.errors[0]).toMatchObject({ error: 'HTTP 502', count: 2 })
    expect(d.stats.failures).toHaveLength(3)
    expect(d.stats.phases).toEqual({ dnsMs: 5, connectMs: 10, tlsMs: 20, ttfbMs: 100 })
    const row = await getDb().query.checkResults.findFirst({ where: eq(checkResults.monitorId, id) })
    expect(row?.ttfbMs).toBe(100)
    const list = (await owner.get('/monitors')).json.monitors
    expect(list[0].latency24h).toMatchObject({ p50: 100, p95: 190 })
  })
})
