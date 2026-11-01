/**
 * Маршруты для агента хоста и внешнего планировщика — без сессии, со своей аутентификацией:
 * агент — HMAC-подпись (server/agents/signature.ts), cron — Bearer OPS_CRON_SECRET.
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getEnv } from '../env'
import { apiError, type AppEnv } from '../http-types'
import { safeEqual } from '../lib/crypto'
import { authenticateAgentRequest, verifyAgentRequest } from '../agents/signature'
import { processReport } from '../agents/ingest'
import { runTick } from '../scheduler/tick'
import { recordDeployEvent } from '../deploys/progress'
import { observeDeployDone } from '../deploys/alerts'
import { agentReportSchema, type AgentReportResponse } from '../../shared/agent-contract'
import { DEPLOY_EVENT_MAX_BYTES, deployEventSchema } from '../../shared/deploy-events-contract'
import { clientIp } from '../http-types'
import { isKeyThrottled, recordFailure } from '../auth/session'
import { AGENT_FILES, agentFile, ENROLL_CODE, enrolledEnv, installBaseUrl, installScript, redeemEnrollment, type AgentFile } from '../agents/enroll'
import { z } from 'zod'

/** Попыток обмена кода: на адрес и всего (за окно входа, 15 мин) — подбор 32 символов невозможен, но шум ограничим. */
const ENROLL_MAX_PER_IP = 10
const ENROLL_MAX_GLOBAL = 100

export const agentRoutes = new Hono<AppEnv>()
  /** Код из «Команды установки» → содержимое /etc/hrh-ops-agent.env с новым секретом (текстом). */
  .post(
    '/enroll',
    bodyLimit({
      maxSize: 1024,
      onError: () => {
        throw apiError(400, 'Слишком большой запрос')
      },
    }),
    async (c) => {
      const ip = clientIp(c)
      if ((await isKeyThrottled(`enroll:ip:${ip}`, ENROLL_MAX_PER_IP)) || (await isKeyThrottled('enroll:all', ENROLL_MAX_GLOBAL))) {
        throw apiError(429, 'Слишком много попыток подключения — подождите 15 минут')
      }
      const parsed = z.object({ code: z.string().regex(ENROLL_CODE) }).safeParse(await c.req.json().catch(() => null))
      const done = parsed.success ? await redeemEnrollment(parsed.data.code, ip) : null
      if (!done) {
        await Promise.all([recordFailure(`enroll:ip:${ip}`), recordFailure('enroll:all')])
        throw apiError(403, 'Код недействителен: истёк, уже использован или неверен')
      }
      return c.body(enrolledEnv(done.agentId, done.secret), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    },
  )
  .post(
  '/report',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: () => {
      throw apiError(400, 'Отчёт агента больше 512 КБ')
    },
  }),
  async (c) => {
    const raw = await c.req.text()
    const agent = await verifyAgentRequest({ method: c.req.method, path: new URL(c.req.url).pathname, header: (n) => c.req.header(n) }, raw)
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw apiError(400, 'Отчёт — не JSON')
    }
    const parsed = agentReportSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw apiError(400, `Отчёт не по контракту: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'неизвестно'}`)
    }
    const commands = await processReport(agent, parsed.data)
    // Без внешнего cron (serverless) отчёт агента — попутный повод выполнить созревшие проверки.
    if (!getEnv().inProcessScheduler)
      await runTick({ light: true }).catch((err: unknown) => console.warn('[ops] piggyback tick failed:', err))
    const body: AgentReportResponse = { ok: true, serverTime: Date.now(), commands }
    return c.json(body)
  },
)
  /**
   * События contabo-deploy.sh (infra/scripts/prod/ops-deploy-event.py) под учёткой агента хоста: подпись и
   * окно времени — как у отчёта, метка повтора — своя у карточки деплоя (server/agents/signature.ts).
   */
  .post(
    '/deploy-events',
    bodyLimit({
      maxSize: DEPLOY_EVENT_MAX_BYTES,
      onError: () => {
        throw apiError(400, 'Событие деплоя больше 16 КБ')
      },
    }),
    async (c) => {
      const raw = await c.req.text()
      const { agent, ts } = await authenticateAgentRequest({ method: c.req.method, path: new URL(c.req.url).pathname, header: (n) => c.req.header(n) }, raw)
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        throw apiError(400, 'Событие деплоя — не JSON')
      }
      const parsed = deployEventSchema.safeParse(json)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw apiError(400, `Событие деплоя не по контракту: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'неизвестно'}`)
      }
      const { duplicate } = await recordDeployEvent(agent.id, ts, parsed.data)
      if (parsed.data.type === 'deploy_done' && !duplicate) await observeDeployDone(agent.id, parsed.data.deployId)
      return c.json({ ok: true, duplicate })
    },
  )

async function cronHandler(c: { req: { header: (n: string) => string | undefined }; json: (v: unknown) => Response }): Promise<Response> {
  const secret = getEnv().cronSecret
  if (!secret) throw apiError(503, 'OPS_CRON_SECRET не задан — внешний планировщик выключен')
  const auth = c.req.header('authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${secret}`)) throw apiError(401, 'Неверный токен планировщика')
  return c.json(await runTick())
}

// Vercel Cron вызывает GET; внешние пингеры чаще шлют POST — принимаем оба.
export const cronRoutes = new Hono<AppEnv>().get('/tick', (c) => cronHandler(c)).post('/tick', (c) => cronHandler(c))

/**
 * Публичная раздача установщика и файлов агента (код агента не секрет; секрет — только в ответе
 * /api/agent/enroll по одноразовому коду). Без https-адреса консоли установщик не выдаётся.
 */
export const agentInstallRoutes = new Hono<AppEnv>()
  .get('/install.sh', (c) => {
    const base = installBaseUrl()
    if (!base) throw apiError(503, 'Установка по коду — только при https-адресе консоли (OPS_PUBLIC_URL)')
    return c.body(installScript(base), 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-store' })
  })
  .get('/files/:name', (c) => {
    const name = c.req.param('name') as AgentFile
    if (!AGENT_FILES.includes(name)) throw apiError(404, 'Нет такого файла')
    return c.body(new Uint8Array(agentFile(name)), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  })
