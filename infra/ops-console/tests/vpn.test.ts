/**
 * WireGuard (агент 1.6): что из блока vpn видят все роли, а что — только владелец; метрики графиков; кривой блок не
 * роняет отчёт. Сквозной путь «отчёт → снимок / agent_vpn → /infra/agents/:id[/vpn]».
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { api, freshApp, login, OWNER, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { agentVpn, metricSamples, users } from '../server/db/schema'
import { setEnvForTests } from '../server/env'
import { hashPassword } from '../server/lib/crypto'
import { agentReportSchema } from '../shared/agent-contract'
import { errCode, pruneVpn, VPN_KEEP_MS, vpnSamples, vpnSummary } from '../server/agents/vpn'

const now = () => Math.floor(Date.now() / 1000)
const peer = (over: Record<string, unknown> = {}) => ({
  name: 'Mac',
  iface: 'wg0',
  ip: '10.77.0.2',
  online: true,
  handshakeAgeSec: 20,
  rx: 5_000_000,
  tx: 90_000_000,
  rxBps: 1200,
  txBps: 64_000,
  rttMs: 41.5,
  lossPct: 0,
  pingAgeSec: 100,
  endpoint: '203.0.113.7:51820',
  ...over,
})
const win = (rows: unknown[]) => ({ rows, keys: rows.length, total: [10, 20, 3] })
const dest = { peer: 'Mac', proto: 'tcp', dst: '142.250.1.1', port: 443, up: 10, down: 20, conns: 3, host: 'fra16s.1e100.net' }
const vpnBlock = (over: Record<string, unknown> = {}) => ({
  state: 'ok',
  at: now(),
  interval: 30,
  peers: [peer(), peer({ name: '10.77.0.3', ip: '10.77.0.3', online: false, handshakeAgeSec: null, rxBps: undefined, txBps: undefined, endpoint: undefined })],
  flowsSource: 'proc',
  flowsAcct: true,
  flowsTruncated: false,
  destinations: { at: now(), h1: win([dest]), h24: win([dest]) },
  ...over,
})

describe('блок vpn: снимок и метрики', () => {
  const parsed = agentReportSchema.parse(report([], { agentVersion: '1.6.0', vpn: vpnBlock() }))

  it('в общий снимок — пиры без внешних адресов и без направлений', () => {
    const s = vpnSummary(parsed.vpn!)
    expect(s).not.toHaveProperty('destinations')
    expect(JSON.stringify(s)).not.toContain('203.0.113.7')
    expect(s.peers[0]).toMatchObject({ name: 'Mac', rttMs: 41.5, online: true })
  })

  it('метрики: сумма скоростей и число пиров на связи, только при state=ok', () => {
    const got: Record<string, number | undefined> = {}
    vpnSamples(parsed.vpn, (k, v) => (got[k] = v))
    expect(got).toEqual({ vpn_rx_bps: 1200, vpn_tx_bps: 64_000, vpn_peers_online: 1 })
    const stale: Record<string, number | undefined> = {}
    vpnSamples({ ...parsed.vpn!, state: 'stale' }, (k, v) => (stale[k] = v))
    expect(stale).toEqual({})
  })

  it('скоростей нет ни у одного пира — метрики скорости не пишутся (не ноль)', () => {
    const got: Record<string, number | undefined> = {}
    const v = agentReportSchema.parse(report([], { vpn: vpnBlock({ peers: [peer({ rxBps: undefined, txBps: undefined })] }) })).vpn
    vpnSamples(v, (k, val) => (got[k] = val))
    expect(got.vpn_rx_bps).toBeUndefined()
    expect(got.vpn_peers_online).toBe(1)
  })

  it('кривой блок vpn отбрасывается, отчёт принимается', () => {
    const bad = agentReportSchema.safeParse(report([], { vpn: { state: 'ok', peers: 'нет' } }))
    expect(bad.success).toBe(true)
    expect(bad.success && bad.data.vpn).toBeUndefined()
    const many = agentReportSchema.safeParse(report([], { vpn: vpnBlock({ peers: Array.from({ length: 40 }, () => peer()) }) }))
    expect(many.success && many.data.vpn).toBeUndefined()
  })

  it('в журнал ошибки записи — только код: текст drizzle несёт адреса', () => {
    expect(errCode(Object.assign(new Error('insert … 203.0.113.7'), { code: 'SQLITE_BUSY' }))).toBe('SQLITE_BUSY')
    expect(errCode(Object.assign(new Error('Failed query: … 142.250.1.1'), { cause: { code: 'SQLITE_CONSTRAINT' } }))).toBe(
      'SQLITE_CONSTRAINT',
    )
    expect(errCode(new TypeError('203.0.113.7'))).toBe('TypeError')
    expect(errCode('203.0.113.7')).toBe('unknown')
    expect(errCode(Object.assign(new Error(), { code: 'X'.repeat(100) }))).toHaveLength(64)
  })
})

describe('vpn: отчёт → снимок и agent_vpn → права (сквозной)', () => {
  let app: Awaited<ReturnType<typeof freshApp>>
  let owner: ReturnType<typeof api>
  let secret = ''
  const send = (body: unknown) => app.request('/api/agent/report', signedAgentRequest('wg', secret, body))

  beforeAll(async () => {
    app = await freshApp()
    owner = api(app, await login(app))
    secret = (await owner.post('/admin/agents', { id: 'wg', name: 'wg', environment: 'production' })).json.secret
    await getDb()
      .insert(users)
      .values([
        { email: 'op@ops.test', name: 'O', role: 'operator', passwordHash: await hashPassword('op-password-123'), createdAt: new Date() },
        { email: 'view@ops.test', name: 'V', role: 'viewer', passwordHash: await hashPassword('view-password-123'), createdAt: new Date() },
      ])
  })

  it('снимок хоста без внешних адресов; направления и адреса — только владельцу', async () => {
    expect((await send(report([], { agentVersion: '1.6.0', vpn: vpnBlock() }))).status).toBe(200)
    const operator = api(app, await login(app, 'op@ops.test', 'op-password-123'))
    const viewer = api(app, await login(app, 'view@ops.test', 'view-password-123'))

    for (const who of [owner, operator, viewer]) {
      const agent = await who.get('/infra/agents/wg')
      expect(agent.status).toBe(200)
      expect(agent.json.agent.snapshot.vpn.peers).toHaveLength(2)
      expect(JSON.stringify(agent.json)).not.toContain('203.0.113.7')
      expect(JSON.stringify(agent.json)).not.toContain('142.250.1.1')
    }
    expect((await operator.get('/infra/agents/wg/vpn')).status).toBe(403)
    expect((await viewer.get('/infra/agents/wg/vpn')).status).toBe(403)

    const own = await owner.get('/infra/agents/wg/vpn')
    expect(own.status).toBe(200)
    expect(own.json.vpn.endpoints).toEqual([{ ip: '10.77.0.2', name: 'Mac', endpoint: '203.0.113.7:51820' }])
    expect(own.json.vpn.destinations.h1.rows[0]).toMatchObject({ dst: '142.250.1.1', host: 'fra16s.1e100.net' })
    expect(own.json.vpn.capturedAt).toBeGreaterThan(0)

    const samples = await getDb()
      .select({ metric: metricSamples.metric, value: metricSamples.value })
      .from(metricSamples)
      .where(and(eq(metricSamples.agentId, 'wg'), eq(metricSamples.metric, 'vpn_peers_online')))
    expect(samples.map((r) => r.value)).toEqual([1])
  })

  it('отчёт без направлений (снимок сборщика не новый) — строка agent_vpn не перезаписывается', async () => {
    const before = await getDb().query.agentVpn.findFirst({ where: eq(agentVpn.agentId, 'wg') })
    expect((await send(report([], { agentVersion: '1.6.0', vpn: vpnBlock({ destinations: undefined }) }))).status).toBe(200)
    const after = await getDb().query.agentVpn.findFirst({ where: eq(agentVpn.agentId, 'wg') })
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime())
    expect(after?.destinationsJson).toContain('142.250.1.1')
  })

  it('списки обзора и инфраструктуры — без блока vpn (его показывает только страница сервера)', async () => {
    const infra = (await owner.get('/infra/agents')).json.agents.find((a: { id: string }) => a.id === 'wg')
    const overview = (await owner.get('/overview')).json.agents.find((a: { id: string }) => a.id === 'wg')
    for (const row of [infra, overview]) {
      expect(row.snapshot).toMatchObject({ hostname: 'test-host' })
      expect(row.snapshot).not.toHaveProperty('vpn')
    }
  })

  it('OPS_VPN_VIEWERS сужает круг владельцев, которым видны направления', async () => {
    try {
      setEnvForTests({ vpnViewers: ['other@ops.test'] })
      const denied = await owner.get('/infra/agents/wg/vpn')
      expect(denied.status).toBe(403)
      expect(JSON.stringify(denied.json)).not.toContain('142.250.1.1')
      setEnvForTests({ vpnViewers: [OWNER.email] })
      expect((await owner.get('/infra/agents/wg/vpn')).status).toBe(200)
    } finally {
      setEnvForTests({ vpnViewers: [] })
    }
  })

  it('строку agent_vpn старше суток удаляет уборка, свежую — нет', async () => {
    const row = () => getDb().query.agentVpn.findFirst({ where: eq(agentVpn.agentId, 'wg') })
    await pruneVpn(Date.now())
    expect(await row()).toBeDefined()
    await getDb()
      .update(agentVpn)
      .set({ capturedAt: new Date(Date.now() - VPN_KEEP_MS - 60_000) })
      .where(eq(agentVpn.agentId, 'wg'))
    await pruneVpn(Date.now())
    expect(await row()).toBeUndefined()
    expect((await send(report([], { agentVersion: '1.6.0', vpn: vpnBlock() }))).status).toBe(200)
    expect(await row()).toBeDefined()
  })

  it('удаление агента удаляет и его данные VPN', async () => {
    expect((await owner.del('/admin/agents/wg')).status).toBe(200)
    expect(await getDb().query.agentVpn.findFirst({ where: eq(agentVpn.agentId, 'wg') })).toBeUndefined()
  })
})
