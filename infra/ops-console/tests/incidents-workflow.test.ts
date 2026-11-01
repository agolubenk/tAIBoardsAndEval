/** Инциденты: ответственный, подтверждение, закрытие с итогом, связанные факты; связь деплой → инцидент. */
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { alerts, deploys, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import { observe } from '../server/alerts/store'

let app: Awaited<ReturnType<typeof freshApp>>
beforeEach(async () => {
  app = await freshApp()
})

async function criticalAlert(fp = 'api') {
  await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: fp, breached: true, title: 'API недоступен', object: fp, value: 'HTTP 502' })
  const a = await getDb().query.alerts.findFirst({ where: eq(alerts.fingerprint, fp) })
  return a!
}

describe('инцидент: работа дежурного', () => {
  it('подтвердить — алерты в работу и ответственный; назначить другому; наблюдатель — нельзя', async () => {
    const owner = api(app, await login(app))
    await getDb().insert(users).values([
      { email: 'op@ops.test', name: 'Оля', role: 'operator', passwordHash: await hashPassword('op-password-123'), createdAt: new Date() },
      { email: 'view@ops.test', name: 'Вика', role: 'viewer', passwordHash: await hashPassword('view-password-123'), createdAt: new Date() },
    ])
    const a = await criticalAlert()
    expect(a.incidentId).toBeTruthy()
    const id = a.incidentId!
    const r = await owner.post(`/incidents/${id}/ack`)
    expect(r.json.acked).toBe(1)
    let inc = (await owner.get(`/incidents/${id}`)).json.incident
    expect(inc.assignee).toBe('owner@ops.test')
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.id, a.id) }))?.acknowledgedBy).toBe('owner@ops.test')

    expect((await owner.post(`/incidents/${id}/assign`, { assignee: 'view@ops.test' })).status).toBe(400)
    expect((await owner.post(`/incidents/${id}/assign`, { assignee: 'op@ops.test' })).status).toBe(200)
    inc = (await owner.get(`/incidents/${id}`)).json.incident
    expect(inc.assignee).toBe('op@ops.test')
    const people = (await owner.get('/incidents/assignees')).json.assignees.map((p: { email: string }) => p.email)
    expect(people).toContain('op@ops.test')
    expect(people).not.toContain('view@ops.test')

    const viewer = api(app, await login(app, 'view@ops.test', 'view-password-123'))
    expect((await viewer.post(`/incidents/${id}/assign`, { assignee: null })).status).toBe(403)
  })

  it('закрыть с итогом и комментарием — в карточке и хронологии; список — затронуто и ответственный', async () => {
    const owner = api(app, await login(app))
    const a = await criticalAlert()
    const id = a.incidentId!
    await owner.post(`/incidents/${id}/status`, { status: 'resolved', result: 'false_positive', comment: 'Проверка ходила через сломанный прокси' })
    const d = (await owner.get(`/incidents/${id}`)).json
    expect(d.incident).toMatchObject({ status: 'resolved', closeResult: 'false_positive', closeComment: 'Проверка ходила через сломанный прокси' })
    expect(d.events.at(-1).message).toContain('Итог: ложное срабатывание — Проверка ходила')
    const list = (await owner.get('/incidents?status=all')).json.incidents
    expect(list[0]).toMatchObject({ id, affected: 1 })
  })

  it('связанные факты: деплой за 4 мин до начала; деплой — со ссылкой на инцидент', async () => {
    const owner = api(app, await login(app))
    const now = Date.now()
    await getDb()
      .insert(deploys)
      .values({ runKey: '1', workflow: 'deploy-contabo.yml', status: 'completed', conclusion: 'success', title: 'v2.14.0', startedAt: new Date(now - 8 * 60_000), finishedAt: new Date(now - 4 * 60_000), createdAt: new Date() })
    const a = await criticalAlert()
    const d = (await owner.get(`/incidents/${a.incidentId}`)).json
    expect(d.facts).toEqual([expect.objectContaining({ kind: 'deploy', offsetMin: -4, text: expect.stringContaining('за 4 мин до начала') })])
    const dep = (await owner.get('/events/deploys')).json
    expect(dep.deploys[0].incident).toEqual({ incidentId: a.incidentId, afterMin: 4 })
    expect(dep.source).toMatchObject({ lastSyncAt: null, lastSyncOk: false })
    expect(dep.avgOf).toBe(1)
  })
})

