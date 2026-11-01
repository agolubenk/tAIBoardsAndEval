/** Главная: плитки (контейнеры, TLS, уведомления) и «ресурсы под наблюдением» с прогнозом заполнения. */
import { beforeEach, describe, expect, it } from 'vitest'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { agents, channels, containers, metricSamples, tlsChecks } from '../server/db/schema'
import { resetResourceCacheForTests, slopePerHour, watchedResources } from '../server/overview/resources'

let app: Awaited<ReturnType<typeof freshApp>>
const HOUR = 3_600_000

beforeEach(async () => {
  app = await freshApp()
  resetResourceCacheForTests()
})

async function host(id: string, snapshot: Record<string, unknown>) {
  await getDb()
    .insert(agents)
    .values({ id, name: id, environment: 'production', secretEnc: 'x', secretHint: 'x', lastSnapshotJson: JSON.stringify(snapshot), lastSeenAt: new Date(), createdAt: new Date() })
}

async function series(agentId: string, metric: string, from: number, to: number, hours: number) {
  const now = Date.now()
  await getDb()
    .insert(metricSamples)
    .values(Array.from({ length: hours * 4 }, (_, i) => ({ agentId, metric, value: from + ((to - from) * i) / (hours * 4 - 1), createdAt: new Date(now - hours * HOUR + i * 15 * 60_000) })))
}

describe('ресурсы под наблюдением', () => {
  it('растущий диск — с прогнозом заполнения и порогом правила; спокойный хост — не показывается', async () => {
    await host('db', { disks: [{ mount: '/data', totalGb: 320, usedGb: 268.8 }], memory: { totalMb: 16384, usedMb: 4000 }, cpu: { pct: 10 } })
    await host('calm', { disks: [{ mount: '/', totalGb: 100, usedGb: 30 }], memory: { totalMb: 8192, usedMb: 2000 }, cpu: { pct: 5 } })
    await series('db', 'disk_pct', 78, 84, 6)
    await series('calm', 'disk_pct', 30, 30, 6)
    const list = await watchedResources('6h')
    const disk = list.find((r) => r.agentId === 'db' && r.metric === 'disk_pct')!
    expect(disk.level).toBe('warning')
    expect(disk.threshold).toBe(85)
    expect(disk.delta).toBeGreaterThan(5)
    expect(disk.fullInHours).toBeGreaterThan(10)
    expect(disk.fullInHours).toBeLessThan(40)
    expect(disk.detail).toContain('/data')
    expect(list.some((r) => r.agentId === 'calm')).toBe(false)
  })

  it('наклон тренда — п.п. в час', () => {
    expect(slopePerHour([[0, 10], [HOUR, 12], [2 * HOUR, 14], [3 * HOUR, 16]])).toBeCloseTo(2)
    expect(slopePerHour([[0, 10]])).toBeNull()
  })

  it('API: окно 7d и неверное окно', async () => {
    const owner = api(app, await login(app))
    expect((await owner.get('/overview/resources?window=7d')).status).toBe(200)
    expect((await owner.get('/overview/resources?window=1y')).status).toBe(400)
  })
})

describe('плитки главной', () => {
  it('контейнеры, TLS и уведомления считаются; штатно завершённая задача не «упала»', async () => {
    await host('prod', { cpu: { pct: 5 } })
    const base = { agentId: 'prod', image: 'x', health: 'none', restartCount: 0, updatedAt: new Date() }
    await getDb()
      .insert(containers)
      .values([
        { ...base, name: 'api', state: 'running' },
        { ...base, name: 'worker', state: 'restarting' },
        { ...base, name: 'migrate', state: 'exited', restartPolicy: 'no', exitCode: 0 },
        { ...base, name: 'web', state: 'exited', restartPolicy: 'always', exitCode: 137 },
      ])
    await getDb()
      .insert(tlsChecks)
      .values([
        { domain: 'a.example', daysLeft: 9, checkedAt: new Date() },
        { domain: 'b.example', daysLeft: 80, checkedAt: new Date() },
      ])
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'DevOps', configJson: '{}', lastErrorAt: new Date(), lastError: 'chat not found', createdAt: new Date() })
    const owner = api(app, await login(app))
    const { kpis } = (await owner.get('/overview')).json
    expect(kpis.containers).toEqual({ total: 4, running: 1, restarting: 1, unhealthy: 0, stopped: 1 })
    expect(kpis.tls).toMatchObject({ total: 2, atRisk: 1, nearest: { domain: 'a.example', daysLeft: 9 } })
    expect(kpis.notifications.failing).toEqual([expect.objectContaining({ name: 'DevOps', error: 'chat not found' })])
  })
})
