/** Общие типы колонок схемы: время — integer мс (одинаково в SQLite и Turso), флаги — 0/1. */
import { sql } from 'drizzle-orm'
import { integer } from 'drizzle-orm/sqlite-core'

export const ts = (name: string) => integer(name, { mode: 'timestamp_ms' })
export const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`
export const bool = (name: string) => integer(name, { mode: 'boolean' })
