/**
 * Помощник настройки Telegram-канала: getMe (проверка токена) + getUpdates (чаты, где бот
 * получал сообщения). Ничего не отправляет и не меняет webhook бота.
 */
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { tgChats } from '../db/schema'
import { apiError } from '../http-types'
import { httpRequest } from '../lib/http'
import { getBot } from '../telegram/store'

const meSchema = z.object({
  ok: z.boolean(),
  result: z.object({ id: z.number().optional(), username: z.string().optional(), first_name: z.string().optional() }).optional(),
  description: z.string().optional(),
})

const chatSchema = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
})
const updatesSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z
    .array(
      z
        .object({
          message: z.object({ chat: chatSchema }).partial().optional(),
          channel_post: z.object({ chat: chatSchema }).partial().optional(),
          my_chat_member: z.object({ chat: chatSchema }).partial().optional(),
        })
        .passthrough(),
    )
    .default([]),
})

const PERSONAL_HINT = 'Личные уведомления в Telegram — через Настройки → Профиль (с паролем бота).'

export interface DiscoveredChat {
  id: string
  type: string
  title: string
}

export async function discoverTelegramChats(token: string): Promise<{ bot: string; chats: DiscoveredChat[]; hint: string | null }> {
  if (!/^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw apiError(400, 'Это не похоже на токен бота (формат 123456789:AA…)')
  const base = `https://api.telegram.org/bot${token}`
  const meRes = await httpRequest(`${base}/getMe`, { timeoutMs: 10_000 })
  const me = meSchema.safeParse(JSON.parse(meRes.text || '{}'))
  if (!me.success || !me.data.ok)
    throw apiError(400, `Telegram отклонил токен: ${me.success ? (me.data.description ?? `HTTP ${meRes.status}`) : 'непонятный ответ'}`)
  // Тот же бот, что у личных подписок: getUpdates занят вебхуком (409), а читать чужие апдейты
  // мимо обработчика нельзя — берём группы, которые вебхук уже видел.
  const own = await getBot()
  if (own && String(me.data.result?.id ?? '') === own.botId) {
    const subscribers = new Set((await getDb().query.tgSubscriptions.findMany({ columns: { tgUserId: true }, limit: 100 })).map((x) => x.tgUserId))
    const seen = await getDb().query.tgChats.findMany({ orderBy: desc(tgChats.seenAt), limit: 50 })
    const chats = seen
      .filter((c) => c.addedBy && subscribers.has(c.addedBy))
      .map((c) => ({ id: c.chatId, type: c.type, title: c.title || c.chatId }))
    return {
      bot: me.data.result?.username ?? '',
      chats,
      hint: chats.length
        ? PERSONAL_HINT
        : `Групп пока нет. Бота в группу должен добавить админ с подключённым Telegram (Настройки → Профиль). ${PERSONAL_HINT}`,
    }
  }
  const upRes = await httpRequest(
    `${base}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message","channel_post","my_chat_member"]')}`,
    { timeoutMs: 10_000, maxBytes: 1024 * 1024 },
  )
  const up = updatesSchema.safeParse(JSON.parse(upRes.text || '{}'))
  if (!up.success || !up.data.ok) {
    // 409 — у бота настроен webhook: getUpdates недоступен, chat id придётся ввести вручную.
    const why = up.success ? (up.data.description ?? `HTTP ${upRes.status}`) : 'непонятный ответ'
    return { bot: me.data.result?.username ?? '', chats: [], hint: `getUpdates недоступен (${why}). Введите chat id вручную.` }
  }
  const byId = new Map<string, DiscoveredChat>()
  for (const u of up.data.result) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat
    if (!chat?.id || !chat.type) continue
    const title =
      chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id)))
    byId.set(String(chat.id), { id: String(chat.id), type: chat.type, title })
  }
  // Канал — для групп. Личные уведомления идут через профиль (код подтверждения + пароль бота):
  // личный чат в канале обошёл бы обе проверки.
  const chats = [...byId.values()].filter((c) => c.type !== 'private')
  return {
    bot: me.data.result?.username ?? '',
    chats,
    hint: chats.length
      ? PERSONAL_HINT
      : `Групп пока нет: добавьте бота в группу, отправьте туда сообщение и нажмите «Найти чат» ещё раз. ${PERSONAL_HINT}`,
  }
}
