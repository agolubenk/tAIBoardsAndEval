/**
 * Сессии консоли: случайный токен в httpOnly-cookie, в БД — только sha256 токена.
 * Отдельная администрация, не связанная с продуктом (решение владельца 2026-10-06).
 */
import { and, eq, gt, lt, notLike, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { loginAttempts, sessions, users } from '../db/schema'
import { getEnv } from '../env'
import { hashPassword, randomToken, sha256Hex } from '../lib/crypto'
import type { SessionUser } from '../http-types'
import { logActivity } from '../activity'

export const SESSION_COOKIE = 'ops_session'
export const SESSION_TTL_MS = 7 * 86_400_000
const LOGIN_WINDOW_MS = 15 * 60_000
const MAX_FAILS_PER_EMAIL = 5
const MAX_FAILS_PER_IP = 20

export async function createSession(userId: number, ip: string, ttlMs = SESSION_TTL_MS): Promise<string> {
  const token = randomToken(32)
  const db = getDb()
  await db.insert(sessions).values({
    tokenHash: sha256Hex(token),
    userId,
    ip,
    expiresAt: new Date(Date.now() + ttlMs),
    createdAt: new Date(),
  })
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
  return token
}

/** Сессия как она лежит в БД. Право SSO-учётки дополнительно сверяет resolveActiveSession (auth/sso.ts). */
export interface SessionRow extends SessionUser {
  platformId: string | null
  ssoCheckedAt: Date | null
}

export async function resolveSession(token: string | undefined): Promise<SessionRow | null> {
  if (!token || token.length > 128) return null
  const db = getDb()
  const row = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      disabled: users.disabled,
      platformId: users.platformId,
      ssoCheckedAt: users.ssoCheckedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)
  const u = row[0]
  if (!u || u.disabled) return null
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    sso: u.platformId !== null,
    platformId: u.platformId,
    ssoCheckedAt: u.ssoCheckedAt,
  }
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return
  await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, sha256Hex(token)))
}

export async function destroyUserSessions(userId: number): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.userId, userId))
}

// ── Ограничение подбора пароля ──────────────────────────────────────────────

/** Неудачные попытки по ключу за окно LOGIN_WINDOW_MS (вход паролем, вход через платформу). */
async function recentFailures(key: string): Promise<number> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS)
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gt(loginAttempts.createdAt, since)))
  return row?.n ?? 0
}

export async function isLoginThrottled(email: string, ip: string): Promise<boolean> {
  const [byEmail, byIp] = await Promise.all([recentFailures(`email:${email}`), ip ? recentFailures(`ip:${ip}`) : Promise.resolve(0)])
  return byEmail >= MAX_FAILS_PER_EMAIL || byIp >= MAX_FAILS_PER_IP
}

export async function isKeyThrottled(key: string, max: number): Promise<boolean> {
  return (await recentFailures(key)) >= max
}

export async function recordFailure(key: string): Promise<void> {
  await getDb().insert(loginAttempts).values({ key, createdAt: new Date() })
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const rows = [{ key: `email:${email}`, createdAt: new Date() }]
  if (ip) rows.push({ key: `ip:${ip}`, createdAt: new Date() })
  await getDb().insert(loginAttempts).values(rows)
}

export async function clearLoginFailures(email: string): Promise<void> {
  await getDb()
    .delete(loginAttempts)
    .where(eq(loginAttempts.key, `email:${email}`))
}

export async function pruneAuthTables(): Promise<void> {
  const db = getDb()
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
  // Счётчики неверных паролей Telegram-бота считаются за сутки — их окно длиннее окна входа.
  await db
    .delete(loginAttempts)
    .where(and(lt(loginAttempts.createdAt, new Date(Date.now() - LOGIN_WINDOW_MS)), notLike(loginAttempts.key, 'tgpw:%')))
  await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, new Date(Date.now() - 86_400_000)))
}

// ── Первый владелец ─────────────────────────────────────────────────────────

/** Создать владельца из OPS_ADMIN_EMAIL/OPS_ADMIN_PASSWORD, если пользователей ещё нет. */
export async function bootstrapOwner(): Promise<'created' | 'exists' | 'not_configured'> {
  const db = getDb()
  const any = await db.select({ id: users.id }).from(users).limit(1)
  if (any.length) return 'exists'
  const { bootstrapEmail, bootstrapPassword } = getEnv()
  if (!bootstrapEmail || !bootstrapPassword) return 'not_configured'
  if (bootstrapPassword.length < 10) throw new Error('OPS_ADMIN_PASSWORD короче 10 символов')
  await db
    .insert(users)
    .values({
      email: bootstrapEmail,
      name: 'Владелец',
      role: 'owner',
      passwordHash: await hashPassword(bootstrapPassword),
      createdAt: new Date(),
    })
    .onConflictDoNothing()
  await logActivity('auth', `Создан владелец консоли ${bootstrapEmail}`)
  return 'created'
}
