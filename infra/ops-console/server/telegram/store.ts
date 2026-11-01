/**
 * Бот консоли (одна строка tg_bot) и режим приёма апдейтов.
 *
 * Вебхук — только при явном публичном https-адресе (OPS_PUBLIC_URL): Telegram стучится к консоли
 * сам. Иначе (локально) — опрос getUpdates отдельным циклом процесса, и только пока у бота нет
 * вебхука: локальная консоль на копии прод-базы не должна снимать вебхук прода.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { tgBot } from '../db/schema'
import { getEnv, type OpsEnv } from '../env'
import { decryptSecret } from '../lib/crypto'

export type BotRow = typeof tgBot.$inferSelect

export const BOT_ROW_ID = 1

export async function getBot(): Promise<BotRow | null> {
  return (await getDb().query.tgBot.findFirst({ where: eq(tgBot.id, BOT_ROW_ID) })) ?? null
}

export const botToken = (bot: BotRow): string => decryptSecret(bot.botTokenEnc)

export function webhookMode(env: OpsEnv = getEnv()): boolean {
  if (!env.publicUrlExplicit) return false
  try {
    const u = new URL(env.publicUrl)
    return u.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

export const webhookEndpoint = (env: OpsEnv = getEnv()) => `${env.publicUrl}/api/telegram/webhook`

/** Страница ввода пароля внутри Telegram (Mini App): пароль не становится сообщением в чате. */
export const passwordAppUrl = (env: OpsEnv = getEnv()) => `${env.publicUrl}/tg/password`

/** Пароль бота задан и ввод не заморожен. */
export const passwordAccepting = (bot: BotRow) => bot.passwordVersion > 0 && bot.passwordHash !== '' && !bot.frozenReason
