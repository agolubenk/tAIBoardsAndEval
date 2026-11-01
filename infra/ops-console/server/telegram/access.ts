/**
 * Кто нажал кнопку или прислал команду и что ему можно в этом чате (общее для отчётов, кнопок
 * алертов и меню). Подписчик — доставляемая подписка (учётка активна, пароль бота подтверждён), по
 * from.id. В личке — всё на чтение; в группе показ данных — уже рассылка: роль не ниже оператора и
 * только группа, подключённая каналом консоли с тем же ботом.
 */
import { and, count, eq, gt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { channels, loginAttempts, tgSubscriptions, users } from '../db/schema'
import { roleAtLeast, type Role } from '../http-types'
import { decryptJson } from '../lib/crypto'
import { botToken, type BotRow } from './store'
import { isDeliverable } from './subscriptions'

export interface Actor {
  userId: number
  email: string
  role: Role
  chatId: string
}

/** Подписчик, от имени которого пришла команда или нажатие; null — чужой или не подтвердил пароль. */
export async function actorFor(bot: BotRow, tgUserId: string): Promise<Actor | null> {
  const [row] = await getDb()
    .select({ sub: tgSubscriptions, user: users })
    .from(tgSubscriptions)
    .innerJoin(users, eq(users.id, tgSubscriptions.userId))
    .where(eq(tgSubscriptions.tgUserId, tgUserId))
    .limit(1)
  if (!row || !isDeliverable(row.sub, row.user, bot)) return null
  return { userId: row.user.id, email: row.user.email, role: row.user.role, chatId: row.sub.chatId }
}

/** Группа подключена каналом консоли с тем же ботом (туда и так уходят алерты и отчёты). */
export async function isConsoleChannelChat(bot: BotRow, chatId: string): Promise<boolean> {
  const rows = await getDb().query.channels.findMany({ where: and(eq(channels.kind, 'telegram'), eq(channels.enabled, true)), limit: 100 })
  const token = botToken(bot)
  return rows.some((ch) => {
    const config = JSON.parse(ch.configJson) as { chatId?: unknown }
    return String(config.chatId ?? '') === chatId && decryptJson(ch.secretEnc).botToken === token
  })
}

/** Можно ли этому человеку отправить отчёт в этот чат; null — можно, иначе — почему нет. */
export async function deliveryRefusal(bot: BotRow, actor: Actor, chatId: string): Promise<string | null> {
  if (chatId === actor.chatId) return null
  if (!roleAtLeast(actor.role, 'operator')) return 'Отчёты и графики в группу запрашивает оператор консоли. Вам — в личке с ботом: /report, /charts.'
  if (!(await isConsoleChannelChat(bot, chatId)))
    return 'Эта группа не подключена каналом консоли — отчёты сюда не отправляются. Подключить — в консоли: Алерты → Каналы.'
  return null
}

export async function recentCount(key: string, windowMs: number): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.key, key), gt(loginAttempts.createdAt, new Date(Date.now() - windowMs))))
  return row?.n ?? 0
}

/**
 * «Не чаще раза в windowMs» по ключу: true — можно (и отметка поставлена), false — рано.
 * Обработка апдейтов последовательная (вебхук с max_connections=1), гонки между проверкой и
 * отметкой нет.
 */
export async function takeOnce(key: string, windowMs: number): Promise<boolean> {
  if ((await recentCount(key, windowMs)) > 0) return false
  await getDb().insert(loginAttempts).values({ key, createdAt: new Date() })
  return true
}

/** Отказ в группе (нет прав, не канал) — не чаще раза в 5 минут на чат: иначе им можно засыпать любую группу с ботом. */
export const refusalAllowed = (chatId: string) => takeOnce(`tg:rl:refuse:${chatId}`, 5 * 60_000)
