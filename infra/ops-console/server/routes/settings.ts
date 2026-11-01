/** Настройки консоли: общие, GitHub, отчёты ИИ-совету. Чтение — всем, запись — владельцу. */
import { Hono } from 'hono'
import { z } from 'zod'
import { requireRole } from '../auth/middleware'
import { apiError, type AppEnv } from '../http-types'
import { decryptSecret, encryptSecret, maskSecret } from '../lib/crypto'
import { assertSafeUrl } from '../lib/http'
import { parseBody } from '../lib/validate'
import { logActivity } from '../activity'
import { getEnv } from '../env'
import {
  readMarker,
  readReportPeriod,
  generalSettingsSchema,
  getGeneralSettings,
  getGithubSettings,
  getReportSettings,
  writeSetting,
} from '../settings/store'
import { resolveReceiver } from '../reports/deliver'

const safeMask = (enc: string | null) => {
  if (!enc) return null
  try {
    return maskSecret(decryptSecret(enc))
  } catch {
    return '•••• (не расшифровывается — перевыпустите)'
  }
}

const urlOrEmpty = z
  .string()
  .trim()
  .max(1024)
  .refine((u) => {
    if (!u) return true
    try {
      return assertSafeUrl(u).protocol === 'https:' || !getEnv().isProduction
    } catch {
      return false
    }
  }, 'нужен https-адрес без учётных данных')

/** Не владельцу — только origin: путь приёмника может сам быть секретом. */
function redactUrl(url: string): string {
  if (!url) return ''
  try {
    return `${new URL(url).origin}/…`
  } catch {
    return '…'
  }
}

export const settingsRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const [general, github, reports, lastTick, receiver] = await Promise.all([
      getGeneralSettings(),
      getGithubSettings(),
      getReportSettings(),
      readMarker('tick'),
      resolveReceiver(),
    ])
    const env = getEnv()
    return c.json({
      general,
      github: { repo: github.repo, workflow: github.workflow, tokenMask: safeMask(github.tokenEnc) },
      reports: {
        enabled: reports.enabled,
        period: reports.period,
        hourUtc: reports.hourUtc,
        destinationUrl: c.get('user').role === 'owner' ? reports.destinationUrl : redactUrl(reports.destinationUrl),
        secretMask: safeMask(reports.secretEnc),
        lastPeriodKey: (await readReportPeriod()) || reports.lastPeriodKey,
        /** Куда уйдёт следующий отчёт: свой приёмник, продукт по связке входа через платформу, никуда — или свой сломан. */
        receiver: receiver.mode,
        receiverError: receiver.mode === 'broken' ? receiver.error : null,
      },
      runtime: {
        publicUrl: env.publicUrl,
        scheduler: env.inProcessScheduler ? `в процессе, каждые ${env.schedulerIntervalSec} с` : 'внешний (Vercel Cron / пингер)',
        cronConfigured: Boolean(env.cronSecret),
        database: env.databaseUrl.startsWith('file:') ? 'локальный файл SQLite' : 'Turso / libSQL',
        lastTickAt: lastTick || null,
      },
    })
  })
  .put('/general', requireRole('owner'), async (c) => {
    const body = await parseBody(c, generalSettingsSchema)
    await writeSetting('general', body)
    await logActivity('config', 'Изменены общие настройки', c.get('user').email, '/settings')
    return c.json({ general: body })
  })
  .put('/github', requireRole('owner'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        repo: z
          .string()
          .trim()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'формат owner/repo'),
        workflow: z
          .string()
          .trim()
          .regex(/^[\w.-]+$/),
        token: z.string().trim().max(300).default(''),
        clearToken: z.boolean().default(false),
      }),
    )
    const prev = await getGithubSettings()
    const tokenEnc = body.clearToken ? null : body.token ? encryptSecret(body.token) : prev.tokenEnc
    await writeSetting('github', { repo: body.repo, workflow: body.workflow, tokenEnc, mergeTokenEnc: prev.mergeTokenEnc })
    await logActivity(
      'config',
      `GitHub: ${body.repo} / ${body.workflow}${body.token ? ' (новый токен)' : ''}`,
      c.get('user').email,
      '/settings?tab=integrations',
    )
    return c.json({ ok: true })
  })
  .put('/reports', requireRole('owner'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        enabled: z.boolean(),
        period: z.enum(['daily', 'weekly']),
        hourUtc: z.number().int().min(0).max(23),
        destinationUrl: urlOrEmpty,
        secret: z.string().trim().max(300).default(''),
        clearSecret: z.boolean().default(false),
      }),
    )
    const prev = await getReportSettings()
    // Ключ подписи привязан к адресу приёмника: при смене адреса его вводят заново.
    const urlChanged = Boolean(prev.destinationUrl) && body.destinationUrl !== prev.destinationUrl
    if (urlChanged && body.destinationUrl && prev.secretEnc && !body.secret && !body.clearSecret) {
      throw apiError(400, 'Адрес приёмника изменился — введите ключ подписи заново')
    }
    const secretEnc = body.clearSecret || (urlChanged && !body.secret) ? null : body.secret ? encryptSecret(body.secret) : prev.secretEnc
    await writeSetting('reports', {
      ...prev,
      enabled: body.enabled,
      period: body.period,
      hourUtc: body.hourUtc,
      destinationUrl: body.destinationUrl,
      secretEnc,
    })
    await logActivity(
      'config',
      `Отчёты ИИ-совету: ${body.enabled ? `${body.period === 'daily' ? 'ежедневно' : 'еженедельно'} в ${body.hourUtc}:00 UTC` : 'выключены'}`,
      c.get('user').email,
      '/reports',
    )
    return c.json({ ok: true })
  })
