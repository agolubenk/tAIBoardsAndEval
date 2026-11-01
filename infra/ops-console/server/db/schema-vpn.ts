/**
 * Схема: WireGuard хоста для владельца (часть server/db/schema.ts). Пиры без внешних адресов лежат в снимке хоста —
 * его видят все роли; здесь то, что видит только владелец: внешние адреса пиров и куда они ходили.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { now, ts } from './columns'

/** Одна строка на агента, переписывается с каждым новым снимком сборщика (раз в ~30 с). */
export const agentVpn = sqliteTable('agent_vpn', {
  agentId: text('agent_id').primaryKey(),
  /** [{ ip, name, endpoint }] — внешний адрес каждого пира. */
  endpointsJson: text('endpoints_json').notNull().default('[]'),
  /** { h1, h24 } — top направлений за час и за сутки (agentVpnSchema.destinations без at). */
  destinationsJson: text('destinations_json').notNull().default('{}'),
  /** Время снимка сборщика, из которого посчитаны окна. */
  capturedAt: ts('captured_at'),
  updatedAt: ts('updated_at').notNull().default(now),
})
