/**
 * Подключение бота владельцем, вебхук и фоновые сверки.
 *
 * Вебхук ставится, только если у бота его нет или он уже наш: иначе — 409 и явное «забрать»
 * (локальная консоль на копии прод-базы не должна перехватывать прод). secret_token
 * перевыпускается при каждой установке. Смена бота (другой botId) — все подписки
 * приостанавливаются: у нового бота нет этих чатов.
 */
import { and, eq, isNotNull, lt, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { loginAttempts, tgBot, tgChats, tgLinkTokens, tgSubscriptions, tgUpdates, users } from '../db/schema'
import { getEnv } from '../env'
import { apiError } from '../http-types'
import { decryptSecret, encryptSecret, randomToken, safeEqual } from '../lib/crypto'
import { logActivity } from '../activity'
import { readMarker, writeMarker } from '../settings/store'
import { broadcast } from '../notify/dispatch'
import { escapeHtml } from '../notify/format'
import { introspectPlatformAdmin } from '../auth/sso'
import { ssoEnabled } from '../auth/sso-config'
import { destroyUserSessions } from '../auth/session'
import { callBot, getMe, getWebhookInfo, TelegramError, TOKEN_FORMAT, type WebhookInfo } from './api'
import { BOT_ROW_ID, botToken, getBot, webhookEndpoint, webhookMode, type BotRow } from './store'
import { promptForPassword, suspendForUser, suspendSubscription } from './subscriptions'
import { pruneDialogs } from './restart'

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member']

/** Версия списка команд: у уже подключённого бота список обновляется при следующей проверке, без переподключения. */
const COMMANDS_VERSION = 2
/** Отметка — на бота: после смены бота список ставится заново. */
const commandsMarker = (botId: string | number) => `tg_commands_version:${botId}`

const COMMANDS = [
  { command: 'menu', description: 'Меню: алерты, инциденты, серверы, проверки' },
  { command: 'report', description: 'Срочный отчёт за сутки' },
  { command: 'charts', description: 'Графики за сутки' },
  { command: 'help', description: 'Справка' },
  { command: 'stop', description: 'Отключить уведомления' },
]

async function setWebhook(token: string): Promise<string> {
  const secret = randomToken(32)
  await callBot(token, 'setWebhook', {
    url: webhookEndpoint(),
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    // По одному: захват update_id и счётчики паролей не должны гоняться между параллельными доставками.
    max_connections: 1,
  })
  return secret
}

export class WebhookTakenError extends Error {
  constructor(readonly url: string) {
    super(`У бота уже настроен вебхук на ${url}`)
  }
}

/** Подключить или заменить бота. takeover — явно забрать вебхук у другого адреса. */
export async function saveBot(token: string, actor: string, opts: { takeover?: boolean } = {}): Promise<BotRow> {
  if (!TOKEN_FORMAT.test(token)) throw apiError(400, 'Это не похоже на токен бота (формат 123456789:AA…)')
  let me
  try {
    me = await getMe(token)
  } catch (err) {
    throw apiError(400, `Telegram отклонил токен: ${err instanceof Error ? err.message : String(err)}`)
  }
  const db = getDb()
  const prev = await getBot()
  let webhookSecretEnc: string | null = null
  let webhookUrl = ''
  if (webhookMode()) {
    const info = await getWebhookInfo(token)
    if (info.url && info.url !== webhookEndpoint() && !opts.takeover) throw new WebhookTakenError(info.url)
    webhookSecretEnc = encryptSecret(await setWebhook(token))
    webhookUrl = webhookEndpoint()
  }
  await callBot(token, 'setMyCommands', { commands: COMMANDS })
    .then(() => writeMarker(commandsMarker(me.id), COMMANDS_VERSION))
    .catch(() => undefined)
  const values = {
    botTokenEnc: encryptSecret(token),
    botId: me.id,
    botUsername: me.username,
    webhookSecretEnc,
    webhookUrl,
    lastError: null,
    lastCheckAt: new Date(),
    updatedAt: new Date(),
    // У нового бота своя нумерация апдейтов: смещение старого сделало бы его «глухим».
    ...(prev && prev.botId !== me.id ? { pollOffset: 0 } : {}),
  }
  const [row] = prev
    ? await db.update(tgBot).set(values).where(eq(tgBot.id, BOT_ROW_ID)).returning()
    : await db.insert(tgBot).values({ id: BOT_ROW_ID, ...values }).returning()
  if (!row) throw apiError(500, 'Не удалось сохранить бота')
  if (prev && prev.botId !== me.id) {
    const subs = await db.query.tgSubscriptions.findMany({ where: ne(tgSubscriptions.state, 'suspended'), limit: 100 })
    for (const sub of subs) await suspendSubscription(sub, 'бот консоли сменён — подключите Telegram заново', 'system', { notify: false, bot: row })
  }
  await logActivity('config', `Telegram-бот @${me.username} ${prev ? 'обновлён' : 'подключён'}${opts.takeover ? ' (вебхук забран у другого адреса)' : ''}`, actor, '/settings?tab=integrations')
  return row
}

export async function removeBot(actor: string): Promise<void> {
  const bot = await getBot()
  if (!bot) return
  if (bot.webhookUrl) await callBot(botToken(bot), 'deleteWebhook', {}).catch(() => undefined)
  const db = getDb()
  const subs = await db.query.tgSubscriptions.findMany({ where: ne(tgSubscriptions.state, 'suspended'), limit: 100 })
  for (const sub of subs) await suspendSubscription(sub, 'бот консоли отключён', 'system', { notify: true, bot })
  await db.delete(tgBot).where(eq(tgBot.id, BOT_ROW_ID))
  await logActivity('config', `Telegram-бот @${bot.botUsername} отключён`, actor, '/settings?tab=integrations')
}

export async function unfreezePasswordEntry(actor: string): Promise<void> {
  await getDb().update(tgBot).set({ frozenReason: null, frozenAt: null }).where(eq(tgBot.id, BOT_ROW_ID))
  // Иначе первая же опечатка после разморозки снова заморозила бы ввод (счётчик за сутки).
  await getDb().delete(loginAttempts).where(eq(loginAttempts.key, 'tgpw:global'))
  await logActivity('auth', 'Ввод пароля Telegram-бота снова открыт', actor, '/settings?tab=integrations')
}

/** Секрет вебхука из заголовка X-Telegram-Bot-Api-Secret-Token. */
export function webhookSecretMatches(bot: BotRow, header: string | undefined): boolean {
  if (!header || !bot.webhookSecretEnc) return false
  return safeEqual(header, decryptSecret(bot.webhookSecretEnc))
}

// ── Фоновые сверки (тик) ────────────────────────────────────────────────────

/**
 * Вебхук на месте и без ошибок. Чужой адрес вебхука — токен утёк или бот забрала другая
 * консоль: ввод пароля замораживается, владельцу — сообщение в каналы, кроме Telegram.
 */
export async function checkWebhook(): Promise<WebhookInfo | null> {
  const bot = await getBot()
  if (!bot) return null
  const token = botToken(bot)
  if ((await readMarker(commandsMarker(bot.botId))) !== COMMANDS_VERSION) {
    await callBot(token, 'setMyCommands', { commands: COMMANDS })
      .then(() => writeMarker(commandsMarker(bot.botId), COMMANDS_VERSION))
      .catch(() => undefined)
  }
  const info = await getWebhookInfo(token)
  const db = getDb()
  let lastError: string | null = null
  if (bot.webhookUrl) {
    const ours = webhookEndpoint()
    if (!info.url || (info.url === bot.webhookUrl && bot.webhookUrl !== ours)) {
      // Вебхук пропал (сброшен вручную) или сменился адрес консоли — ставим свой заново.
      const secret = await setWebhook(token)
      await db.update(tgBot).set({ webhookSecretEnc: encryptSecret(secret), webhookUrl: ours }).where(eq(tgBot.id, BOT_ROW_ID))
    } else if (info.url !== bot.webhookUrl && info.url !== ours) {
      lastError = `вебхук бота указывает на чужой адрес: ${info.url}`
      if (!bot.frozenReason) {
        await db.update(tgBot).set({ frozenReason: lastError, frozenAt: new Date() }).where(eq(tgBot.id, BOT_ROW_ID))
        await logActivity('auth', `Telegram-бот: ${lastError} — ввод пароля заморожен`, 'system', '/settings?tab=integrations')
        const text = `⚠️ Telegram-бот консоли перехвачен: ${info.url}. Ввод пароля бота заморожен. Проверьте токен у @BotFather и подключите бота заново.`
        await broadcast('alert', { subject: 'Telegram-бот консоли перехвачен', text, html: escapeHtml(text), payload: { type: 'security', event: 'telegram_webhook_hijack', url: info.url } }, (ch) => ch.kind !== 'telegram')
      }
    } else if (info.lastErrorDate && Date.now() - info.lastErrorDate < 10 * 60_000) {
      lastError = `Telegram не может доставить апдейты: ${info.lastErrorMessage ?? 'ошибка'}`
    } else if (info.pendingUpdates > 20) {
      lastError = `в очереди Telegram ${info.pendingUpdates} необработанных апдейтов`
    }
  } else if (info.url) {
    lastError = `вебхук бота стоит на ${info.url} — эта консоль сообщения не принимает`
  }
  await db.update(tgBot).set({ lastCheckAt: new Date(), lastError, pendingUpdates: info.pendingUpdates }).where(eq(tgBot.id, BOT_ROW_ID))
  return info
}

/**
 * Отзыв доступа в платформе должен останавливать уведомления, даже если человек больше не
 * заходит в консоль (сверка при входе тогда не случается). Недоступность продукта — не отзыв.
 */
export async function sweepSsoSubscriptions(): Promise<void> {
  const env = getEnv()
  const db = getDb()
  const rows = await db
    .select({ sub: tgSubscriptions, user: users })
    .from(tgSubscriptions)
    .innerJoin(users, eq(users.id, tgSubscriptions.userId))
    .where(and(ne(tgSubscriptions.state, 'suspended'), isNotNull(users.platformId)))
    .limit(100)
  // Не дольше половины аренды тика: сверка не должна задерживать проверки и отчёты.
  const deadline = Date.now() + 25_000
  for (const { sub, user } of rows) {
    if (!ssoEnabled(env)) {
      await suspendSubscription(sub, 'вход через платформу выключен в консоли', 'system')
      continue
    }
    if (Date.now() > deadline) break
    const verdict = await introspectPlatformAdmin(env, user.id, user.platformId ?? '')
    // Продукт недоступен или отвечает не по контракту (сменили секрет, выключили SSO) — это не
    // отзыв: остальных не опрашиваем, подписки не трогаем. Владелец увидит ошибку SSO при входе.
    if (verdict === 'outage' || verdict === 'error') break
    if (verdict === 'revoked') {
      await destroyUserSessions(user.id)
      await suspendForUser(user.id, 'доступ к консоли отозван в платформе')
    }
  }
}

export async function pruneTelegramTables(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  await db.delete(tgUpdates).where(lt(tgUpdates.createdAt, new Date(now - 7 * 86_400_000)))
  await db.delete(tgLinkTokens).where(lt(tgLinkTokens.expiresAt, new Date(now - 86_400_000)))
  await db.delete(tgChats).where(lt(tgChats.seenAt, new Date(now - 90 * 86_400_000)))
  await pruneDialogs(now)
}

/** Просьбы ввести пароль, недоставленные при смене (оборвался запрос владельца). */
export async function retryPasswordPrompts(): Promise<void> {
  const bot = await getBot()
  if (bot) await promptForPassword(bot)
}

export async function telegramTick(): Promise<void> {
  if (!(await getBot())) return
  if (webhookMode()) await checkWebhook()
  await retryPasswordPrompts()
}

// ── Опрос (локальный режим) ─────────────────────────────────────────────────

/**
 * Опрос getUpdates — только локально (нет публичного https) и только пока у бота нет вебхука.
 * Отдельный цикл с долгим ожиданием, не в тике: тик не должен ждать Telegram.
 */
export function startPolling(handle: (bot: BotRow, update: unknown) => Promise<void>): () => void {
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      const bot = await getBot().catch(() => null)
      if (!bot || webhookMode()) {
        await sleep(30_000)
        continue
      }
      try {
        const token = botToken(bot)
        const updates = (await callBot(
          token,
          'getUpdates',
          { offset: bot.pollOffset, timeout: 50, allowed_updates: ALLOWED_UPDATES },
          60_000,
        )) as Array<{ update_id: number }>
        let next = bot.pollOffset
        for (const u of updates ?? []) {
          next = Math.max(next, u.update_id + 1)
          await handle(bot, u).catch((err: unknown) => console.warn('[telegram] апдейт не обработан:', err instanceof Error ? err.message : err))
        }
        if (next !== bot.pollOffset) await getDb().update(tgBot).set({ pollOffset: next }).where(eq(tgBot.id, BOT_ROW_ID))
      } catch (err) {
        // 409 — у бота вебхук (прод): локальная консоль его не трогает, просто ждёт.
        const msg = err instanceof TelegramError && err.code === 409 ? 'у бота настроен вебхук — опрос недоступен' : err instanceof Error ? err.message : String(err)
        await getDb().update(tgBot).set({ lastError: msg.slice(0, 300), lastCheckAt: new Date() }).where(eq(tgBot.id, BOT_ROW_ID)).catch(() => undefined)
        await sleep(30_000)
      }
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
