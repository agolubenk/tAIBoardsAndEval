/** Поиск в меню консоли: разделы, вкладки по ключевым словам, объекты, права ролей. */
import { describe, expect, it } from 'vitest'
import { NAV, PER_GROUP, searchEntities, searchSections, tokenize } from '../web/layout/navigation'
import type { AgentSummary, Alert, Container, Incident, Monitor, Role } from '../web/lib/types'

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
const as = (role: Role) => (min: Role) => RANK[role] >= RANK[min]
const labels = (q: string, role: Role = 'owner') => searchSections(tokenize(q), as(role)).map((h) => h.label)

describe('поиск по разделам', () => {
  it('находит раздел по названию и вкладку по ключевым словам', () => {
    expect(labels('алер')[0]).toBe('Алерты')
    expect(labels('telegram')).toEqual(['Каналы уведомлений'])
    expect(labels('ssl')).toEqual(['TLS-сертификаты'])
    expect(labels('github')).toEqual(['Деплои', 'Интеграции'])
  })

  it('слова запроса ищутся и в названии родителя: «алерты каналы»', () => {
    expect(labels('алерты каналы')).toEqual(['Каналы уведомлений'])
  })

  it('регистр и ё не важны', () => {
    expect(labels('ОТЧЁТЫ')).toEqual(labels('отчеты'))
    expect(labels('отчеты')[0]).toBe('Отчёты ИИ-совету')
  })

  it('вкладки не по роли не показываются', () => {
    expect(labels('пользователи', 'operator')).toEqual([])
    expect(labels('пользователи', 'owner')).toEqual(['Пользователи'])
    expect(labels('telegram', 'viewer')).toEqual([])
  })

  it('у каждого раздела меню уникальный адрес', () => {
    const tos = NAV.map((s) => s.to)
    expect(new Set(tos).size).toBe(tos.length)
  })
})

describe('поиск по объектам', () => {
  const agents = [
    { id: 'contabo-prod', name: 'Contabo · prod', environment: 'production', snapshot: { hostname: 'vmi123' } },
  ] as AgentSummary[]
  const containers = [
    { agentId: 'contabo-prod', name: 'backend-nginx-1', composeService: 'nginx', image: 'nginx:1.27-alpine', state: 'running' },
    { agentId: 'contabo-prod', name: 'backend-postgres-1', composeService: 'postgres', image: 'pgvector/pgvector', state: 'running' },
  ] as Container[]
  const monitors = [
    { id: 7, name: 'app.hrhelper.space — API health', url: 'https://app.hrhelper.space/api/v1/health', tags: '' },
  ] as Monitor[]
  const alerts = [{ id: 10, title: 'Деплой упал', object: 'deploy-contabo.yml', value: 'failure' }] as Alert[]
  const incidents = [{ id: 3, title: 'Postgres недоступен', summary: '' }] as Incident[]
  const data = { agents, containers, monitors, alerts, incidents }

  it('контейнер — ссылка на сервер с якорем строки', () => {
    const [hit] = searchEntities(tokenize('nginx'), data)
    expect(hit).toMatchObject({ group: 'Контейнеры', label: 'backend-nginx-1', to: '/infrastructure/contabo-prod#c-backend-nginx-1' })
    expect(hit?.context).toBe('Contabo · prod · running')
  })

  it('сервер по hostname, монитор по адресу, алерт по объекту, инцидент по номеру', () => {
    expect(searchEntities(tokenize('vmi123'), data).map((h) => h.to)).toEqual(['/infrastructure/contabo-prod'])
    expect(searchEntities(tokenize('health'), data).map((h) => h.to)).toEqual(['/monitoring?monitor=7'])
    expect(searchEntities(tokenize('deploy-contabo'), data).map((h) => h.to)).toEqual(['/alerts?focus=10'])
    expect(searchEntities(tokenize('postgres'), data).map((h) => h.group)).toEqual(['Контейнеры', 'Инциденты'])
  })

  it('не больше PER_GROUP в группе; совпадение с начала названия — выше', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ agentId: 'a', name: `svc-${i}`, composeService: '', image: '', state: 'running' }))
    const ranked = [{ agentId: 'a', name: 'x-svc', composeService: '', image: '', state: 'running' }, ...many] as Container[]
    const hits = searchEntities(tokenize('svc'), { containers: ranked })
    expect(hits).toHaveLength(PER_GROUP)
    expect(hits[0]?.label).toBe('svc-0')
  })
})
