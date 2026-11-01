/**
 * Проверка подписи запроса агента. Агент сам ходит в консоль (входящих портов на сервере нет):
 *   X-Ops-Agent: <id>
 *   X-Ops-Timestamp: <unix ms>, строго больше предыдущего принятого — повтор запроса отклоняется
 *   X-Ops-Signature: sha256=<hex HMAC-SHA256(secret, `${ts}.${METHOD}.${path}.${sha256(body)}`)>
 *
 * Метка повтора у отчётов агента и у событий деплоя своя. Скрипт деплоя ходит под учёткой агента
 * параллельно с его отчётами (раз в 15 с): с общей строго растущей меткой отчёт, подписанный раньше, но
 * пришедший позже события деплоя, получил бы 409, и агент ушёл бы в паузу повтора. События деплоя
 * отсекают повтор по метке своей карточки (server/deploys/progress.ts); подпись покрывает путь, так что
 * запрос одного маршрута не принимается другим.
 */
import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents } from '../db/schema'
import { decryptSecret, hmacHex, safeEqual, sha256Hex } from '../lib/crypto'
import { apiError } from '../http-types'
import { AGENT_HEADERS, agentSigningPayload } from '../../shared/agent-contract'

export type AgentRow = typeof agents.$inferSelect

interface SignedRequest {
  method: string
  path: string
  header: (name: string) => string | undefined
}

const MAX_SKEW_MS = 5 * 60_000

/** Заголовки, окно ±5 минут, включённый агент и подпись. Метку повтора не продвигает — это делает вызывающий. */
export async function authenticateAgentRequest(req: SignedRequest, rawBody: string): Promise<{ agent: AgentRow; ts: number }> {
  const agentId = req.header(AGENT_HEADERS.agent) ?? ''
  const tsRaw = req.header(AGENT_HEADERS.timestamp) ?? ''
  const signature = req.header(AGENT_HEADERS.signature) ?? ''
  if (!/^[a-z0-9-]{1,64}$/.test(agentId) || !/^\d{13}$/.test(tsRaw) || !signature.startsWith('sha256=')) {
    throw apiError(401, 'Нет подписи агента')
  }
  const ts = Number(tsRaw)
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) throw apiError(401, 'Метка времени агента вне окна ±5 минут (проверьте часы сервера)')

  const agent = await getDb().query.agents.findFirst({ where: eq(agents.id, agentId) })
  // Одинаковый ответ на «нет агента» и «плохая подпись» — не подсказываем, какие id существуют.
  if (!agent || !agent.enabled) throw apiError(401, 'Подпись агента не прошла проверку')
  const expected = `sha256=${hmacHex(decryptSecret(agent.secretEnc), agentSigningPayload(tsRaw, req.method, req.path, sha256Hex(rawBody)))}`
  if (!safeEqual(signature, expected)) throw apiError(401, 'Подпись агента не прошла проверку')
  return { agent, ts }
}

/** Отчёт агента: подпись и общая метка повтора агента. */
export async function verifyAgentRequest(req: SignedRequest, rawBody: string): Promise<AgentRow> {
  const { agent, ts } = await authenticateAgentRequest(req, rawBody)
  // Атомарно продвигаем метку: повтор того же запроса (или более старого) не пройдёт.
  const advanced = await getDb()
    .update(agents)
    .set({ lastRequestTs: ts })
    .where(and(eq(agents.id, agent.id), lt(agents.lastRequestTs, ts)))
    .returning({ id: agents.id })
  if (!advanced.length) throw apiError(409, 'Повтор запроса агента отклонён')
  return { ...agent, lastRequestTs: ts }
}
