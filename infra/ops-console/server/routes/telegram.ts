/**
 * Telegram-бот: вебхук и ввод пароля (без сессии — свои проверки), профиль подписки и настройки
 * бота (под сессией).
 *
 * Вебхук: секрет X-Telegram-Bot-Api-Secret-Token сверяется ДО чтения тела; неверный — 401, всё
 * остальное — 200 (иначе Telegram повторяет апдейт и счётчики попыток пароля растут дважды).
 * Тело и текст сообщений не журналируются.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { tgLinkTokens, tgSubscriptions, users } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseId } from '../lib/validate'
import { randomInt } from 'node:crypto'
import { verifyInitData } from '../telegram/initdata'
import { botToken, getBot, passwordAccepting, webhookMode } from '../telegram/store'
import { handleUpdate, passwordReply, updateSchema } from '../telegram/updates'
import {
  confirmLinkCode,
  createLinkToken,
  describeSubscription,
  resumeSubscription,
  rotatePassword,
  sendToChat,
  suspendSubscription,
  unlinkSubscription,
} from '../telegram/subscriptions'
import { removeBot, saveBot, unfreezePasswordEntry, webhookSecretMatches, WebhookTakenError } from '../telegram/bot'

// ── Без сессии ──────────────────────────────────────────────────────────────

export const telegramPublicRoutes = new Hono<AppEnv>()
  .post('/webhook', async (c) => {
    const bot = await getBot()
    if (!bot || !webhookSecretMatches(bot, c.req.header('x-telegram-bot-api-secret-token'))) {
      return c.json({ error: 'forbidden' }, 401)
    }
    const len = Number(c.req.header('content-length') ?? '0')
    if (len > 64 * 1024) return c.json({ ok: true })
    try {
      const parsed = updateSchema.safeParse(await c.req.json())
      if (parsed.success) await handleUpdate(bot, parsed.data)
    } catch (err) {
      console.warn('[telegram] апдейт не обработан:', err instanceof Error ? err.name : 'error')
    }
    return c.json({ ok: true })
  })
  // Ввод пароля из Mini App: личность — подпись initData (токен бота), а не cookie.
  .post('/password', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'Слишком большой запрос' }, 413) }), async (c) => {
    const body = await parseBody(c, z.object({ initData: z.string().max(4096), password: z.string().max(200) }))
    const bot = await getBot()
    if (!bot) throw apiError(404, 'Бот не настроен')
    const who = verifyInitData(body.initData, botToken(bot))
    if (!who) throw apiError(401, 'Откройте эту страницу кнопкой «Ввести пароль» в чате с ботом')
    const reply = await passwordReply(who.tgUserId, body.password)
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, who.tgUserId) })
    if (sub) await sendToChat(bot, sub.chatId, reply.text)
    const message = reply.text.replace(/<[^>]+>/g, '')
    return reply.ok ? c.json({ ok: true, message }) : c.json({ ok: false, message, error: message }, 400)
  })

// ── Под сессией ─────────────────────────────────────────────────────────────

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 20 символов из 57 без похожих (0/O, 1/l/I) — ≈117 бит; randomInt — без смещения распределения. */
function generatePassword(): string {
  let out = ''
  for (let i = 0; i < 20; i++) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  return out
}

export const telegramRoutes = new Hono<AppEnv>()
  // Своя подписка — любая активная учётка, включая вход через платформу.
  .get('/me', async (c) => {
    const user = c.get('user')
    const bot = await getBot()
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, user.id) })
    const row = await getDb().query.tgLinkTokens.findFirst({ where: eq(tgLinkTokens.userId, user.id) })
    const expiresAt = (row?.usedAt ? row.codeExpiresAt : row?.expiresAt)?.getTime() ?? 0
    const pending = row && expiresAt > Date.now() ? row : null
    return c.json({
      bot: bot ? { username: bot.botUsername, passwordSet: bot.passwordVersion > 0, accepting: passwordAccepting(bot), viaApp: webhookMode() } : null,
      subscription: sub ? describeSubscription(sub, bot) : null,
      pending: pending
        ? {
            stage: pending.usedAt ? ('code' as const) : ('link' as const),
            expiresAt,
            // Чей Telegram открыл ссылку: если не ваш — не вводите код.
            telegram: pending.usedAt ? [pending.displayName, pending.username ? `@${pending.username}` : ''].filter(Boolean).join(' · ') : null,
          }
        : null,
    })
  })
  .post('/me/link', async (c) => c.json(await createLinkToken(c.get('user'))))
  .delete('/me/link', async (c) => {
    await getDb().delete(tgLinkTokens).where(eq(tgLinkTokens.userId, c.get('user').id))
    return c.json({ ok: true })
  })
  .post('/me/confirm', async (c) => {
    const body = await parseBody(c, z.object({ code: z.string().trim().min(6).max(12) }))
    const sub = await confirmLinkCode(c.get('user'), body.code)
    return c.json({ subscription: describeSubscription(sub, await getBot()) })
  })
  .patch('/me', async (c) => {
    const body = await parseBody(c, z.object({ minSeverity: z.enum(['warning', 'critical']), digest: z.boolean() }).partial())
    const [row] = await getDb().update(tgSubscriptions).set(body).where(eq(tgSubscriptions.userId, c.get('user').id)).returning()
    if (!row) throw apiError(404, 'Telegram не подключён')
    return c.json({ subscription: describeSubscription(row, await getBot()) })
  })
  .post('/me/resume', async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, c.get('user').id) })
    if (!sub) throw apiError(404, 'Telegram не подключён')
    return c.json({ subscription: describeSubscription(await resumeSubscription(sub, c.get('user')), await getBot()) })
  })
  .post('/me/stop', async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, c.get('user').id) })
    if (!sub) throw apiError(404, 'Telegram не подключён')
    await suspendSubscription(sub, 'отключено в профиле', 'self')
    return c.json({ ok: true })
  })
  .delete('/me', async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, c.get('user').id) })
    // Остановленную владельцем подписку нельзя «сбросить» отвязкой и подключиться заново.
    if (sub?.ownerLock && c.get('user').role !== 'owner') {
      throw apiError(403, 'Telegram-уведомления этой учётки остановил владелец консоли — отвязать может только он')
    }
    if (sub) await unlinkSubscription(sub, c.get('user').email)
    await getDb().delete(tgLinkTokens).where(eq(tgLinkTokens.userId, c.get('user').id))
    return c.json({ ok: true })
  })
  // ── Бот и подписки — владелец ───────────────────────────────────────────
  .get('/bot', requireRole('owner'), async (c) => {
    const bot = await getBot()
    const rows = await getDb()
      .select({ sub: tgSubscriptions, email: users.email, name: users.name, disabled: users.disabled })
      .from(tgSubscriptions)
      .innerJoin(users, eq(users.id, tgSubscriptions.userId))
      .orderBy(asc(users.email))
      .limit(100)
    const subs = rows.map((r) => ({ ...describeSubscription(r.sub, bot), email: r.email, name: r.name, userDisabled: r.disabled }))
    return c.json({
      mode: webhookMode() ? 'webhook' : 'polling',
      bot: bot
        ? {
            username: bot.botUsername,
            webhookUrl: bot.webhookUrl,
            passwordSet: bot.passwordVersion > 0,
            passwordVersion: bot.passwordVersion,
            passwordChangedAt: bot.passwordChangedAt?.getTime() ?? null,
            passwordChangedBy: bot.passwordChangedBy,
            frozenReason: bot.frozenReason,
            frozenAt: bot.frozenAt?.getTime() ?? null,
            lastCheckAt: bot.lastCheckAt?.getTime() ?? null,
            lastError: bot.lastError,
            pendingUpdates: bot.pendingUpdates,
          }
        : null,
      subscriptions: subs,
      confirmed: subs.filter((s) => s.status === 'active').length,
    })
  })
  .put('/bot', requireRole('owner'), async (c) => {
    const body = await parseBody(c, z.object({ token: z.string().trim().max(256), takeover: z.boolean().default(false) }))
    try {
      await saveBot(body.token, c.get('user').email, { takeover: body.takeover })
    } catch (err) {
      if (err instanceof WebhookTakenError) return c.json({ error: err.message, takeoverUrl: err.url }, 409)
      throw err
    }
    return c.json({ ok: true })
  })
  .delete('/bot', requireRole('owner'), async (c) => {
    await removeBot(c.get('user').email)
    return c.json({ ok: true })
  })
  /** Задать или сменить пароль бота. Пусто — сгенерировать; пароль возвращается один раз. */
  .put('/bot/password', requireRole('owner'), async (c) => {
    const body = await parseBody(c, z.object({ password: z.string().max(200).default('') }))
    const password = body.password.trim() || generatePassword()
    const res = await rotatePassword(password, c.get('user').email)
    return c.json({ password: body.password.trim() ? null : password, version: res.version, prompted: res.affected })
  })
  .post('/bot/unfreeze', requireRole('owner'), async (c) => {
    await unfreezePasswordEntry(c.get('user').email)
    return c.json({ ok: true })
  })
  .post('/subscriptions/:id/suspend', requireRole('owner'), async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.id, parseId(c.req.param('id'))) })
    if (!sub) throw apiError(404, 'Подписка не найдена')
    await suspendSubscription(sub, 'приостановлено владельцем консоли', c.get('user').email, { ownerLock: true })
    return c.json({ ok: true })
  })
  .post('/subscriptions/:id/resume', requireRole('owner'), async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.id, parseId(c.req.param('id'))) })
    if (!sub) throw apiError(404, 'Подписка не найдена')
    await resumeSubscription(sub, c.get('user'))
    return c.json({ ok: true })
  })
  .delete('/subscriptions/:id', requireRole('owner'), async (c) => {
    const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.id, parseId(c.req.param('id'))) })
    if (!sub) throw apiError(404, 'Подписка не найдена')
    await unlinkSubscription(sub, c.get('user').email)
    return c.json({ ok: true })
  })
