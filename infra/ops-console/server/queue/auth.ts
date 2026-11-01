/**
 * Кто обращается к очереди: токен (агенты любых аккаунтов и ИИ-клиентов, бот очереди) или сессия консоли.
 * Сессия даёт права владельца только роли owner; изменяющий запрос с сессией требует X-Ops-Csrf, как
 * во всём API консоли. Токен — Bearer; в БД только sha256, выпуск — CLI (server/queue/cli.ts).
 */
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqTokens } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { randomToken, sha256Hex } from '../lib/crypto'
import { SESSION_COOKIE } from '../auth/session'
import { resolveActiveSession } from '../auth/sso'
import type { Actor, Scope } from './store'

export const SCOPES: readonly Scope[] = ['read', 'agent', 'owner']
const TOKEN_PREFIX = 'oq_'
const TOUCH_MS = 5 * 60_000

export type QueueEnv = AppEnv & { Variables: AppEnv['Variables'] & { oqActor: Actor } }

export async function createToken(name: string, scopes: Scope[]): Promise<{ id: number; token: string }> {
  const clean = [...new Set(scopes)].filter((s) => SCOPES.includes(s))
  if (!clean.length) throw new Error('Нужна хотя бы одна область: read, agent, owner')
  const token = TOKEN_PREFIX + randomToken(32)
  const [row] = await getDb().insert(oqTokens).values({ name: name.slice(0, 80), hash: sha256Hex(token), scopes: clean.join(',') }).returning({ id: oqTokens.id })
  return { id: row!.id, token }
}

export async function revokeToken(id: number): Promise<boolean> {
  const res = await getDb().update(oqTokens).set({ revokedAt: new Date() }).where(and(eq(oqTokens.id, id), isNull(oqTokens.revokedAt))).returning({ id: oqTokens.id })
  return res.length > 0
}

export async function listTokens() {
  const rows = await getDb().select().from(oqTokens).limit(100)
  return rows.map((r) => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revoked: Boolean(r.revokedAt) }))
}

async function actorFromToken(token: string): Promise<Actor | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null
  const db = getDb()
  const row = await db.query.oqTokens.findFirst({ where: and(eq(oqTokens.hash, sha256Hex(token)), isNull(oqTokens.revokedAt)) })
  if (!row) return null
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_MS) {
    await db.update(oqTokens).set({ lastUsedAt: new Date() }).where(eq(oqTokens.id, row.id))
  }
  return { name: `token:${row.name}`, scopes: row.scopes.split(',') as Scope[] }
}

/** Актор запроса или null (страница /queue решает сама: редирект на вход). */
export async function resolveActor(authHeader: string | undefined, sessionToken: string | undefined): Promise<Actor | null> {
  const bearer = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (bearer) return actorFromToken(bearer)
  const user = await resolveActiveSession(sessionToken)
  if (!user || user.role !== 'owner') return null
  return { name: `console:${user.email}`, scopes: ['owner'] }
}

export const requireQueueActor: MiddlewareHandler<QueueEnv> = async (c, next) => {
  const auth = c.req.header('authorization')
  const actor = await resolveActor(auth, getCookie(c, SESSION_COOKIE))
  if (!actor) throw apiError(401, 'Нужен токен очереди или вход владельца консоли')
  const mutating = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  if (mutating && !auth && c.req.header('x-ops-csrf') !== '1') throw apiError(403, 'Нет CSRF-заголовка')
  c.set('oqActor', actor)
  await next()
}

/** Нужна хотя бы одна из областей; owner проходит всегда. */
export function requireScope(...scopes: Scope[]): MiddlewareHandler<QueueEnv> {
  return async (c, next) => {
    const a = c.get('oqActor')
    if (!a.scopes.includes('owner') && !scopes.some((s) => a.scopes.includes(s))) throw apiError(403, `Нужна область ${scopes.join(' или ')}`)
    await next()
  }
}
