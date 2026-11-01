/**
 * Локальный режим: один процесс — API, собранный SPA (dist/) и фоновый планировщик.
 *   npm start            → http://localhost:8797
 *   npm run dev          → API здесь + Vite (HMR) на :5180 с прокси /api
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app'
import { getEnv } from './env'
import { runMigrations } from './db/migrate'
import { bootstrapOwner } from './auth/session'
import { ensureBuiltinRules } from './alerts/builtin'
import { runTick } from './scheduler/tick'
import { writeMarker } from './settings/store'
import { startPolling } from './telegram/bot'
import { handleUpdate, updateSchema } from './telegram/updates'
import { webhookMode } from './telegram/store'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')

async function main(): Promise<void> {
  const env = getEnv()
  await runMigrations()
  // Отметка старта: пока консоль была выключена, агенты не могли отчитаться (server/agents/silence.ts).
  await writeMarker('up_since', Date.now())
  await ensureBuiltinRules()
  const owner = await bootstrapOwner()
  if (owner === 'not_configured') {
    console.warn('[ops] пользователей нет: задайте OPS_ADMIN_EMAIL и OPS_ADMIN_PASSWORD (.env) и перезапустите — создастся владелец')
  }

  const app = createApp()
  if (existsSync(distDir)) {
    app.use('/assets/*', serveStatic({ root: distDir.replace(`${process.cwd()}/`, '') }))
    // Нет такого ассета — 404, а не index.html: открытая вкладка после пересборки запросит чанк прежней сборки,
    // и HTML с кодом 200 nginx закэшировал бы под его именем надолго (expires max), а модуль упал бы на MIME.
    app.get('/assets/*', (c) => c.notFound())
    // index.html читается на каждый запрос: после пересборки хэши ассетов меняются без рестарта.
    app.get('*', async (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(await readFile(join(distDir, 'index.html'), 'utf8'))))
  }

  // Тело запроса Node ждёт 5 минут (requestTimeout по умолчанию) и потом рвёт его с 408. Вложение в 20 МБ на медленном
  // 3G идёт до 45 минут: страница ждёт до часа (oqfUploadTimeout), сервер — чуть дольше. Медленных клиентов на других
  // путях держит nginx: тело он собирает сам, а здесь ждёт не больше 60 с между порциями (client_body_timeout).
  const serverOptions = { requestTimeout: 65 * 60_000 }
  serve({ fetch: app.fetch, port: env.port, hostname: env.host, serverOptions }, (info) => {
    const db = env.databaseUrl.startsWith('file:') ? env.databaseUrl : 'libSQL (удалённая)'
    console.log(`[ops] консоль: ${env.publicUrl}  (слушает ${env.host}:${info.port}, БД: ${db})`)
  })

  if (env.inProcessScheduler) {
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await runTick()
      } catch (err) {
        console.warn('[ops] tick failed:', err instanceof Error ? err.message : err)
      } finally {
        running = false
      }
    }
    setTimeout(() => void tick(), 2_000)
    setInterval(() => void tick(), env.schedulerIntervalSec * 1000)
    console.log(`[ops] планировщик в процессе: каждые ${env.schedulerIntervalSec} с`)
    // Без публичного https Telegram не достучится до консоли — бот опрашивается отсюда
    // (и только пока у бота нет вебхука: прод-вебхук локальная консоль не трогает).
    if (!webhookMode(env)) {
      startPolling(async (bot, raw) => {
        const parsed = updateSchema.safeParse(raw)
        if (parsed.success) await handleUpdate(bot, parsed.data)
      })
    }
  }
}

main().catch((err: unknown) => {
  console.error('[ops] старт не удался:', err instanceof Error ? err.message : err)
  process.exit(1)
})
