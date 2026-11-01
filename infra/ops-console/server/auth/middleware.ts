import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { apiError, roleAtLeast, type AppEnv, type Role } from '../http-types'
import { SESSION_COOKIE } from './session'
import { resolveActiveSession } from './sso'

/**
 * Сессия обязательна. Изменяющие запросы дополнительно требуют заголовок `X-Ops-Csrf: 1`:
 * вместе с SameSite=Strict это закрывает CSRF — кросс-сайтовая форма не может его поставить.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await resolveActiveSession(getCookie(c, SESSION_COOKIE))
  if (!user) throw apiError(401, 'Требуется вход')
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-ops-csrf') !== '1') {
    throw apiError(403, 'Нет CSRF-заголовка')
  }
  c.set('user', user)
  await next()
}

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roleAtLeast(c.get('user').role, min)) {
      throw apiError(403, min === 'owner' ? 'Только для владельца консоли' : 'Недостаточно прав: нужна роль оператора')
    }
    await next()
  }
}
