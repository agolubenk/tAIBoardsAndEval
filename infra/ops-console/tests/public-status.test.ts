/** Публичная страница: 90 дней истории, инциденты — только через публичные сервисы, без внутренних деталей. */
import { beforeEach, describe, expect, it } from 'vitest'
import { api, freshApp, login } from './helpers'
import { observe } from '../server/alerts/store'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

describe('публичная страница статуса', () => {
  it('90 дней, подпись сервиса; инцидент публичного сервиса — без заголовка; внутренний — не виден', async () => {
    const owner = api(app, await login(app))
    const g = (await owner.get('/settings')).json
    expect((await owner.put('/settings/general', { ...g.general, publicStatusEnabled: true })).status).toBe(200)
    const pub = (await owner.post('/monitors', { name: 'HR Helper', url: 'https://example.com/', isPublic: true, description: 'Веб-приложение и API' })).json.monitor
    await owner.post('/monitors', { name: 'internal', url: 'https://internal.example.com/' })
    const rule = { id: 1, forSamples: 1, severity: 'critical' as const, repeatMin: 0 }
    await observe({ rule, fingerprint: 'pub', breached: true, title: 'Секретное имя хоста db-7', object: 'HR Helper', value: 'HTTP 502', route: `/monitoring?monitor=${pub.id}` })
    await observe({ rule, fingerprint: 'host', breached: true, title: 'Диск db-primary', object: 'db-primary', value: '97%', route: '/infrastructure/db' })
    const d = (await (await app.request('/api/public/status')).json()) as Record<string, any>
    expect(d.services).toHaveLength(1)
    expect(d.services[0]).toMatchObject({ name: 'HR Helper', description: 'Веб-приложение и API' })
    expect(d.services[0].uptime90d).toHaveLength(90)
    expect(d.history).toHaveLength(1)
    expect(d.history[0]).toMatchObject({ severity: 'critical', services: ['HR Helper'] })
    const raw = JSON.stringify(d)
    expect(raw).not.toContain('Секретное')
    expect(raw).not.toContain('db-primary')
    expect(raw).not.toContain('example.com')
  })
})
