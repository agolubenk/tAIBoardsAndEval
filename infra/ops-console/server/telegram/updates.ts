/**
 * Обработка апдейтов Telegram (вебхук и опрос — один путь).
 *
 * - Каждый update_id захватывается в tg_updates: повтор (ретрай вебхука) не обрабатывается дважды.
 * - Команды — только в личке и только от того, чей это чат (chat.id === from.id, не бот).
 * - В группах бот молчит: лишь запоминает чат для поиска chat id каналов, а ссылку-приглашение,
 *   увиденную в группе, гасит.
 * - Незнакомцам — один нейтральный ответ на /start, не чаще 30 раз в час на всего бота.
 * - Обычный текст подписчика с подтверждённым паролем — шаг диалога перезапуска, если тот идёт
 *   (server/telegram/restart.ts); иначе бот его не трогает.
 * - Текст сообщений не журналируется: в нём может быть пароль.
 */
import { and, count, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { loginAttempts, tgChats, tgSubscriptions, tgUpdates, users } from '../db/schema'
import { callBot } from './api'
import { handleCallback, handleReportCommand } from './actions'
import { handleMenuCallback, handleMenuCommand, isMenuCallback } from './menu/router'
import { handleRestartMessage } from './restart'
import { botToken, type BotRow } from './store'
import {
  burnToken,
  isDeliverable,
  passwordKeyboard,
  sendToChat,
  startWithToken,
  submitPassword,
  subscriptionStatus,
  suspendSubscription,
  PASSWORD_MAX_FAILS,
} from './subscriptions'
import { T } from './texts'
import { webhookMode } from './store'

const chatSchema = z.object({ id: z.number(), type: z.string(), title: z.string().optional() })
const fromSchema = z.object({
  id: z.number(),
  is_bot: z.boolean().default(false),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
})
const messageSchema = z.object({
  message_id: z.number(),
  chat: chatSchema,
  from: fromSchema.optional(),
  text: z.string().max(4096).optional(),
})
export const updateSchema = z
  .object({
    update_id: z.number().int(),
    message: messageSchema.optional(),
    my_chat_member: z
      .object({
        chat: chatSchema,
        from: fromSchema.optional(),
        new_chat_member: z.object({ status: z.string() }).partial().optional(),
      })
      .optional(),
    callback_query: z
      .object({
        id: z.string(),
        from: z.object({ id: z.number(), is_bot: z.boolean().optional() }),
        message: z.object({ message_id: z.number(), chat: z.object({ id: z.number(), type: z.string() }) }).optional(),
        data: z.string().max(64).optional(),
      })
      .optional(),
  })
  .passthrough()
export type TgUpdate = z.infer<typeof updateSchema>

const NEUTRAL_REPLIES_PER_HOUR = 30
const START_TOKEN = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/

/** true — апдейт новый и захвачен этим вызовом; false — уже обрабатывался. */
export async function claimUpdate(botId: string, updateId: number): Promise<boolean> {
  const rows = await getDb()
    .insert(tgUpdates)
    .values({ botId, updateId, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ updateId: tgUpdates.updateId })
  return rows.length > 0
}

export async function handleUpdate(bot: BotRow, update: TgUpdate): Promise<void> {
  if (!(await claimUpdate(bot.botId, update.update_id))) return
  if (update.callback_query) {
    const cq = update.callback_query
    return isMenuCallback(cq.data ?? '') ? handleMenuCallback(bot, cq) : handleCallback(bot, cq)
  }
  if (update.my_chat_member) return handleMembership(bot, update.my_chat_member)
  if (update.message) return handleMessage(bot, update.message)
}

async function handleMembership(bot: BotRow, m: NonNullable<TgUpdate['my_chat_member']>): Promise<void> {
  const status = m.new_chat_member?.status ?? ''
  if (m.chat.type === 'private') {
    // Пользователь заблокировал бота — подписка останавливается сразу, а не на первой ошибке доставки.
    if (status === 'kicked') {
      const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.chatId, String(m.chat.id)) })
      if (sub && sub.botId === bot.botId) await suspendSubscription(sub, 'бот заблокирован в Telegram', 'system', { notify: false, bot })
    }
    return
  }
  await rememberChat(m.chat, status === 'left' || status === 'kicked', m.from && !m.from.is_bot ? String(m.from.id) : null)
}

/**
 * Группы для «Найти чат». addedBy — кто добавил бота: в списке у владельца — только группы,
 * куда бота добавил подписчик консоли (иначе любой мог бы подсунуть группу «Ops Alerts prod»).
 */
async function rememberChat(chat: z.infer<typeof chatSchema>, gone = false, addedBy: string | null = null): Promise<void> {
  const db = getDb()
  if (gone) {
    await db.delete(tgChats).where(eq(tgChats.chatId, String(chat.id)))
    return
  }
  const values = { chatId: String(chat.id), type: chat.type, title: (chat.title ?? '').slice(0, 200), seenAt: new Date() }
  await db
    .insert(tgChats)
    .values({ ...values, addedBy })
    .onConflictDoUpdate({ target: tgChats.chatId, set: { type: values.type, title: values.title, seenAt: values.seenAt, ...(addedBy ? { addedBy } : {}) } })
}

async function neutralReplyAllowed(): Promise<boolean> {
  const db = getDb()
  const [row] = await db
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, 'tg:neutral'), gt(loginAttempts.createdAt, new Date(Date.now() - 3_600_000))))
  if ((row?.n ?? 0) >= NEUTRAL_REPLIES_PER_HOUR) return false
  await db.insert(loginAttempts).values({ key: 'tg:neutral', createdAt: new Date() })
  return true
}

async function handleMessage(bot: BotRow, msg: z.infer<typeof messageSchema>): Promise<void> {
  const text = (msg.text ?? '').trim()
  // «/report@другой_бот» — команда другому боту в той же группе, не нам.
  const cmd = /^\/(report|charts|menu)(?:@(\w+))?(?:\s|$)/.exec(text)
  const ours = cmd && (!cmd[2] || cmd[2].toLowerCase() === bot.botUsername.toLowerCase())
  const reportCmd = ours && cmd[1] !== 'menu' ? (cmd[1] as 'report' | 'charts') : undefined
  const menuCmd = Boolean(ours && cmd[1] === 'menu')
  if (msg.chat.type !== 'private') {
    await rememberChat(msg.chat)
    const token = START_TOKEN.exec(text)?.[1]
    if (token) await burnToken(token)
    // В группе бот отвечает только подписчикам консоли и только на запрос отчёта/графиков.
    if (reportCmd && msg.from && !msg.from.is_bot) await handleReportCommand(bot, String(msg.chat.id), String(msg.from.id), reportCmd)
    if (menuCmd && msg.from && !msg.from.is_bot) await handleMenuCommand(bot, String(msg.chat.id), String(msg.from.id))
    return
  }
  const from = msg.from
  // Личка: команды принимаются только от владельца чата и не от ботов.
  if (!from || from.is_bot || from.id !== msg.chat.id) return
  const chatId = String(msg.chat.id)
  const tgUserId = String(from.id)

  const token = START_TOKEN.exec(text)?.[1]
  if (token) {
    const reply = await startWithToken(token, {
      tgUserId,
      chatId,
      username: from.username ?? '',
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    })
    if (reply) await sendToChat(bot, chatId, reply)
    else if (await neutralReplyAllowed()) await sendToChat(bot, chatId, T.unknown)
    return
  }

  const sub = await getDb().query.tgSubscriptions.findFirst({ where: eq(tgSubscriptions.tgUserId, tgUserId) })
  if (!sub || sub.botId !== bot.botId) {
    if (/^\/start\b/.test(text) && (await neutralReplyAllowed())) await sendToChat(bot, chatId, T.unknown)
    return
  }

  const status = subscriptionStatus(sub, bot)
  if (/^\/help\b/.test(text)) {
    await sendToChat(bot, chatId, status === 'suspended' ? T.notSubscribed : T.help)
    return
  }
  // /start и /menu у подписчика — меню кнопками; без подтверждённого пароля — подсказка.
  if (menuCmd || /^\/start\b/.test(text)) {
    if (!(await handleMenuCommand(bot, chatId, tgUserId))) {
      await sendToChat(bot, chatId, status === 'suspended' ? T.notSubscribed : T.reportNeedsPassword)
    }
    return
  }
  if (reportCmd) {
    if (!(await handleReportCommand(bot, chatId, tgUserId, reportCmd))) {
      await sendToChat(bot, chatId, status === 'suspended' ? T.notSubscribed : T.reportNeedsPassword)
    }
    return
  }
  if (/^\/stop\b/.test(text)) {
    if (status !== 'suspended') await suspendSubscription(sub, 'отключено командой /stop', 'self', { notify: false, bot })
    await sendToChat(bot, chatId, T.stopped)
    return
  }
  if (text.startsWith('/')) {
    await sendToChat(bot, chatId, T.help)
    return
  }
  // Пароль подтверждён — сообщение может быть шагом диалога перезапуска (причина, имя контейнера).
  // Пароль сюда не попадает: его ждут только при awaiting_password / reconfirm.
  if (status === 'active' && (await handleRestartMessage(bot, tgUserId, chatId, text))) return
  if (status !== 'awaiting_password' && status !== 'reconfirm') return
  await handlePasswordMessage(bot, msg.message_id, chatId, tgUserId, text)
}

/**
 * Пароль сообщением. Сообщение удаляется ДО проверки. При публичном https-адресе пароль вводится
 * только кнопкой (Mini App) — сообщение удаляется и не проверяется: пароль, побывавший в
 * переписке, мог уйти дальше.
 */
async function handlePasswordMessage(bot: BotRow, messageId: number, chatId: string, tgUserId: string, password: string): Promise<void> {
  const deleted = await callBot(botToken(bot), 'deleteMessage', { chat_id: chatId, message_id: messageId }).then(
    () => true,
    () => false,
  )
  if (!deleted) await sendToChat(bot, chatId, T.passwordNotDeleted)
  if (webhookMode()) {
    await sendToChat(bot, chatId, T.passwordUseButton, passwordKeyboard())
    return
  }
  await sendToChat(bot, chatId, (await passwordReply(tgUserId, password)).text)
}

/** Ответ на попытку ввода пароля (общий для Mini App и сообщения). */
export async function passwordReply(tgUserId: string, password: string): Promise<{ ok: boolean; text: string }> {
  const res = await submitPassword(tgUserId, password)
  if (res.ok) return { ok: true, text: T.passwordOk(res.sub.minSeverity) }
  switch (res.reason) {
    case 'frozen':
      return { ok: false, text: T.passwordFrozen }
    case 'locked':
      return { ok: false, text: T.passwordLocked }
    case 'wrong':
      return { ok: false, text: T.passwordWrong(res.left ?? 0) }
    case 'stale':
      return { ok: false, text: T.passwordRotated }
    case 'already':
      return { ok: true, text: T.passwordAlready }
    default:
      return { ok: false, text: T.notSubscribed }
  }
}

/** Активна ли подписка этого Telegram (для ответов бота и Mini App). */
export async function activeSubscriptionFor(bot: BotRow, tgUserId: string): Promise<boolean> {
  const row = await getDb()
    .select({ sub: tgSubscriptions, user: users })
    .from(tgSubscriptions)
    .innerJoin(users, eq(users.id, tgSubscriptions.userId))
    .where(eq(tgSubscriptions.tgUserId, tgUserId))
    .limit(1)
  return Boolean(row[0] && isDeliverable(row[0].sub, row[0].user, bot))
}

export { PASSWORD_MAX_FAILS }
