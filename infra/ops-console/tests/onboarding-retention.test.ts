/** Онбординг засчитывает шаги только по факту; хранение данных — из настроек. */
import { beforeEach, describe, expect, it } from 'vitest'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { activity, agents, deliveries } from '../server/db/schema'
import { runTick } from '../server/scheduler/tick'
import { writeMarker } from '../server/settings/store'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

describe('онбординг', () => {
  it('шаги — по факту: агент без отчёта не засчитан, с отчётом — засчитан; неудачная доставка не считается', async () => {
    const owner = api(app, await login(app))
    await getDb().insert(agents).values({ id: 'a', name: 'a', environment: 'production', secretEnc: 'x', secretHint: 'x', createdAt: new Date() })
    await getDb().insert(deliveries).values({ target: 'tg', kind: 'test', ok: false, error: 'chat not found', createdAt: new Date() })
    let steps = (await owner.get('/overview/onboarding')).json.steps as Array<{ id: string; done: boolean }>
    expect(steps.find((x) => x.id === 'agent')?.done).toBe(false)
    expect(steps.find((x) => x.id === 'notify')?.done).toBe(false)
    await getDb().insert(agents).values({ id: 'b', name: 'b', environment: 'production', secretEnc: 'x', secretHint: 'x', lastSeenAt: new Date(), createdAt: new Date() })
    await getDb().insert(deliveries).values({ target: 'tg', kind: 'test', ok: true, createdAt: new Date() })
    steps = (await owner.get('/overview/onboarding')).json.steps
    expect(steps.find((x) => x.id === 'agent')?.done).toBe(true)
    expect(steps.find((x) => x.id === 'notify')?.done).toBe(true)
    expect(steps.find((x) => x.id === 'status')?.done).toBe(false)
  })
})

describe('хранение данных', () => {
  it('лента событий чистится по настройке, а не по зашитым 90 дням', async () => {
    const owner = api(app, await login(app))
    const g = (await owner.get('/settings')).json.general
    expect(g).toMatchObject({ activityRetentionDays: 90, deliveryRetentionDays: 30, rollupRetentionDays: 400 })
    expect((await owner.put('/settings/general', { ...g, activityRetentionDays: 7 })).status).toBe(200)
    expect((await owner.put('/settings/general', { ...g, rollupRetentionDays: 30 })).status).toBe(400)
    await getDb()
      .insert(activity)
      .values([
        { kind: 'config', message: 'старое', createdAt: new Date(Date.now() - 10 * 86_400_000) },
        { kind: 'config', message: 'свежее', createdAt: new Date() },
      ])
    await writeMarker('cleanup', 0)
    await runTick()
    const left = (await getDb().query.activity.findMany()).map((a) => a.message)
    expect(left).toContain('свежее')
    expect(left).not.toContain('старое')
  })
})
