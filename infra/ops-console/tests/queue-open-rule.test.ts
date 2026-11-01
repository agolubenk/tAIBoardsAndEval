/**
 * «Открыт ли пункт владельцу» — одно правило для страницы /queue и API (?open=1, им пользуется MCP open_only):
 * «ждёт вас снова» — владелец ответил, а сессия после ответа поставила blocked. Странице уходит исходник функции
 * (OPEN_RULE_JS) — здесь он исполняется в отдельном контексте vm и обязан отвечать так же, как серверная функция.
 */
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { OPEN_RULE_JS, oqItemState, type ItemState } from '../server/queue/open-rule'

const T0 = '2026-10-22T10:00:00.000Z'
const T1 = '2026-10-22T10:05:00.000Z'

const CASES: [string, unknown, Record<string, unknown> | null, ItemState][] = [
  ['без ответа', 'decision', {}, 'open'],
  ['нет документа ответа', 'merge', null, 'open'],
  ['решение выбрано', 'decision', { choice: 'yes', done: true, at: T0 }, 'done'],
  ['решение закрывает только выбор, не галочка', 'decision', { done: true, at: T0 }, 'open'],
  ['ответ, потом blocked — ждёт снова', 'decision', { choice: 'yes', at: T0, agentStatus: 'blocked', agentAt: T1 }, 'again'],
  ['blocked до ответа — ответ закрыл', 'decision', { choice: 'yes', at: T1, agentStatus: 'blocked', agentAt: T0 }, 'done'],
  ['blocked в ту же секунду — не позже ответа', 'server', { done: true, at: T0, agentStatus: 'blocked', agentAt: T0 }, 'done'],
  ['ответ, потом doing — «работаю», закрыт', 'decision', { choice: 'yes', at: T0, agentStatus: 'doing', agentAt: T1 }, 'done'],
  ['ответ, потом done', 'check', { done: true, at: T0, agentStatus: 'done', agentAt: T1 }, 'done'],
  ['ответ, потом planned', 'check', { done: true, at: T0, agentStatus: 'planned', agentAt: T1 }, 'done'],
  ['сервер: вывод с ошибкой, новая команда', 'server', { done: true, at: T0, agentStatus: 'blocked', agentAt: T1 }, 'again'],
  ['галочка снята — открыт и так', 'check', { done: false, at: T0, agentStatus: 'blocked', agentAt: T1 }, 'open'],
  ['без времени ответа сравнить не с чем', 'server', { done: true, agentStatus: 'blocked', agentAt: T1 }, 'done'],
  ['битое время ответа', 'server', { done: true, at: 'вчера', agentStatus: 'blocked', agentAt: T1 }, 'done'],
  ['входящее: агент «сделано»', 'inbox', { agentStatus: 'done', agentAt: T1 }, 'done'],
  ['входящее: «Принято», потом blocked', 'inbox', { done: true, at: T0, agentStatus: 'blocked', agentAt: T1 }, 'again'],
  ['входящее без ответа владельца, агент ждёт', 'inbox', { agentStatus: 'blocked', agentAt: T1 }, 'open'],
  // Серверные отметки (ревью «Контроля» #324, п. 4) главнее часов устройства и agentAt любой записи агента.
  ['blocked после ответа по серверным отметкам — ждёт снова', 'check', { done: true, at: T1, ownerAt: T0, agentStatus: 'blocked', blockedAt: T1, agentAt: T1 }, 'again'],
  ['часы владельца отстают: at раньше, но ответ сохранён после blocked', 'check', { done: true, at: T0, ownerAt: T1, agentStatus: 'blocked', blockedAt: T0, agentAt: T1 }, 'done'],
  ['заметка агента поверх blocked после ответа — не переоткрывает', 'decision', { choice: 'yes', at: T0, ownerAt: T1, agentStatus: 'blocked', blockedAt: T0, agentAt: '2026-10-22T10:09:00.000Z' }, 'done'],
]

function pageRule(): (kind: unknown, e: unknown) => ItemState {
  const ctx: Record<string, unknown> = createContext({})
  runInContext(OPEN_RULE_JS, ctx)
  const fn = ctx.oqItemState
  if (typeof fn !== 'function') throw new Error('в OPEN_RULE_JS нет функции oqItemState')
  return fn as (kind: unknown, e: unknown) => ItemState
}

describe('правило «открыт ли пункт» (open-rule.ts)', () => {
  it.each(CASES)('%s', (_name, kind, e, want) => {
    expect(oqItemState(kind, e)).toBe(want)
  })

  it('страница получает то же правило: исходник исполняется сам по себе и отвечает так же', () => {
    const page = pageRule()
    for (const [name, kind, e, want] of CASES) expect(page(kind, e), name).toBe(want)
  })
})
