import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { getEnv } from './env'
import { HTTPException } from 'hono/http-exception'

export type Role = 'owner' | 'operator' | 'viewer'

export interface SessionUser {
  id: number
  email: string
  name: string
  role: Role
  /** Вход через платформу (SSO): роль задаёт платформа, пароля у учётки нет. */
  sso: boolean
}

export interface AppEnv {
  Variables: {
    user: SessionUser
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

/** Ошибка API с понятным сообщением для оператора (уходит в JSON `{ error }`). */
export function apiError(
  status: 400 | 401 | 403 | 404 | 409 | 410 | 411 | 413 | 415 | 422 | 429 | 500 | 503 | 507,
  message: string,
): HTTPException {
  return new HTTPException(status, { message })
}

/**
 * IP клиента для ограничения перебора паролей. За доверенным прокси — X-Real-IP или ПОСЛЕДНИЙ
 * адрес X-Forwarded-For (его дописал наш прокси; первые клиент может подставить сам). Без
 * прокси заголовки игнорируются — адрес сокета.
 */
export function clientIp(c: Context): string {
  if (getEnv().trustProxy) {
    const real = c.req.header('x-real-ip')
    const chain = c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    return (real || chain?.at(-1) || '').slice(0, 64)
  }
  try {
    return (getConnInfo(c).remote.address ?? '').slice(0, 64)
  } catch {
    return ''
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Хост запроса без порта, в нижнем регистре. */
export function requestHost(c: Context): string {
  const raw = (c.req.header('host') ?? '').trim().toLowerCase()
  return raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '')
}

/** Консоль отвечает только по своим именам (OPS_ALLOWED_HOSTS) и по loopback (агент на хосте, healthcheck). */
export function hostAllowed(host: string, allowed: string[]): boolean {
  return !allowed.length || LOOPBACK.has(host) || allowed.includes(host)
}

/** Короткий адрес очереди: имя из OPS_ALLOWED_HOSTS, но не хост OPS_PUBLIC_URL и не loopback. */
export function isQueueAliasHost(host: string, allowed: string[], publicUrl: string): boolean {
  if (!host || LOOPBACK.has(host) || !allowed.includes(host)) return false
  try {
    return new URL(publicUrl).hostname !== host
  } catch {
    return false
  }
}

/** Что консоль отдаёт на коротком адресе очереди — те же пути, что проксирует queue-alias.sh. */
export const QUEUE_ALIAS_PATH_RE = /^\/(?:queue(?:\/assets\/[^/]+)?|login|api\/oq\/v1\/.+|api\/auth\/.+|assets\/.+)$/
