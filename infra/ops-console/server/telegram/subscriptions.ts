/**
 * Личные Telegram-подписки: привязка, пароль бота, приостановка, возобновление.
 *
 * Привязка в два независимых доказательства:
 *  1. код из бота вводится в консоли под сессией учётки — Telegram принадлежит тому, кто вошёл
 *     в консоль (подсмотренная ссылка без сессии жертвы не даёт привязать свой Telegram);
 *  2. пароль бота (общий, от владельца консоли) — без него уведомления не идут.
 * Доставка — только подпискам, которые подтвердили ТЕКУЩУЮ версию пароля, у активной учётки,
 * с действующим доступом из платформы (SSO).
 */
import { randomInt } from 'node:crypto'
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { loginAttempts, tgBot, tgLinkTokens, tgSubscriptions, users } from '../db/schema'
import { getEnv } from '../env'
import { apiError, type SessionUser } from '../http-types'
import { hashPassword, randomToken, safeEqual, sha256Hex, verifyPassword } from '../lib/crypto'
import { logActivity } from '../activity'
import { ssoEnabled } from '../auth/sso-config'
import { callBot } from './api'
import { BOT_ROW_ID, botToken, getBot, passwordAccepting, passwordAppUrl, webhookMode, type BotRow } from './store'
import { PASSWORD_BUTTON, T } from './texts'

export type Subscription = typeof tgSubscriptions.$inferSelect
type UserRow = typeof users.$inferSelect

const LINK_TTL_MS = 10 * 60_000
const CODE_TTL_MS = 10 * 60_000
const CODE_MAX_ATTEMPTS = 5
/** Неверных паролей на один Telegram за сутки, после которых подписка приостанавливается до владельца. */
export const PASSWORD_MAX_FAILS = 5
/** Неверных паролей по всем подпискам за сутки, после которых ввод пароля замораживается целиком. */
const PASSWORD_GLOBAL_MAX_FAILS = 20
const DAY = 86_400_000
/**
 * Без свежей сверки с платформой (SSO) дольше этого — уведомления учётке не идут. С запасом на
 * аварию продукта: именно тогда алерты нужнее всего, а отзыв доступа при живом продукте
 * ловится сверкой в тике за 15 минут.
 */
const SSO_FRESH_MS = 3 * DAY

// ── Отправка в чат подписки (best-effort) ───────────────────────────────────

export function passwordKeyboard(): Record<string, unknown> | undefined {
  return webhookMode() ? { inline_keyboard: [[{ text: PASSWORD_BUTTON, web_app: { url: passwordAppUrl() } }]] } : undefined
}

export async function sendToChat(bot: BotRow, chatId: string, html: string, replyMarkup?: Record<string, unknown>): Promise<boolean> {
  try {
    await callBot(botToken(bot), 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
    return true
  } catch (err) {
    console.warn(`[telegram] не отправлено в чат подписки: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

// ── Статус и доставляемость ─────────────────────────────────────────────────

export type SubscriptionStatus = 'awaiting_password' | 'active' | 'reconfirm' | 'suspended'

export function subscriptionStatus(sub: Subscription, bot: BotRow | null): SubscriptionStatus {
  if (sub.state === 'suspended') return 'suspended'
  if (sub.state === 'awaiting_password') return 'awaiting_password'
  return bot && sub.confirmedVersion < bot.passwordVersion ? 'reconfirm' : 'active'
}

/** Единая проверка «этой подписке можно слать» — для алертов, дайджеста и команд бота. */
export function isDeliverable(sub: Subscription, user: Pick<UserRow, 'disabled' | 'platformId' | 'ssoCheckedAt'>, bot: BotRow, now = Date.now()): boolean {
  if (sub.state !== 'active' || sub.botId !== bot.botId) return false
  if (bot.passwordVersion === 0 || sub.confirmedVersion !== bot.passwordVersion) return false
  if (user.disabled) return false
  if (user.platformId !== null) {
    if (!ssoEnabled(getEnv())) return false
    if (!user.ssoCheckedAt || now - user.ssoCheckedAt.getTime() > SSO_FRESH_MS) return false
  }
  return true
}

export interface DeliverableSubscription {
  sub: Subscription
  email: string
}

export async function deliverableSubscriptions(bot: BotRow): Promise<DeliverableSubscription[]> {
  const rows = await getDb()
    .select({ sub: tgSubscriptions, user: users })
    .from(tgSubscriptions)
    .innerJoin(users, eq(users.id, tgSubscriptions.userId))
    .where(and(eq(tgSubscriptions.state, 'active'), eq(tgSubscriptions.botId, bot.botId)))
    .limit(100)
  const now = Date.now()
  return rows.filter((r) => isDeliverable(r.sub, r.user, bot, now)).map((r) => ({ sub: r.sub, email: r.user.email }))
}

// ── Привязка: ссылка → /start → код в консоли ──────────────────────────────

/** Подписку остановил владелец (или перебор пароля) — перепривязка не должна её «размораживать». */
async function assertNotOwnerLocked(userId: number): Promise<void> {
  const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, userId) })
  if (sub?.ownerLock) throw apiError(403, 'Telegram-уведомления этой учётки остановил владелец консоли — возобновить их может только он')
}

export async function createLinkToken(user: SessionUser): Promise<{ url: string; expiresAt: number }> {
  const bot = await getBot()
  if (!bot) throw apiError(409, 'Telegram-бот не настроен — его подключает владелец консоли (Настройки → Интеграции)')
  await assertNotOwnerLocked(user.id)
  const token = randomToken(24)
  const expiresAt = new Date(Date.now() + LINK_TTL_MS)
  const db = getDb()
  // Одна живая ссылка на учётку: новая гасит прежние, в том числе с невведённым кодом.
  await db.delete(tgLinkTokens).where(eq(tgLinkTokens.userId, user.id))
  await db.insert(tgLinkTokens).values({ tokenHash: sha256Hex(token), userId: user.id, expiresAt, createdAt: new Date() })
  return { url: `https://t.me/${bot.botUsername}?start=${token}`, expiresAt: expiresAt.getTime() }
}

export interface TgFrom {
  tgUserId: string
  chatId: string
  username: string
  displayName: string
}

/** /start <токен> в личном чате → код подтверждения (текст ответа бота). */
export async function startWithToken(token: string, from: TgFrom): Promise<string | null> {
  const db = getDb()
  const hash = sha256Hex(token)
  const pending = await db.query.tgLinkTokens.findFirst({ where: eq(tgLinkTokens.tokenHash, hash) })
  // Нет такой ссылки: подписчику — подсказка, незнакомцу — ничего (решает вызывающий, с лимитом).
  if (!pending) {
    const known = await db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, from.tgUserId), columns: { id: true } })
    return known ? T.linkInvalid : null
  }
  // Этот Telegram уже подписан на другую учётку — отказ ДО погашения ссылки: владелец ссылки
  // ещё сможет открыть её из своего Telegram.
  const taken = await db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, from.tgUserId) })
  if (taken && taken.userId !== pending.userId) return T.tgTaken
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const now = Date.now()
  // Погашение одним условным UPDATE: два одновременных /start с одной ссылкой — победит один.
  const [used] = await db
    .update(tgLinkTokens)
    .set({
      usedAt: new Date(now),
      tgUserId: from.tgUserId,
      chatId: from.chatId,
      username: from.username.slice(0, 64),
      displayName: from.displayName.slice(0, 128),
      codeHash: sha256Hex(`${hash}:${code}`),
      codeExpiresAt: new Date(now + CODE_TTL_MS),
    })
    .where(and(eq(tgLinkTokens.tokenHash, hash), isNull(tgLinkTokens.usedAt), gt(tgLinkTokens.expiresAt, new Date(now))))
    .returning({ userId: tgLinkTokens.userId })
  if (!used) return T.linkInvalid
  const user = await db.query.users.findFirst({ where: eq(users.id, used.userId) })
  if (!user || user.disabled) {
    await db.delete(tgLinkTokens).where(eq(tgLinkTokens.tokenHash, hash))
    return T.userDisabled
  }
  return T.linkCode(user.email, code)
}

/** Ссылку из группы гасим, не отвечая: её видели все участники. */
export async function burnToken(token: string): Promise<void> {
  await getDb().delete(tgLinkTokens).where(eq(tgLinkTokens.tokenHash, sha256Hex(token)))
}

/** Код из бота, введённый в консоли под сессией учётки, — привязка Telegram к этой учётке. */
export async function confirmLinkCode(user: SessionUser, code: string): Promise<Subscription> {
  const db = getDb()
  const bot = await getBot()
  if (!bot) throw apiError(409, 'Telegram-бот не настроен')
  const pending = await db.query.tgLinkTokens.findFirst({
    where: and(eq(tgLinkTokens.userId, user.id), isNotNull(tgLinkTokens.usedAt), gt(tgLinkTokens.codeExpiresAt, new Date())),
  })
  if (!pending?.codeHash || !pending.tgUserId || !pending.chatId) {
    throw apiError(409, 'Нет ожидающего подтверждения — откройте ссылку в Telegram ещё раз')
  }
  // Попытка списывается условным UPDATE: параллельные запросы не получат больше пяти попыток.
  const [counted] = await db
    .update(tgLinkTokens)
    .set({ codeAttempts: sql`${tgLinkTokens.codeAttempts} + 1` })
    .where(and(eq(tgLinkTokens.tokenHash, pending.tokenHash), lt(tgLinkTokens.codeAttempts, CODE_MAX_ATTEMPTS)))
    .returning({ attempts: tgLinkTokens.codeAttempts })
  if (!counted) {
    await db.delete(tgLinkTokens).where(eq(tgLinkTokens.tokenHash, pending.tokenHash))
    throw apiError(409, 'Код введён неверно слишком много раз — получите новую ссылку')
  }
  const digits = code.replace(/\D/g, '')
  if (!safeEqual(sha256Hex(`${pending.tokenHash}:${digits}`), pending.codeHash)) {
    if (counted.attempts >= CODE_MAX_ATTEMPTS) {
      await db.delete(tgLinkTokens).where(eq(tgLinkTokens.tokenHash, pending.tokenHash))
      await logActivity('auth', `Telegram: код подключения ${user.email} введён неверно ${CODE_MAX_ATTEMPTS} раз — ссылка погашена`, user.email, '/settings?tab=profile')
      throw apiError(409, 'Код введён неверно слишком много раз — получите новую ссылку')
    }
    throw apiError(400, 'Код не подошёл')
  }
  await db.delete(tgLinkTokens).where(eq(tgLinkTokens.tokenHash, pending.tokenHash))
  await assertNotOwnerLocked(user.id)
  const taken = await db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, pending.tgUserId) })
  if (taken && taken.userId !== user.id) throw apiError(409, 'Этот Telegram уже привязан к другой учётке консоли')
  const previous = await db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, user.id) })
  const values = {
    userId: user.id,
    botId: bot.botId,
    tgUserId: pending.tgUserId,
    chatId: pending.chatId,
    username: pending.username ?? '',
    displayName: pending.displayName ?? '',
    state: 'awaiting_password' as const,
    confirmedVersion: 0,
    // Просьбу ввести пароль отправляем здесь же — тик не должен прислать её второй раз.
    promptedVersion: passwordAccepting(bot) ? bot.passwordVersion : 0,
    linkedAt: new Date(),
    activatedAt: null,
    suspendedAt: null,
    suspendedReason: null,
    suspendedBy: null,
    ownerLock: false,
    lastError: null,
  }
  const [row] = previous
    ? await db.update(tgSubscriptions).set(values).where(eq(tgSubscriptions.id, previous.id)).returning()
    : await db.insert(tgSubscriptions).values(values).returning()
  if (!row) throw apiError(500, 'Не удалось сохранить подписку')
  if (previous && previous.chatId !== row.chatId) await sendToChat(bot, previous.chatId, T.relinkedElsewhere)
  await logActivity('auth', `Telegram подключён к учётке ${user.email} — ждёт пароль бота`, user.email, '/settings?tab=profile')
  await sendToChat(bot, row.chatId, passwordAccepting(bot) ? T.askPassword(Boolean(passwordKeyboard())) : T.noPasswordYet, passwordAccepting(bot) ? passwordKeyboard() : undefined)
  return row
}

// ── Пароль бота ─────────────────────────────────────────────────────────────

async function failuresSince(key: string, sinceMs: number): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gt(loginAttempts.createdAt, new Date(sinceMs))))
  return row?.n ?? 0
}

export type PasswordOutcome =
  | { ok: true; sub: Subscription }
  | { ok: false; reason: 'not_expected' | 'already' | 'frozen' | 'wrong' | 'locked' | 'stale'; left?: number }

/**
 * Проверка пароля бота для подписки tgUserId. Попытка списывается ДО scrypt (счётчик в
 * login_attempts переживает отвязку и перепривязку); незнакомые Telegram сюда не доходят.
 */
export async function submitPassword(tgUserId: string, password: string): Promise<PasswordOutcome> {
  const db = getDb()
  const bot = await getBot()
  const sub = await db.query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, tgUserId) })
  if (!bot || !sub || sub.botId !== bot.botId) return { ok: false, reason: 'not_expected' }
  const status = subscriptionStatus(sub, bot)
  if (status === 'active') return { ok: false, reason: 'already' }
  if (status !== 'awaiting_password' && status !== 'reconfirm') return { ok: false, reason: 'not_expected' }
  if (!passwordAccepting(bot)) return { ok: false, reason: 'frozen' }
  // Попытки считаются и по Telegram, и по учётке: смена Telegram-аккаунта счётчик не обнуляет.
  const keys = [`tgpw:tg:${tgUserId}`, `tgpw:user:${sub.userId}`]
  const now = Date.now()
  await db.insert(loginAttempts).values(keys.map((key) => ({ key, createdAt: new Date(now) })))
  const mine = Math.max(...(await Promise.all(keys.map((k) => failuresSince(k, now - DAY)))))
  if (mine > PASSWORD_MAX_FAILS) return lockForBruteForce(bot, sub)
  // Снимок хэша и версии — одним чтением; активация ниже — только если версия не сменилась.
  const { passwordHash, passwordVersion } = bot
  const candidate = normalizeBotPassword(password)
  const valid = candidate.length > 0 && candidate.length <= 200 && (await verifyPassword(candidate, passwordHash))
  if (!valid) {
    await db.insert(loginAttempts).values({ key: 'tgpw:global', createdAt: new Date(now) })
    const global = await failuresSince('tgpw:global', now - DAY)
    if (global >= PASSWORD_GLOBAL_MAX_FAILS) await freezePasswordEntry(`${global} неверных паролей бота за сутки`)
    if (mine >= PASSWORD_MAX_FAILS) return lockForBruteForce(bot, sub)
    return { ok: false, reason: 'wrong', left: PASSWORD_MAX_FAILS - mine }
  }
  const [active] = await db
    .update(tgSubscriptions)
    .set({ state: 'active', confirmedVersion: passwordVersion, promptedVersion: passwordVersion, activatedAt: new Date() })
    .where(
      and(
        eq(tgSubscriptions.id, sub.id),
        sql`${tgSubscriptions.state} <> 'suspended'`,
        sql`exists (select 1 from ${tgBot} where ${tgBot.id} = ${BOT_ROW_ID} and ${tgBot.passwordVersion} = ${passwordVersion})`,
      ),
    )
    .returning()
  // Пароль сменили, пока шла проверка, — это был уже старый пароль.
  if (!active) return { ok: false, reason: 'stale' }
  await db.delete(loginAttempts).where(inArray(loginAttempts.key, keys))
  const user = await db.query.users.findFirst({ where: eq(users.id, sub.userId), columns: { email: true } })
  await logActivity('auth', `Telegram-уведомления ${user?.email ?? `#${sub.userId}`}: пароль бота подтверждён`, user?.email ?? 'system', '/settings?tab=users')
  return { ok: true, sub: active }
}

async function lockForBruteForce(bot: BotRow, sub: Subscription): Promise<PasswordOutcome> {
  await suspendSubscription(sub, 'слишком много неверных паролей бота', 'system', { ownerLock: true, bot, notify: false })
  return { ok: false, reason: 'locked' }
}

export async function freezePasswordEntry(reason: string): Promise<void> {
  const [row] = await getDb()
    .update(tgBot)
    .set({ frozenReason: reason.slice(0, 300), frozenAt: new Date() })
    .where(and(eq(tgBot.id, BOT_ROW_ID), isNull(tgBot.frozenReason)))
    .returning({ id: tgBot.id })
  if (row) await logActivity('auth', `Ввод пароля Telegram-бота заморожен: ${reason}`, 'system', '/settings?tab=integrations')
}

/** Смена пароля бота: версия растёт атомарно, всем подтвердившим — просьба ввести новый. */
/**
 * Пароль бота сравнивается без пробелов и дефисов: сгенерированный показывается группами
 * («Xk7p Qm2n …»), а с телефона его вводят руками — разделители не должны мешать.
 */
export const normalizeBotPassword = (p: string) => p.replace(/[\s-]+/g, '')

export async function rotatePassword(password: string, actor: string): Promise<{ version: number; affected: number }> {
  const normalized = normalizeBotPassword(password)
  if (normalized.length < 12) throw apiError(400, 'Пароль бота — минимум 12 символов (без пробелов и дефисов)')
  const hash = await hashPassword(normalized)
  const [row] = await getDb()
    .update(tgBot)
    .set({
      passwordHash: hash,
      passwordVersion: sql`${tgBot.passwordVersion} + 1`,
      passwordChangedAt: new Date(),
      passwordChangedBy: actor,
      updatedAt: new Date(),
    })
    .where(eq(tgBot.id, BOT_ROW_ID))
    .returning()
  if (!row) throw apiError(409, 'Сначала подключите бота')
  await logActivity('auth', `Пароль Telegram-бота ${row.passwordVersion === 1 ? 'задан' : 'изменён'} — подписчики подтверждают заново`, actor, '/settings?tab=integrations')
  const affected = await promptForPassword(row)
  return { version: row.passwordVersion, affected }
}

/**
 * Просьба ввести пароль всем, кто ещё не получил её для текущей версии (идемпотентно: вызывается
 * сразу после смены и добивается тиком, если рассылка оборвалась).
 */
export async function promptForPassword(bot: BotRow): Promise<number> {
  if (!passwordAccepting(bot)) return 0
  const db = getDb()
  const due = await db.query.tgSubscriptions.findMany({
    where: and(
      eq(tgSubscriptions.botId, bot.botId),
      sql`${tgSubscriptions.state} <> 'suspended'`,
      lt(tgSubscriptions.promptedVersion, bot.passwordVersion),
      lt(tgSubscriptions.confirmedVersion, bot.passwordVersion),
    ),
    limit: 100,
  })
  let sent = 0
  for (const sub of due) {
    const [claimed] = await db
      .update(tgSubscriptions)
      .set({ promptedVersion: bot.passwordVersion })
      .where(and(eq(tgSubscriptions.id, sub.id), lt(tgSubscriptions.promptedVersion, bot.passwordVersion)))
      .returning({ id: tgSubscriptions.id })
    if (!claimed) continue
    const text = sub.state === 'awaiting_password' ? T.askPassword(Boolean(passwordKeyboard())) : T.passwordRotated
    if (await sendToChat(bot, sub.chatId, text, passwordKeyboard())) sent++
  }
  return sent
}

// ── Приостановка, возобновление, отвязка ────────────────────────────────────

export async function suspendSubscription(
  sub: Subscription,
  reason: string,
  by: string,
  opts: { ownerLock?: boolean; bot?: BotRow | null; notify?: boolean } = {},
): Promise<void> {
  if (sub.state === 'suspended' && !opts.ownerLock) return
  await getDb()
    .update(tgSubscriptions)
    .set({
      state: 'suspended',
      suspendedAt: new Date(),
      suspendedReason: reason.slice(0, 200),
      suspendedBy: by,
      ...(opts.ownerLock ? { ownerLock: true } : {}),
    })
    .where(eq(tgSubscriptions.id, sub.id))
  const user = await getDb().query.users.findFirst({ where: eq(users.id, sub.userId), columns: { email: true } })
  await logActivity('auth', `Telegram-уведомления ${user?.email ?? `#${sub.userId}`} приостановлены: ${reason}`, by, '/settings?tab=users')
  const bot = opts.bot === undefined ? await getBot() : opts.bot
  if (bot && opts.notify !== false && sub.botId === bot.botId) {
    const user2 = await getDb().query.users.findFirst({ where: eq(users.id, sub.userId), columns: { disabled: true } })
    const how = opts.ownerLock || user2?.disabled ? 'owner' : 'self'
    await sendToChat(bot, sub.chatId, T.suspended(reason, how))
  }
}

/** Учётка отключена или лишилась доступа в платформе — её подписка останавливается. */
export async function suspendForUser(userId: number, reason: string, by = 'system'): Promise<void> {
  const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.userId, userId) })
  if (sub && sub.state !== 'suspended') await suspendSubscription(sub, reason, by)
}

/**
 * Возобновление — всегда через ввод пароля заново. Сам пользователь — если учётка активна и
 * подписку не останавливал владелец (или перебор пароля); владелец — любую.
 */
export async function resumeSubscription(sub: Subscription, actor: SessionUser): Promise<Subscription> {
  const db = getDb()
  const isOwner = actor.role === 'owner'
  if (sub.state !== 'suspended') throw apiError(409, 'Подписка не приостановлена')
  if (!isOwner && (sub.userId !== actor.id || sub.ownerLock)) {
    throw apiError(403, 'Эту подписку остановил владелец консоли — возобновить её может только он')
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, sub.userId) })
  if (!user || user.disabled) throw apiError(409, 'Учётка отключена — сначала включите её')
  const bot = await getBot()
  if (!bot || bot.botId !== sub.botId) throw apiError(409, 'Подписка относится к другому боту — подключите Telegram заново')
  const [row] = await db
    .update(tgSubscriptions)
    .set({
      state: 'awaiting_password',
      confirmedVersion: 0,
      promptedVersion: passwordAccepting(bot) ? bot.passwordVersion : 0,
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      ownerLock: false,
    })
    .where(eq(tgSubscriptions.id, sub.id))
    .returning()
  if (!row) throw apiError(404, 'Подписка не найдена')
  await db.delete(loginAttempts).where(inArray(loginAttempts.key, [`tgpw:tg:${sub.tgUserId}`, `tgpw:user:${sub.userId}`]))
  await logActivity('auth', `Telegram-уведомления ${user.email} возобновлены — ждут пароль бота`, actor.email, '/settings?tab=users')
  await sendToChat(bot, row.chatId, passwordAccepting(bot) ? T.resumed : T.noPasswordYet, passwordAccepting(bot) ? passwordKeyboard() : undefined)
  return row
}

export async function unlinkSubscription(sub: Subscription, actor: string): Promise<void> {
  await getDb().delete(tgSubscriptions).where(eq(tgSubscriptions.id, sub.id))
  const user = await getDb().query.users.findFirst({ where: eq(users.id, sub.userId), columns: { email: true } })
  await logActivity('auth', `Telegram отвязан от учётки ${user?.email ?? `#${sub.userId}`}`, actor, '/settings?tab=users')
  const bot = await getBot()
  if (bot && bot.botId === sub.botId) await sendToChat(bot, sub.chatId, T.unlinked)
}

/** Доставка не прошла: бот заблокирован или чат исчез — подписка останавливается, а не копит ошибки. */
export async function noteDeliveryFailure(sub: Subscription, message: string, unreachable: boolean): Promise<void> {
  if (unreachable) {
    await suspendSubscription(sub, 'Telegram недоступен (бот заблокирован или чат удалён)', 'system', { notify: false })
    return
  }
  await getDb().update(tgSubscriptions).set({ lastError: message.slice(0, 300) }).where(eq(tgSubscriptions.id, sub.id))
}

export async function noteDeliverySuccess(subId: number): Promise<void> {
  await getDb().update(tgSubscriptions).set({ lastDeliveryAt: new Date(), lastError: null }).where(eq(tgSubscriptions.id, subId))
}

// ── Представление ───────────────────────────────────────────────────────────

export function describeSubscription(sub: Subscription, bot: BotRow | null) {
  return {
    id: sub.id,
    userId: sub.userId,
    username: sub.username,
    displayName: sub.displayName,
    status: subscriptionStatus(sub, bot),
    minSeverity: sub.minSeverity,
    digest: sub.digest,
    linkedAt: sub.linkedAt.getTime(),
    activatedAt: sub.activatedAt?.getTime() ?? null,
    suspendedAt: sub.suspendedAt?.getTime() ?? null,
    suspendedReason: sub.suspendedReason,
    suspendedBy: sub.suspendedBy,
    ownerLock: sub.ownerLock,
    lastDeliveryAt: sub.lastDeliveryAt?.getTime() ?? null,
    lastError: sub.lastError,
    otherBot: Boolean(bot && sub.botId !== bot.botId),
  }
}
