/**
 * Применение миграций drizzle-kit (server/db/migrations). Локальный сервер вызывает это
 * при старте; на Vercel — шаг сборки (`npm run db:migrate`), не рантайм функции.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { getDb } from './client'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder })
}
