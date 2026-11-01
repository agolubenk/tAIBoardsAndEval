/**
 * Схема: домены хостов по конфигурации nginx (часть server/db/schema.ts) — то, что отдаёт каждый сервер, даже без
 * внешнего HTTPS-монитора.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { bool, now, ts } from './columns'

/**
 * Домены хоста по конфигурации nginx (агент ≥ 1.5): что отдаёт каждый сервер, даже без внешнего монитора, и что агент
 * увидел у сертификата локальным рукопожатием. Список заменяется целиком, когда агент присылает новый.
 */
export const agentDomains = sqliteTable(
  'agent_domains',
  {
    agentId: text('agent_id').notNull(),
    domain: text('domain').notNull(),
    /** Контейнер nginx, в конфигурации которого найдено имя. */
    source: text('source').notNull().default(''),
    port: integer('port'),
    tls: bool('tls').notNull().default(false),
    issuer: text('issuer').notNull().default(''),
    validTo: ts('valid_to'),
    /** Код отказа проверки сертификата (expired, name_mismatch, untrusted, connect, …). */
    error: text('error'),
    checkedAt: ts('checked_at'),
    /** Конфигурацию не удалось перечитать — имя из прошлого удачного разбора. */
    stale: bool('stale').notNull().default(false),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.domain] })],
)
