/**
 * Схема: работа дежурного поверх наблюдения (часть server/db/schema.ts) — окна техработ,
 * заметки к алертам, одноразовые коды подключения агентов.
 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { now, ts } from './columns'

/**
 * Техработы: на время окна алерты по объекту не поднимаются и не рассылаются, объект в интерфейсе —
 * «Техработы», а не «Критично». scope=all — вся консоль; agent — хост (target = id агента);
 * monitor — внешняя проверка (target = id монитора).
 */
export const maintenanceWindows = sqliteTable(
  'maintenance_windows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['all', 'agent', 'monitor'] }).notNull(),
    target: text('target').notNull().default(''),
    reason: text('reason').notNull().default(''),
    startsAt: ts('starts_at').notNull().default(now),
    endsAt: ts('ends_at').notNull(),
    createdBy: text('created_by').notNull(),
    /** Завершено досрочно (кнопкой) — окно больше не действует. */
    endedAt: ts('ended_at'),
    endedBy: text('ended_by'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_maintenance_active').on(t.endsAt, t.scope)],
)

/** Комментарий оператора к алерту: «что уже проверили» — видно всем, кто откроет алерт. */
export const alertNotes = sqliteTable(
  'alert_notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    alertId: integer('alert_id').notNull(),
    author: text('author').notNull(),
    message: text('message').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_alert_notes').on(t.alertId, t.createdAt)],
)

/**
 * Одноразовый код подключения агента: владелец получает команду установки с кодом (15 мин),
 * установщик на сервере меняет код на секрет агента. В базе — только sha256 кода.
 */
export const agentEnrollments = sqliteTable(
  'agent_enrollments',
  {
    codeHash: text('code_hash').primaryKey(),
    agentId: text('agent_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    usedFromIp: text('used_from_ip'),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_agent_enrollments_agent').on(t.agentId, t.expiresAt)],
)
