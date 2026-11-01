import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { getEnv } from '../env'
import { apiError, clientIp, requestHost, type AppEnv } from '../http-types'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { parseBody } from '../lib/validate'
import {
  clearLoginFailures,
  createSession,
  destroySession,
  destroyUserSessions,
  isKeyThrottled,
  isLoginThrottled,
  recordFailure,
  recordLoginFailure,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../auth/session'
import { requireSession } from '../auth/middleware'
import { logActivity } from '../activity'
import { safeLoginNext } from '../../shared/login-next'
import {
  exchangeSsoCode,
  newSsoState,
  resolveActiveSession,
  ssoCallbackUrl,
  ssoEnabled,
  SsoError,
  SSO_SESSION_TTL_MS,
  SSO_NEXT_COOKIE,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_SEC,
  upsertSsoUser,
} from '../auth/sso'

/** Неудачных входов через платформу с одного IP за 15 мин — дальше callback отвечает отказом, не дёргая продукт. */
const SSO_MAX_FAILS_PER_IP = 10

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320), password: z.string().min(1).max(200) })
const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(10, 'минимум 10 символов').max(200) })

// Хэш-заглушка: при неизвестном email тратим то же время на scrypt — по времени ответа не понять, есть ли учётка.
let dummyHash: Promise<string> | null = null

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const { email, password } = await parseBody(c, loginSchema)
    const ip = clientIp(c)
    if (await isLoginThrottled(email, ip)) throw apiError(429, 'Слишком много попыток входа. Подождите 15 минут.')
    const user = await getDb().query.users.findFirst({ where: eq(users.email, email) })
    dummyHash ??= hashPassword('dummy-password-for-timing')
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash))
    if (!user || !ok || user.disabled) {
      await recordLoginFailure(email, ip)
      throw apiError(401, 'Неверный email или пароль')
    }
    await clearLoginFailures(email)
    const token = await createSession(user.id, ip)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: getEnv().isProduction,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    })
    await logActivity('auth', `Вход: ${user.email}`, user.email)
    return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, sso: false } })
  })
  .post('/logout', async (c) => {
    await destroySession(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
  .get('/me', async (c) => {
    const user = await resolveActiveSession(getCookie(c, SESSION_COOKIE))
    const anyUser = await getDb().select({ id: users.id }).from(users).limit(1)
    return c.json({ user, needsBootstrap: anyUser.length === 0, ssoEnabled: ssoEnabled(getEnv()) })
  })
  .post('/password', requireSession, async (c) => {
    const { current, next } = await parseBody(c, passwordSchema)
    const me = c.get('user')
    const row = await getDb().query.users.findFirst({ where: eq(users.id, me.id) })
    if (!row) throw apiError(400, 'Пользователь не найден')
    if (row.platformId !== null || row.passwordHash === '') throw apiError(400, 'Учётка входит через платформу — пароля у неё нет')
    if (!(await verifyPassword(current, row.passwordHash))) throw apiError(400, 'Текущий пароль неверен')
    await getDb()
      .update(users)
      .set({ passwordHash: await hashPassword(next) })
      .where(eq(users.id, me.id))
    await destroyUserSessions(me.id)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    await logActivity('auth', `Смена пароля: ${me.email}`, me.email)
    return c.json({ ok: true })
  })

  // ─── SSO через продукт (продукт — IdP, authorization code flow) ──────────────
  // Старт: SPA запрашивает redirectUrl и уводит браузер на страницу-посредник продукта;
  // state запоминаем в cookie и сверяем в callback (анти-CSRF: чужой код в нашу сессию не войдёт).
  // ?next= — страница, на которую вернуть после входа (только из LOGIN_NEXT_PATHS), живёт рядом со state.
  .post('/sso/start', async (c) => {
    const env = getEnv()
    if (!ssoEnabled(env)) throw apiError(503, 'Вход через платформу не настроен в этой консоли')
    const state = newSsoState()
    const cookieOpts = {
      httpOnly: true,
      // Lax, не Strict: callback — переход верхнего уровня с домена продукта.
      sameSite: 'Lax',
      secure: env.isProduction,
      path: '/api/auth/sso',
      maxAge: SSO_STATE_TTL_SEC,
    } as const
    setCookie(c, SSO_STATE_COOKIE, state, cookieOpts)
    const next = safeLoginNext(c.req.query('next'))
    if (next) setCookie(c, SSO_NEXT_COOKIE, next, cookieOpts)
    else deleteCookie(c, SSO_NEXT_COOKIE, { path: '/api/auth/sso' })
    const relay = new URL('/admin/ops-console-sso', env.ssoProductUrl)
    relay.searchParams.set('redirect_uri', ssoCallbackUrl(env, requestHost(c)))
    relay.searchParams.set('state', state)
    return c.json({ redirectUrl: relay.toString() })
  })

  // Callback: браузер возвращается с одноразовым кодом. Обмен — server-side, секрет консоли
  // наружу не попадает. Отказы — на страницу входа с кодом причины (без текста ошибки в URL).
  .get('/sso/callback', async (c) => {
    const env = getEnv()
    const next = safeLoginNext(getCookie(c, SSO_NEXT_COOKIE))
    const fail = (reason: string) => c.redirect(`/login?sso=${reason}${next ? `&next=${encodeURIComponent(next)}` : ''}`)
    const ip = clientIp(c)
    const failKey = `sso:${ip || 'unknown'}`
    const expected = getCookie(c, SSO_STATE_COOKIE)
    deleteCookie(c, SSO_STATE_COOKIE, { path: '/api/auth/sso' })
    deleteCookie(c, SSO_NEXT_COOKIE, { path: '/api/auth/sso' })
    if (!ssoEnabled(env)) return fail('off')
    // До обмена: спам callback'а с подставленным state не должен доходить до продукта.
    if (await isKeyThrottled(failKey, SSO_MAX_FAILS_PER_IP)) return fail('throttled')
    const code = c.req.query('code') ?? ''
    const state = c.req.query('state') ?? ''
    if (!code || code.length > 256 || !state || !expected || state !== expected) {
      await recordFailure(failKey)
      return fail('state')
    }
    try {
      // Тот же redirect_uri, что ушёл в authorize: callback приходит на хост старта (state-cookie host-only).
      const identity = await exchangeSsoCode(env, code, ip, ssoCallbackUrl(env, requestHost(c)))
      const user = await upsertSsoUser(identity)
      const token = await createSession(user.id, clientIp(c), SSO_SESSION_TTL_MS)
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: env.isProduction,
        path: '/',
        maxAge: Math.floor(SSO_SESSION_TTL_MS / 1000),
      })
      await logActivity('auth', `Вход через платформу: ${user.email} (${identity.console_role})`, user.email)
      return c.redirect(next ?? '/')
    } catch (err) {
      const reason = err instanceof SsoError ? err.reason : 'exchange'
      await recordFailure(failKey)
      console.warn('[ops] SSO-вход не выполнен:', reason, err instanceof Error ? err.message : err)
      if (reason === 'conflict' || reason === 'disabled') {
        await logActivity('auth', `Вход через платформу отклонён: ${err instanceof Error ? err.message : reason}`, 'system', '/settings?tab=users')
      }
      return fail(reason)
    }
  })
