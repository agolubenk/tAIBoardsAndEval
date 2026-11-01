/** Техработы глушат алерты объекта (не всей консоли), лента: поиск, период, маршрут, CSV без формул. */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { activity, agents, alerts } from '../server/db/schema'
import { observe } from '../server/alerts/store'
import { invalidateMaintenanceCache, targetOfRoute } from '../server/maintenance/store'
import { csvCell } from '../server/routes/events'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
  invalidateMaintenanceCache()
  await getDb()
    .insert(agents)
    .values({ id: 'db', name: 'db-primary', environment: 'production', secretEnc: 'x', secretHint: 'x', createdAt: new Date() })
})

const fire = (fp: string, route: string) =>
  observe({
    rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 },
    fingerprint: fp,
    breached: true,
    title: 'Диск',
    object: fp,
    value: '97%',
    route,
  })

describe('техработы', () => {
  it('алерт хоста в окне не поднимается; другого хоста — поднимается; после завершения — снова', async () => {
    const owner = api(app, await login(app))
    expect((await owner.post('/maintenance', { scope: 'agent', target: 'db', minutes: 60, reason: 'обновление PostgreSQL' })).status).toBe(
      201,
    )
    expect(await fire('db-disk', '/infrastructure/db')).toBe('maintenance')
    expect(await fire('other', '/infrastructure/web')).toBe('fired')
    const host = (await owner.get('/infra/agents/db')).json.agent
    expect(host).toMatchObject({ status: 'maintenance', maintenance: { reason: 'обновление PostgreSQL' } })
    // Повторное включение продлевает то же окно.
    const again = await owner.post('/maintenance', { scope: 'agent', target: 'db', minutes: 120, reason: 'продлили' })
    expect(again.status).toBe(200)
    const list = (await owner.get('/maintenance')).json.windows
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ targetName: 'db-primary', reason: 'продлили' })
    expect((await owner.post(`/maintenance/${list[0].id}/end`)).status).toBe(200)
    expect(await fire('db-disk', '/infrastructure/db')).toBe('fired')
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, 'db-disk') }))?.status).toBe('firing')
  })

  it('в окне сбой сбрасывает счёт «в норме»: горящий алерт не закрывается по разрозненным хорошим отчётам', async () => {
    const owner = api(app, await login(app))
    const rule = { id: 1, forSamples: 3, severity: 'critical' as const, repeatMin: 0 }
    const see = (breached: boolean) =>
      observe({
        rule,
        fingerprint: 'db-cpu',
        breached,
        title: 'CPU',
        object: 'db',
        value: breached ? '97%' : '40%',
        route: '/infrastructure/db',
      })
    for (let i = 0; i < 3; i++) await see(true)
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, 'db-cpu') }))?.status).toBe('firing')
    expect((await owner.post('/maintenance', { scope: 'agent', target: 'db', minutes: 60, reason: 'работы' })).status).toBe(201)
    const seq = [await see(false), await see(true), await see(false), await see(true), await see(false)]
    expect(seq).toEqual(['pending', 'maintenance', 'pending', 'maintenance', 'pending'])
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, 'db-cpu') }))?.status).toBe('firing')
  })

  it('окно на всю консоль глушит и деплой; несуществующий объект — 404; без причины — 400', async () => {
    const owner = api(app, await login(app))
    expect((await owner.post('/maintenance', { scope: 'agent', target: 'nope', minutes: 30, reason: 'работы' })).status).toBe(404)
    expect((await owner.post('/maintenance', { scope: 'all', minutes: 30, reason: '' })).status).toBe(400)
    expect((await owner.post('/maintenance', { scope: 'all', minutes: 30, reason: 'переезд ЦОД' })).status).toBe(201)
    expect(await fire('deploy', '/deploys')).toBe('maintenance')
    expect((await owner.get('/overview')).json.maintenance).toHaveLength(1)
  })

  it('объект по маршруту алерта', () => {
    expect(targetOfRoute('/infrastructure/db')).toEqual({ scope: 'agent', target: 'db' })
    expect(targetOfRoute('/monitoring?monitor=7')).toEqual({ scope: 'monitor', target: '7' })
    expect(targetOfRoute('/monitoring?tab=tls')).toBeNull()
  })
})

describe('лента событий', () => {
  it('поиск (с % и _ как обычными символами), период, маршрут хоста; CSV — с BOM и без формул', async () => {
    const cookie = await login(app)
    const owner = api(app, cookie)
    const now = Date.now()
    await getDb()
      .insert(activity)
      .values([
        {
          kind: 'action',
          message: 'Перезапуск api: 100% CPU',
          actor: 'op@ops.test',
          route: '/infrastructure/db',
          createdAt: new Date(now - 60_000),
        },
        { kind: 'config', message: '=HYPERLINK("http://evil")', actor: 'x', route: '', createdAt: new Date(now - 120_000) },
        {
          kind: 'alert',
          message: 'старое событие',
          actor: 'system',
          route: '/infrastructure/db',
          createdAt: new Date(now - 3 * 86_400_000),
        },
      ])
    const ev = async (qs: string) =>
      ((await owner.get(`/events/activity?${qs}`)).json.events as Array<{ message: string }>).map((e) => e.message)
    expect(await ev('q=100%25')).toEqual(['Перезапуск api: 100% CPU'])
    expect(await ev('q=_')).toEqual([])
    expect(await ev('hours=24&route=/infrastructure/db')).toEqual(['Перезапуск api: 100% CPU'])
    expect((await ev('route=/infrastructure/db')).length).toBe(2)
    const res = await app.request('/api/events/activity.csv?hours=24', { headers: { Cookie: cookie } })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="ops-events-/)
    // BOM UTF-8 (Excel иначе открывает кириллицу кракозябрами); TextDecoder его съедает — проверяем байты.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvCell('-1')).toBe(`"'-1"`)
  })
})
