/** Схема: очередь владельца (часть server/db/schema.ts). Спека — docs/specs/owner-queue.md. */
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { now, ts } from './columns'

// Документы — как в базе артефакта claude.ai, откуда очередь переехала 18.10.2026: коллекции checks
// (ответы владельца и статусы агентов), items (пункты от сессий), work (задачи «Хода работ»). Формат
// документа тот же, поэтому страница артефакта (/queue) и протокол агентов работают без переделки.
export const oqDocs = sqliteTable(
  'oq_docs',
  {
    collection: text('collection').notNull(),
    id: text('id').notNull(),
    dataJson: text('data_json').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().default(now),
    updatedAt: ts('updated_at').notNull().default(now),
    updatedBy: text('updated_by').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.collection, t.id] }), index('idx_oq_docs_updated').on(t.collection, t.updatedAt)],
)

/** Журнал изменений: кто, когда и что поменял (история пункта, разбор «кто нажал»). */
export const oqEvents = sqliteTable(
  'oq_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: ts('at').notNull().default(now),
    actor: text('actor').notNull(),
    collection: text('collection').notNull(),
    docId: text('doc_id').notNull(),
    action: text('action').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
  },
  (t) => [index('idx_oq_events_doc').on(t.collection, t.docId, t.at), index('idx_oq_events_at').on(t.at)],
)

/**
 * Вложения входящих (файлы к задачам владельца): метаданные, сам файл — на диске (`<OQ_FILES_DIR>/<id>`), без имени
 * и расширения в пути. Имя — только для показа (очищенное). Один и тот же файл в одном пункте — одна живая строка.
 * Истёк срок хранения — строка остаётся надгробием (`deleted_at`, `deleted_reason: retention`): карточка и агент видят
 * «файлы удалены по сроку», а не «файлов не было». Удаление владельцем — без следа (в имени могут быть ПДн).
 */
export const oqFiles = sqliteTable(
  'oq_files',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    name: text('name').notNull(),
    /** image · pdf · doc · sheet · text — по содержимому, не по mimetype клиента. */
    kind: text('kind').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: ts('created_at').notNull().default(now),
    createdBy: text('created_by').notNull(),
    deletedAt: ts('deleted_at'),
    deletedReason: text('deleted_reason'),
  },
  (t) => [
    index('idx_oq_files_item').on(t.itemId),
    uniqueIndex('idx_oq_files_item_sha').on(t.itemId, t.sha256).where(sql`deleted_at IS NULL`),
  ],
)

/** Токены агентов и бота: в БД только sha256, сам токен показывается один раз при выпуске. */
export const oqTokens = sqliteTable(
  'oq_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    hash: text('hash').notNull(),
    /** Через запятую: read · agent · owner. */
    scopes: text('scopes').notNull(),
    createdAt: ts('created_at').notNull().default(now),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('idx_oq_tokens_hash').on(t.hash)],
)
