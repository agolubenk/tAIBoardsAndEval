/** Разбор алертов: заметки дежурных (и в хронологию инцидента), причина тишины, тест vs доставка канала. */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { alerts, channels, deliveries, incidentEvents, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import { observe } from '../server/alerts/store'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

describe('разбор алертов', () => {
  it('заметка — в алерте и в хронологии инцидента; тишина с причиной — тоже заметка; наблюдателю писать нельзя', async () => {
    const owner = api(app, await login(app))
    await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'x', breached: true, title: 'API', object: 'prod', value: 'HTTP 502' })
    const a = (await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, 'x') }))!
    expect((await owner.post(`/alerts/${a.id}/notes`, { message: 'логи nginx чистые' })).status).toBe(201)
    expect((await owner.post(`/alerts/${a.id}/silence`, { minutes: 120, reason: 'ждём релиз' })).status).toBe(200)
    const notes = (await owner.get(`/alerts/${a.id}/notes`)).json.notes.map((n: { message: string }) => n.message)
    expect(notes).toEqual(['логи nginx чистые', 'Тишина 120 мин: ждём релиз'])
    const list = (await owner.get('/alerts')).json.alerts
    expect(list[0].notes).toBe(2)
    const tl = await getDb().query.incidentEvents.findMany({ where: eq(incidentEvents.incidentId, a.incidentId!) })
    expect(tl.some((e) => e.message === 'API: логи nginx чистые')).toBe(true)

    await getDb().insert(users).values({ email: 'v@ops.test', name: 'V', role: 'viewer', passwordHash: await hashPassword('viewer-password-1'), createdAt: new Date() })
    const viewer = api(app, await login(app, 'v@ops.test', 'viewer-password-1'))
    expect((await viewer.post(`/alerts/${a.id}/notes`, { message: 'x' })).status).toBe(403)
    expect((await viewer.get(`/alerts/${a.id}/notes`)).status).toBe(200)
  })

  it('канал: последняя проверка (тест) и последняя реальная доставка — раздельно', async () => {
    const owner = api(app, await login(app))
    const [ch] = await getDb().insert(channels).values({ kind: 'webhook', name: 'hook', configJson: '{}', createdAt: new Date() }).returning()
    const t = Date.now()
    await getDb()
      .insert(deliveries)
      .values([
        { channelId: ch!.id, target: 'hook', kind: 'test', ok: true, createdAt: new Date(t - 60_000) },
        { channelId: ch!.id, target: 'hook', kind: 'alert', ok: false, error: 'HTTP 500', createdAt: new Date(t - 30_000) },
      ])
    const got = (await owner.get('/channels')).json.channels[0]
    expect(got).toMatchObject({ lastTestOk: true, lastDeliveryOk: false })
    expect(got.lastDeliveryAt).toBeGreaterThan(got.lastTestAt)
  })
})
