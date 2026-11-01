/**
 * Подготовка базы: миграции, встроенные правила, первый владелец из OPS_ADMIN_*.
 * Локально это делает и server/local.ts при старте; на Vercel — шаг сборки (vercel.json).
 */
import { runMigrations } from './migrate'
import { ensureBuiltinRules } from '../alerts/builtin'
import { bootstrapOwner } from '../auth/session'

async function main(): Promise<void> {
  await runMigrations()
  await ensureBuiltinRules()
  const owner = await bootstrapOwner()
  console.log(`[ops] migrations applied; owner: ${owner}`)
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[ops] migrations failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
