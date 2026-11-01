/**
 * SSO Ops-консоли (продукт — IdP): обмен кода, учётка консоли и перепроверка живых сессий.
 *
 * Роль SSO-учётки задаёт платформа (суперадмин → owner, выданный доступ → operator) и сверяется
 * с ней раз в SSO_RECHECK_MS: отзыв доступа закрывает сессии консоли за минуты, а не по
 * истечении cookie. Недоступность продукта не выбивает из консоли — она нужнее всего именно во
 * время аварии; новый вход через платформу тогда невозможен, для этого есть локальная
 * break-glass-учётка владельца.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { getEnv, type OpsEnv } from '../env'
import { isQueueAliasHost, type SessionUser } from '../http-types'
import { httpRequest, type HttpResult } from '../lib/http'
import { logActivity } from '../activity'
import { destroyUserSessions, resolveSession } from './session'
import { suspendForUser } from '../telegram/subscriptions'

export const SSO_STATE_COOKIE = 'ops_sso_state'
/** Страница, на которую вернуть после входа через платформу (только из LOGIN_NEXT_PATHS). */
export const SSO_NEXT_COOKIE = 'ops_sso_next'
export const SSO_STATE_TTL_SEC = 600
/** Сессия SSO-учётки короче локальной: роль живёт в платформе, а повторный вход — в один клик. */
export const SSO_SESSION_TTL_MS = 12 * 3_600_000
/** Как часто сверять право входа с платформой. */
export const SSO_RECHECK_MS = 5 * 60_000
/** Пауза перед повторной сверкой, если платформа не ответила. */
const SSO_RETRY_MS = 60_000

const identitySchema = z.object({
  platform_admin_id: z.string().min(1).max(64),
  console_role: z.enum(['owner', 'operator']),
  email: z.string().trim().toLowerCase().min(1).max(320),
  name: z.string().max(200),
})
export type SsoIdentity = z.infer<typeof identitySchema>

const introspectSchema = z.union([identitySchema.extend({ active: z.literal(true) }), z.object({ active: z.literal(false) })])

/** Причина отказа во входе — уходит в /login?sso=<reason>. */
export type SsoFailure = 'off' | 'state' | 'exchange' | 'denied' | 'conflict' | 'disabled'

export class SsoError extends Error {
  constructor(
    readonly reason: SsoFailure,
    message: string,
  ) {
    super(message)
  }
}

export { ssoEnabled } from './sso-config'
import { ssoEnabled } from './sso-config'

/**
 * redirect_uri для хоста запроса. Сессионная cookie host-only, поэтому вход возвращается на тот же хост, с которого
 * начался: имя из OPS_ALLOWED_HOSTS (короткий адрес очереди) получает свой callback, остальные — OPS_PUBLIC_URL.
 * Хост только выбирается из списка, в адрес из заголовка ничего не попадает. Продукт сверяет точно:
 * OPS_CONSOLE_CALLBACK_URL и тот же адрес с хостами из OPS_CONSOLE_EXTRA_HOSTS.
 */
export function ssoCallbackUrl(env: OpsEnv, host = ''): string {
  const base = `${env.publicUrl}/api/auth/sso/callback`
  if (!isQueueAliasHost(host, env.allowedHosts, env.publicUrl)) return base
  const url = new URL(base)
  url.hostname = host
  return url.toString()
}

export function newSsoState(): string {
  return randomBytes(24).toString('base64url')
}

function callProduct(
  env: OpsEnv,
  path: 'token' | 'introspect',
  body: Record<string, string>,
  timeoutMs: number,
  clientIp = '',
): Promise<HttpResult> {
  return httpRequest(`${env.ssoApiUrl}/api/v1/platform/ops-sso/${path}`, {
    method: 'POST',
    // IP браузера — продукту: его лимит на /token считается по IP вызывающего, и без заголовка
    // все входы через консоль делили бы одну корзину (спам callback'а запирал бы вход всем).
    headers: { 'Content-Type': 'application/json', ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}) },
    body: JSON.stringify({ ...body, client_secret: env.ssoClientSecret }),
    timeoutMs,
    // Адрес продукта задаёт владелец через env (на проде — backend во внутренней Docker-сети):
    // приватный хост допускаем явно и только его — тот же SSRF-контур, что у остальных исходящих.
    allowPrivateHosts: [new URL(env.ssoApiUrl).hostname],
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Обмен одноразового кода — server-side: секрет консоли в браузер не попадает. */
export async function exchangeSsoCode(env: OpsEnv, code: string, clientIp = '', redirectUri = ssoCallbackUrl(env)): Promise<SsoIdentity> {
  let res: HttpResult
  try {
    res = await callProduct(env, 'token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 10_000, clientIp)
  } catch (err) {
    throw new SsoError('exchange', `продукт недоступен: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 403) throw new SsoError('denied', 'доступ к консоли не выдан или отозван')
  if (!res.ok) throw new SsoError('exchange', `token endpoint: HTTP ${res.status}`)
  const parsed = identitySchema.safeParse(parseJson(res.text))
  if (!parsed.success) throw new SsoError('exchange', 'некорректный ответ token endpoint')
  return parsed.data
}

/** Email из платформы, если он не занят другой учёткой консоли; иначе оставляем прежний. */
async function profilePatch(userId: number, identity: SsoIdentity): Promise<{ name: string; email?: string }> {
  const clash = await getDb().query.users.findFirst({
    where: and(eq(users.email, identity.email), ne(users.id, userId)),
    columns: { id: true },
  })
  return clash ? { name: identity.name } : { name: identity.name, email: identity.email }
}

/**
 * Учётка консоли для платформенного админа — по platform_id и никогда по email: совпадение email
 * с локальной учёткой — конфликт (это разные субъекты доступа, решает владелец консоли), а не
 * привязка. Иначе вход через платформу молча забирал бы чужую учётку вместе с её ролью.
 */
export async function upsertSsoUser(identity: SsoIdentity): Promise<{ id: number; email: string }> {
  const db = getDb()
  const findByPlatform = () => db.query.users.findFirst({ where: eq(users.platformId, identity.platform_admin_id) })
  const existing = await findByPlatform()
  if (existing) {
    if (existing.disabled) throw new SsoError('disabled', 'учётка заблокирована в консоли')
    const patch = await profilePatch(existing.id, identity)
    await db
      .update(users)
      .set({ ...patch, role: identity.console_role, ssoCheckedAt: new Date() })
      .where(eq(users.id, existing.id))
    return { id: existing.id, email: patch.email ?? existing.email }
  }
  const clash = await db.query.users.findFirst({ where: eq(users.email, identity.email), columns: { id: true } })
  if (clash) throw new SsoError('conflict', `email ${identity.email} занят локальной учёткой консоли`)
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: identity.email,
        name: identity.name,
        role: identity.console_role,
        platformId: identity.platform_admin_id,
        // SSO-учётка без пароля: verifyPassword с '' всегда false.
        passwordHash: '',
        createdAt: new Date(),
        ssoCheckedAt: new Date(),
      })
      .returning({ id: users.id, email: users.email })
    if (!row) throw new Error('insert вернул пусто')
    await logActivity('auth', `Создана учётка входа через платформу: ${identity.email} (${identity.console_role})`, identity.email, '/settings?tab=users')
    return row
  } catch (err) {
    // Два одновременных первых входа: второй упирается в уникальный platform_id — берём созданную.
    const raced = await findByPlatform()
    if (raced && !raced.disabled) return { id: raced.id, email: raced.email }
    throw err
  }
}

// ── Перепроверка живых сессий ───────────────────────────────────────────────

/** Одна сверка на пользователя одновременно: параллельные запросы ждут общий результат. */
const inflight = new Map<number, Promise<SessionUser | null>>()
/** После сбоя связи с продуктом — не дёргать его на каждом запросе. */
const retryAt = new Map<number, number>()

export function resetSsoStateForTests(): void {
  inflight.clear()
  retryAt.clear()
}

function keepOnOutage(user: SessionUser, reason: string): SessionUser {
  retryAt.set(user.id, Date.now() + SSO_RETRY_MS)
  console.warn(`[ops] SSO: платформа не подтвердила доступ ${user.email} (${reason}) — сессия остаётся до следующей сверки`)
  return user
}

async function closeSsoSessions(user: SessionUser, why: string, revoked = false): Promise<null> {
  await destroyUserSessions(user.id)
  await logActivity('auth', `${user.email}: ${why} — сессии консоли закрыты`, 'system', '/settings?tab=users')
  // Подписку останавливает только явный отзыв: сбой связки с продуктом закрывает сессии, но не
  // отключает алерты всем SSO-админам разом.
  if (revoked) await suspendForUser(user.id, why)
  return null
}

/**
 * Сверка права входа без сессии (тик Telegram-подписок): отозвал ли платформа доступ.
 * 'outage' — продукт недоступен или ответил 5xx/429: это не отзыв, подписку не трогаем.
 */
export async function introspectPlatformAdmin(
  env: OpsEnv,
  userId: number,
  platformId: string,
): Promise<'active' | 'revoked' | 'outage' | 'error'> {
  if (!platformId) return 'revoked'
  let res: HttpResult
  try {
    res = await callProduct(env, 'introspect', { platform_admin_id: platformId }, 5_000)
  } catch {
    return 'outage'
  }
  if (res.status >= 500 || res.status === 429) return 'outage'
  // 4xx и ответ не по контракту — сломана связка (секрет, адрес), а не отзыв конкретного админа:
  // массово останавливать подписки по такой ошибке нельзя.
  if (!res.ok) return 'error'
  const parsed = introspectSchema.safeParse(parseJson(res.text))
  if (!parsed.success) return 'error'
  if (!parsed.data.active) return 'revoked'
  await getDb().update(users).set({ role: parsed.data.console_role, ssoCheckedAt: new Date() }).where(eq(users.id, userId))
  return 'active'
}

async function recheck(env: OpsEnv, user: SessionUser, platformId: string): Promise<SessionUser | null> {
  let res: HttpResult
  try {
    res = await callProduct(env, 'introspect', { platform_admin_id: platformId }, 5_000)
  } catch (err) {
    return keepOnOutage(user, err instanceof Error ? err.message : String(err))
  }
  // Сеть, 5xx, 429 — сбой продукта: пускаем с прежней ролью. Прочие 4xx (неверный секрет,
  // SSO в продукте выключен — 404) и ответ не по контракту — подтвердить доступ нечем.
  if (res.status >= 500 || res.status === 429) return keepOnOutage(user, `HTTP ${res.status}`)
  if (!res.ok) return closeSsoSessions(user, `платформа отклонила сверку доступа (HTTP ${res.status})`)
  const parsed = introspectSchema.safeParse(parseJson(res.text))
  if (!parsed.success) return closeSsoSessions(user, 'платформа ответила на сверку доступа не по контракту')
  retryAt.delete(user.id)
  if (!parsed.data.active) return closeSsoSessions(user, 'доступ к консоли отозван в платформе', true)
  const identity = parsed.data
  const patch = await profilePatch(user.id, identity)
  await getDb()
    .update(users)
    .set({ ...patch, role: identity.console_role, ssoCheckedAt: new Date() })
    .where(eq(users.id, user.id))
  if (identity.console_role !== user.role) {
    await logActivity('auth', `Роль ${user.email} изменена платформой: ${user.role} → ${identity.console_role}`, 'system', '/settings?tab=users')
  }
  return { ...user, role: identity.console_role, name: patch.name, email: patch.email ?? user.email }
}

/**
 * Сессия по cookie с учётом платформы. Локальная учётка — как есть. SSO-учётка: SSO выключен в
 * этой консоли — не пускаем (подтвердить доступ нечем); иначе раз в SSO_RECHECK_MS сверяем с
 * продуктом: отозван → сессии закрыты (null), сменилась роль → обновлена.
 */
export async function resolveActiveSession(token: string | undefined): Promise<SessionUser | null> {
  const session = await resolveSession(token)
  if (!session) return null
  const { platformId, ssoCheckedAt, ...user } = session
  if (!platformId) return user
  const env = getEnv()
  if (!ssoEnabled(env)) return null
  const now = Date.now()
  if (now - (ssoCheckedAt?.getTime() ?? 0) < SSO_RECHECK_MS || now < (retryAt.get(user.id) ?? 0)) return user
  let pending = inflight.get(user.id)
  if (!pending) {
    pending = recheck(env, user, platformId).finally(() => inflight.delete(user.id))
    inflight.set(user.id, pending)
  }
  return pending
}
