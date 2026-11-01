/**
 * Открыт ли пункт владельцу — одно правило на всех: страница /queue получает исходник oqItemState (OPEN_RULE_JS),
 * API отдаёт по нему открытые пункты (GET /db/items?open=1), а MCP oq_list open_only спрашивает API.
 *
 * «Ждёт вас снова»: владелец ответил, а сессия после ответа поставила agentStatus blocked — ей снова нужен владелец
 * (вопрос в ответ, вывод с ошибкой, «повторите проверку»). Такой пункт снова в открытых, с меткой. doing после ответа —
 * «работаю», пункт не переоткрывается: на 22.10 из 14 пунктов «ответ, потом doing» повторной просьбой были 3, а
 * остальные 11 — «принято, в работе»; done и planned не переоткрывают тоже. Сравниваются серверные отметки (store.ts):
 * blockedAt — переход в blocked, ownerAt — сохранение ответа (ревью «Контроля» #324, п. 4): часы устройства владельца
 * и agentAt любой записи агента (заметка поверх blocked) переоткрывали пункт ложно. У старых документов без отметок —
 * agentAt и at.
 *
 * Функция без вложенных функций и без внешних имён: её текст (String(oqItemState)) исполняется в странице как есть.
 */
export type ItemState = 'open' | 'again' | 'done'

export function oqItemState(kind: unknown, e: Record<string, unknown> | null | undefined): ItemState {
  const c = e || {}
  const answered = kind === 'decision' ? !!c.choice : kind === 'inbox' ? !!c.done || c.agentStatus === 'done' : !!c.done
  if (!answered) return 'open'
  const blocked = typeof c.blockedAt === 'string' ? c.blockedAt : c.agentAt
  const answeredAt = typeof c.ownerAt === 'string' ? c.ownerAt : c.at
  const again = c.agentStatus === 'blocked' && typeof blocked === 'string' && typeof answeredAt === 'string' && Date.parse(blocked) > Date.parse(answeredAt)
  return again ? 'again' : 'done'
}

export const OPEN_RULE_JS = String(oqItemState)
