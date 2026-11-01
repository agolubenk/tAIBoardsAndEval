/** Схема: Telegram-бот консоли и личные подписки админов (часть server/db/schema.ts). */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, now, ts } from './columns'

// ── Telegram-бот: личные подписки админов ───────────────────────────────────
//
// Один бот на консоль (строка id=1). Подписка — Telegram-аккаунт, привязанный к учётке консоли:
// привязка подтверждается кодом в консоли (сессия владельца учётки) и паролем бота (общий
// пароль от владельца консоли). Уведомления идут только подтвердившим текущую версию пароля.

export const tgBot = sqliteTable('tg_bot', {
  id: integer('id').primaryKey(),
  botTokenEnc: text('bot_token_enc').notNull(),
  botId: text('bot_id').notNull(),
  botUsername: text('bot_username').notNull().default(''),
  /** secret_token вебхука (base64url); перевыпускается при каждой установке вебхука. */
  webhookSecretEnc: text('webhook_secret_enc'),
  /** Адрес вебхука, который поставила консоль; '' — режим опроса (локально). */
  webhookUrl: text('webhook_url').notNull().default(''),
  passwordHash: text('password_hash').notNull().default(''),
  /** Растёт при каждой смене пароля; подписка доставляется, только если подтвердила текущую. */
  passwordVersion: integer('password_version').notNull().default(0),
  passwordChangedAt: ts('password_changed_at'),
  passwordChangedBy: text('password_changed_by'),
  /** Ввод пароля заморожен (подмена вебхука, массовый перебор): снимает владелец. */
  frozenReason: text('frozen_reason'),
  frozenAt: ts('frozen_at'),
  /** Смещение getUpdates в режиме опроса. */
  pollOffset: integer('poll_offset').notNull().default(0),
  lastCheckAt: ts('last_check_at'),
  lastError: text('last_error'),
  pendingUpdates: integer('pending_updates').notNull().default(0),
  updatedAt: ts('updated_at').notNull().default(now),
})

export const tgSubscriptions = sqliteTable(
  'tg_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    botId: text('bot_id').notNull(),
    tgUserId: text('tg_user_id').notNull(),
    chatId: text('chat_id').notNull(),
    username: text('username').notNull().default(''),
    displayName: text('display_name').notNull().default(''),
    /** awaiting_password → active (после ввода пароля); «нужен новый пароль» = active и confirmedVersion < версии бота. */
    state: text('state', { enum: ['awaiting_password', 'active', 'suspended'] })
      .notNull()
      .default('awaiting_password'),
    confirmedVersion: integer('confirmed_version').notNull().default(0),
    /** До какой версии пароля уже отправлена просьба ввести новый (идемпотентная рассылка). */
    promptedVersion: integer('prompted_version').notNull().default(0),
    minSeverity: text('min_severity', { enum: ['warning', 'critical'] })
      .notNull()
      .default('warning'),
    digest: bool('digest').notNull().default(false),
    linkedAt: ts('linked_at').notNull().default(now),
    activatedAt: ts('activated_at'),
    suspendedAt: ts('suspended_at'),
    suspendedReason: text('suspended_reason'),
    suspendedBy: text('suspended_by'),
    /** Приостановлено владельцем или за перебор пароля — возобновляет только владелец. */
    ownerLock: bool('owner_lock').notNull().default(false),
    lastDeliveryAt: ts('last_delivery_at'),
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('idx_tg_sub_user').on(t.userId), uniqueIndex('idx_tg_sub_tg_user').on(t.tgUserId)],
)

/** Одноразовая ссылка t.me/<бот>?start=<токен> (хранится sha256) и код подтверждения для консоли. */
export const tgLinkTokens = sqliteTable(
  'tg_link_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    tgUserId: text('tg_user_id'),
    chatId: text('chat_id'),
    username: text('username'),
    displayName: text('display_name'),
    codeHash: text('code_hash'),
    codeExpiresAt: ts('code_expires_at'),
    codeAttempts: integer('code_attempts').notNull().default(0),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_tg_link_user').on(t.userId)],
)

/** Захват апдейтов Telegram: повтор того же update_id (ретрай вебхука) не обрабатывается дважды. */
export const tgUpdates = sqliteTable(
  'tg_updates',
  {
    botId: text('bot_id').notNull(),
    updateId: integer('update_id').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.botId, t.updateId] }), index('idx_tg_updates_time').on(t.createdAt)],
)

/** Группы и каналы, куда добавлен бот (видны вебхуку): поиск chat id, когда getUpdates занят вебхуком. */
export const tgChats = sqliteTable('tg_chats', {
  chatId: text('chat_id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull().default(''),
  /** Telegram id того, кто добавил бота (my_chat_member.from). */
  addedBy: text('added_by'),
  seenAt: ts('seen_at').notNull().default(now),
})
