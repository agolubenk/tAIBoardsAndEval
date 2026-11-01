/** Администрирование консоли (только владелец): агенты хостов и пользователи. */
import { Hono } from 'hono'
import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { agentDomains, agents, agentVpn, commands, containers, users } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { destroyUserSessions } from '../auth/session'
import { suspendForUser } from '../telegram/subscriptions'
import { encryptSecret, hashPassword, randomToken } from '../lib/crypto'
import { parseBody, parseId } from '../lib/validate'
import { logActivity } from '../activity'
import { createEnrollment, installCommand } from '../agents/enroll'
import { getEnv } from '../env'

const agentIdSchema = z.string().regex(/^[a-z0-9-]{2,64}$/, 'id: латиница в нижнем регистре, цифры, дефис (2–64)')

function issueSecret(): { secret: string; enc: string; hint: string } {
  const secret = `hrhops_${randomToken(32)}`
  return { secret, enc: encryptSecret(secret), hint: secret.slice(-4) }
}

/** Готовые строки для /etc/hrh-ops-agent.env — секрет показывается один раз. */
function installEnv(agentId: string, secret: string): string {
  return [`OPS_CONSOLE_URL=${getEnv().publicUrl}`, `OPS_AGENT_ID=${agentId}`, `OPS_AGENT_SECRET=${secret}`, 'OPS_AGENT_INTERVAL=15'].join(
    '\n',
  )
}

const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(120).default(''),
  role: z.enum(['owner', 'operator', 'viewer']),
  password: z.string().min(10, 'пароль — минимум 10 символов').max(200),
})

/** Активные владельцы, кроме excludeId; localOnly — только локальные (запасной вход без продукта). */
async function ownersLeftAfter(excludeId: number, localOnly = false): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(users)
    .where(
      and(eq(users.role, 'owner'), eq(users.disabled, false), ne(users.id, excludeId), ...(localOnly ? [isNull(users.platformId)] : [])),
    )
  return row?.n ?? 0
}

export const adminRoutes = new Hono<AppEnv>()
  .use('*', requireRole('owner'))
  // ── Агенты ────────────────────────────────────────────────────────────────
  .get('/agents', async (c) => {
    const rows = await getDb().query.agents.findMany({ orderBy: asc(agents.name), limit: 50 })
    return c.json({
      agents: rows.map((a) => ({
        id: a.id,
        name: a.name,
        environment: a.environment,
        enabled: a.enabled,
        secretHint: a.secretHint,
        lastSeenAt: a.lastSeenAt?.getTime() ?? null,
        createdAt: a.createdAt.getTime(),
      })),
    })
  })
  .post('/agents', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        id: agentIdSchema,
        name: z.string().trim().min(1).max(120),
        environment: z.string().trim().min(1).max(40).default('production'),
      }),
    )
    const db = getDb()
    if (await db.query.agents.findFirst({ where: eq(agents.id, body.id) })) throw apiError(409, 'Агент с таким id уже есть')
    const s = issueSecret()
    await db
      .insert(agents)
      .values({ id: body.id, name: body.name, environment: body.environment, secretEnc: s.enc, secretHint: s.hint, createdAt: new Date() })
    await logActivity('config', `Добавлен агент «${body.name}» (${body.id})`, c.get('user').email, `/infrastructure/${body.id}`)
    return c.json({ id: body.id, secret: s.secret, env: installEnv(body.id, s.secret) }, 201)
  })
  /** «Команда установки»: одноразовый код на 15 минут; секрет агент получит сам при установке. */
  .post('/agents/:id/enroll', async (c) => {
    const id = c.req.param('id')
    const agent = await getDb().query.agents.findFirst({ where: eq(agents.id, id), columns: { name: true } })
    if (!agent) throw apiError(404, 'Агент не найден')
    const command = installCommand('X'.repeat(32))
    if (!command) throw apiError(409, 'Установка по коду требует https-адреса консоли (OPS_PUBLIC_URL). Используйте секрет и install.sh вручную.')
    const user = c.get('user')
    const { code, expiresAt } = await createEnrollment(id, user.email)
    await logActivity('config', `Выдан код установки агента «${agent.name}» (15 мин)`, user.email, `/infrastructure/${id}`)
    return c.json({ id, expiresAt, command: installCommand(code) })
  })
  .post('/agents/:id/rotate', async (c) => {
    const id = c.req.param('id')
    const s = issueSecret()
    const [row] = await getDb()
      .update(agents)
      .set({ secretEnc: s.enc, secretHint: s.hint, lastRequestTs: 0 })
      .where(eq(agents.id, id))
      .returning({ name: agents.name })
    if (!row) throw apiError(404, 'Агент не найден')
    await logActivity(
      'config',
      `Перевыпущен секрет агента «${row.name}» — старый больше не принимается`,
      c.get('user').email,
      `/infrastructure/${id}`,
    )
    return c.json({ id, secret: s.secret, env: installEnv(id, s.secret) })
  })
  .patch('/agents/:id', async (c) => {
    const id = c.req.param('id')
    const body = await parseBody(
      c,
      z.object({ name: z.string().trim().min(1).max(120), environment: z.string().trim().min(1).max(40), enabled: z.boolean() }).partial(),
    )
    const [row] = await getDb().update(agents).set(body).where(eq(agents.id, id)).returning({ name: agents.name })
    if (!row) throw apiError(404, 'Агент не найден')
    await logActivity(
      'config',
      `Изменён агент «${row.name}»${body.enabled === false ? ' (выключен)' : ''}`,
      c.get('user').email,
      `/infrastructure/${id}`,
    )
    return c.json({ ok: true })
  })
  .delete('/agents/:id', async (c) => {
    const id = c.req.param('id')
    const db = getDb()
    const [row] = await db.delete(agents).where(eq(agents.id, id)).returning({ name: agents.name })
    if (!row) throw apiError(404, 'Агент не найден')
    await db.delete(containers).where(eq(containers.agentId, id))
    await db.delete(agentDomains).where(eq(agentDomains.agentId, id))
    await db.delete(agentVpn).where(eq(agentVpn.agentId, id))
    await db
      .update(commands)
      .set({ status: 'expired', output: 'Агент удалён' })
      .where(and(eq(commands.agentId, id), eq(commands.status, 'pending')))
    await logActivity('config', `Удалён агент «${row.name}»`, c.get('user').email, '/infrastructure')
    return c.json({ ok: true })
  })
  // ── Пользователи ──────────────────────────────────────────────────────────
  .get('/users', async (c) => {
    const rows = await getDb().query.users.findMany({ orderBy: asc(users.email), limit: 100 })
    return c.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        disabled: u.disabled,
        sso: u.platformId !== null,
        lastLoginAt: u.lastLoginAt?.getTime() ?? null,
        createdAt: u.createdAt.getTime(),
      })),
    })
  })
  .post('/users', async (c) => {
    const body = await parseBody(c, userCreateSchema)
    const db = getDb()
    if (await db.query.users.findFirst({ where: eq(users.email, body.email) })) throw apiError(409, 'Пользователь с таким email уже есть')
    await db.insert(users).values({
      email: body.email,
      name: body.name,
      role: body.role,
      passwordHash: await hashPassword(body.password),
      createdAt: new Date(),
    })
    await logActivity('auth', `Добавлен пользователь ${body.email} (${body.role})`, c.get('user').email, '/settings?tab=users')
    return c.json({ ok: true }, 201)
  })
  .patch('/users/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    const body = await parseBody(
      c,
      z
        .object({
          role: z.enum(['owner', 'operator', 'viewer']),
          disabled: z.boolean(),
          name: z.string().trim().max(120),
          email: z.string().trim().toLowerCase().email().max(320),
          password: z.string().min(10).max(200),
        })
        .partial(),
    )
    const db = getDb()
    const target = await db.query.users.findFirst({ where: eq(users.id, id) })
    if (!target) throw apiError(404, 'Пользователь не найден')
    // Роль и email учётки входа через платформу задаёт платформа (и перезапишет при следующей
    // сверке), пароля у неё нет. Здесь — только имя и локальная блокировка.
    if (target.platformId !== null && (body.role || body.password || body.email)) {
      throw apiError(409, 'Учётка входит через платформу: роль, email и доступ меняются в продукте (Платформа и надёжность → Ops-консоль)')
    }
    if (body.email && body.email !== target.email && (await db.query.users.findFirst({ where: eq(users.email, body.email) }))) {
      throw apiError(409, 'Пользователь с таким email уже есть')
    }
    const losesOwner = target.role === 'owner' && ((body.role && body.role !== 'owner') || body.disabled === true)
    if (losesOwner && (await ownersLeftAfter(id)) === 0) throw apiError(409, 'Нельзя оставить консоль без активного владельца')
    if (losesOwner && target.platformId === null && (await ownersLeftAfter(id, true)) === 0) {
      throw apiError(409, 'Нужен хотя бы один активный локальный владелец — запасной вход, если продукт недоступен')
    }
    const { password, ...rest } = body
    await db
      .update(users)
      .set({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) })
      .where(eq(users.id, id))
    if (body.disabled || body.role || password) await destroyUserSessions(id)
    // Отключённой учётке — никаких уведомлений: Telegram-подписка останавливается и после
    // включения учётки возобновляется только вручную (с вводом пароля бота).
    if (body.disabled) await suspendForUser(id, 'учётка отключена в консоли', c.get('user').email)
    await logActivity(
      'auth',
      `Изменён пользователь ${target.email}${body.email && body.email !== target.email ? ` → ${body.email}` : ''}${body.role ? ` → ${body.role}` : ''}${body.disabled ? ' (заблокирован)' : ''}${password ? ' (сброс пароля)' : ''}`,
      c.get('user').email,
      '/settings?tab=users',
    )
    return c.json({ ok: true })
  })
