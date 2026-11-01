/**
 * Внешние HTTP-проверки доменов — независимо от агента: если сервер лёг целиком, агент
 * молчит, а эти проверки (из локальной консоли или с Vercel по cron) фиксируют простой.
 */
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { checkResults, checkRollups, monitors } from '../db/schema'
import net from 'node:net'
import dns from 'node:dns/promises'
import { classifyAddress, httpRequest, HttpError, resolveTarget, type HttpTimings } from '../lib/http'
import { getRulesByKind, observe, type Fact } from '../alerts/store'
import { explainCheckFailure } from '../alerts/explain'
import { getEgressAllowlist } from '../settings/store'
import { deployContext } from '../deploys/alerts'

/** Публичные резолверы для DNS-мониторов: имена вне «Внутренних адресов» не резолвятся резолвером контейнера. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8']

type MonitorRow = typeof monitors.$inferSelect

export interface CheckOutcome {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  error: string | null
  /** Фазы HTTP-запроса (DNS, соединение, TLS, первый байт), мс. */
  timings?: HttpTimings
}

export function evaluateResponse(
  m: Pick<MonitorRow, 'expectStatus' | 'expectHealthJson' | 'keyword'>,
  status: number,
  body: string,
): string | null {
  const statusOk = m.expectStatus ? status === m.expectStatus : status >= 200 && status < 400
  if (!statusOk) return `HTTP ${status}`
  if (m.expectHealthJson) {
    let parsed: { status?: unknown } | null = null
    try {
      parsed = JSON.parse(body) as { status?: unknown }
    } catch {
      return 'тело ответа — не JSON'
    }
    if (parsed?.status !== 'ok') return `health: status=${String(parsed?.status ?? 'нет')}`
  }
  if (m.keyword && !body.includes(m.keyword)) return `нет ключевой строки «${m.keyword.slice(0, 40)}»`
  return null
}

export async function runCheck(m: MonitorRow, allowPrivateHosts: readonly string[] = []): Promise<CheckOutcome> {
  if (m.type === 'tcp') return runTcpCheck(m, allowPrivateHosts)
  if (m.type === 'dns') return runDnsCheck(m, allowPrivateHosts)
  try {
    const res = await httpRequest(m.url, {
      method: m.method,
      timeoutMs: m.timeoutMs,
      followRedirects: true,
      allowPrivateHosts,
      freshConnection: true,
    })
    const error = evaluateResponse(m, res.status, res.text)
    return { ok: !error, statusCode: res.status, latencyMs: res.latencyMs, error, timings: res.timings }
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: err instanceof HttpError ? err.latencyMs : 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** «хост:порт» → части; IPv6 — в квадратных скобках. null — не разобрать. */
export function parseHostPort(v: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(v.trim())
  if (!m) return null
  const port = Number(m[2])
  if (port < 1 || port > 65_535) return null
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port }
}

/**
 * TCP: открывается ли соединение (база, Redis, SMTP). Адрес проходит ту же проверку, что и HTTP
 * (внутренние — только из списка разрешённых), соединение — на проверенный IP.
 */
async function runTcpCheck(m: MonitorRow, allowPrivateHosts: readonly string[]): Promise<CheckOutcome> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const hp = parseHostPort(m.url)
  if (!hp) return { ok: false, statusCode: null, latencyMs: 0, error: 'адрес — «хост:порт»' }
  try {
    const target = await resolveTarget(new URL(`http://${hp.host.includes(':') ? `[${hp.host}]` : hp.host}/`), allowPrivateHosts)
    const dnsMs = elapsed()
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: target.address, port: hp.port, family: target.family })
      const timer = setTimeout(() => sock.destroy(new Error(`таймаут ${m.timeoutMs} мс`)), m.timeoutMs)
      sock.once('connect', () => {
        clearTimeout(timer)
        sock.end()
        resolve()
      })
      sock.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    const latency = elapsed()
    return {
      ok: true,
      statusCode: null,
      latencyMs: latency,
      error: null,
      timings: { dnsMs, connectMs: latency - dnsMs, tlsMs: null, ttfbMs: null },
    }
  } catch (err) {
    const code = (err as Error & { code?: string }).code
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      statusCode: null,
      latencyMs: elapsed(),
      error: (code && !msg.includes(code) ? `${msg} (${code})` : msg).slice(0, 300),
    }
  }
}

/** DNS: имя резолвится нужной записью; expectValue — подстрока, которая должна быть в ответе. */
async function runDnsCheck(m: MonitorRow, allowPrivateHosts: readonly string[] = []): Promise<CheckOutcome> {
  const started = performance.now()
  const resolver = new dns.Resolver({ timeout: m.timeoutMs, tries: 1 })
  const host = m.url.trim()
  const allowed = allowPrivateHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)
  // Имя не из «Внутренних адресов» — через публичные резолверы, а не через резолвер контейнера: тот знает
  // имена сервисов Docker, и по ответу «внутренний» / «нет такого имени» оператор перебрал бы их.
  if (!allowed.includes(host.toLowerCase())) resolver.setServers(PUBLIC_RESOLVERS)
  try {
    const raw = await resolver.resolve(host, m.dnsRecord)
    const values = (raw as unknown[]).map((r) =>
      typeof r === 'string'
        ? r
        : Array.isArray(r)
          ? r.join('')
          : typeof r === 'object' && r && 'exchange' in r
            ? String((r as { exchange: string }).exchange)
            : JSON.stringify(r),
    )
    const latency = Math.round(performance.now() - started)
    if (!values.length) return { ok: false, statusCode: null, latencyMs: latency, error: `${m.dnsRecord}: пустой ответ` }
    // Внутренний адрес в ответе — как у HTTP/TCP: только из «Внутренних адресов» и без самого адреса в
    // тексте, иначе «ожидаемое значение» служило бы оракулом для подбора адресов внутренней сети.
    if (m.dnsRecord === 'A' || m.dnsRecord === 'AAAA') {
      const inner = !allowed.includes(host.toLowerCase()) && values.some((v) => classifyAddress(v) !== 'public' && !allowed.includes(v))
      if (inner) {
        return {
          ok: false,
          statusCode: null,
          latencyMs: latency,
          error:
            `${m.dnsRecord}: ${host} указывает на внутренний адрес. Если это ваш сервис — добавьте «${host}» в «Настройки → Общие → Внутренние адреса»; если имя публичное — проверьте запись ${m.dnsRecord} у DNS-провайдера`.slice(
              0,
              300,
            ),
        }
      }
    }
    if (m.expectValue && !values.some((v) => v.includes(m.expectValue!))) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: latency,
        error: `${m.dnsRecord}: нет «${m.expectValue.slice(0, 60)}» — ${values.slice(0, 3).join(', ').slice(0, 160)}`,
      }
    }
    return {
      ok: true,
      statusCode: null,
      latencyMs: latency,
      error: null,
      timings: { dnsMs: latency, connectMs: null, tlsMs: null, ttfbMs: null },
    }
  } catch (err) {
    const code = (err as Error & { code?: string }).code
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.round(performance.now() - started),
      error: `${m.dnsRecord}: ${code ?? (err instanceof Error ? err.message : String(err))}`.slice(0, 300),
    }
  }
}

const HOUR = 3_600_000
const DAY = 86_400_000

async function bumpRollups(monitorId: number, at: number, out: CheckOutcome): Promise<void> {
  const ok = out.ok ? 1 : 0
  const lat = out.ok ? out.latencyMs : 0
  const latN = out.ok ? 1 : 0
  for (const [grain, size] of [
    ['h', HOUR],
    ['d', DAY],
  ] as const) {
    await getDb()
      .insert(checkRollups)
      .values({ monitorId, grain, bucketStart: Math.floor(at / size) * size, total: 1, okCount: ok, latencySum: lat, latencyCount: latN })
      .onConflictDoUpdate({
        target: [checkRollups.monitorId, checkRollups.grain, checkRollups.bucketStart],
        set: {
          total: sql`${checkRollups.total} + 1`,
          okCount: sql`${checkRollups.okCount} + ${ok}`,
          latencySum: sql`${checkRollups.latencySum} + ${lat}`,
          latencyCount: sql`${checkRollups.latencyCount} + ${latN}`,
        },
      })
  }
}

export async function recordCheck(m: MonitorRow, out: CheckOutcome): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.insert(checkResults).values({
    monitorId: m.id,
    ok: out.ok,
    statusCode: out.statusCode,
    latencyMs: out.latencyMs,
    error: out.error,
    dnsMs: out.timings?.dnsMs ?? null,
    connectMs: out.timings?.connectMs ?? null,
    tlsMs: out.timings?.tlsMs ?? null,
    ttfbMs: out.timings?.ttfbMs ?? null,
    createdAt: now,
  })
  await bumpRollups(m.id, now.getTime(), out)
  const [saved] = await db
    .update(monitors)
    .set({
      lastCheckedAt: now,
      lastOk: out.ok,
      lastStatusCode: out.statusCode,
      lastLatencyMs: out.latencyMs,
      lastError: out.error,
      // В SQL, а не от прочитанной строки: ручная проверка (консоль, бот) может идти параллельно плановой.
      failStreak: out.ok ? 0 : sql`${monitors.failStreak} + 1`,
    })
    .where(eq(monitors.id, m.id))
    .returning({ failStreak: monitors.failStreak })
  const failStreak = saved?.failStreak ?? (out.ok ? 0 : m.failStreak + 1)
  const rules = await getRulesByKind('monitor_down')
  if (!rules.length) return
  // Корреляция: падает один адрес или все сразу (тогда, скорее всего, лежит сервер целиком).
  const others = (await db.query.monitors.findMany({ where: eq(monitors.enabled, true), limit: 100 })).filter(
    (x) => x.id !== m.id && x.lastOk !== null,
  )
  const othersUp = others.filter((x) => x.lastOk).length
  const result = out.error ?? (out.statusCode ? `HTTP ${out.statusCode}` : 'нет ответа')
  const facts: Fact[] = [
    ['Адрес', m.url],
    ['Ответ', result],
    ['Время ответа', `${out.latencyMs} мс`],
    ['Сбоев подряд', String(failStreak)],
  ]
  if (others.length)
    facts.push([
      'Другие проверки',
      othersUp === others.length
        ? `${othersUp}/${others.length} отвечают`
        : `${othersUp}/${others.length} отвечают — сбой шире одного адреса`,
    ])
  // Деплой рядом: окно 502 при подъёме стека или регрессия только что выкаченной версии (false-green).
  const deploy = out.ok ? null : await deployContext().catch(() => null)
  if (deploy) facts.push(deploy.fact)
  const hint = explainCheckFailure(out, m.timeoutMs)
  for (const rule of rules) {
    await observe({
      rule,
      fingerprint: `rule:${rule.id}:monitor:${m.id}`,
      breached: !out.ok,
      title: rule.name,
      object: m.name,
      value: result,
      facts,
      hint: deploy ? `${deploy.hint} ${hint}` : hint,
      route: `/monitoring?monitor=${m.id}`,
      recovery: `снова отвечает: ${out.statusCode ? `HTTP ${out.statusCode}` : 'OK'} за ${out.latencyMs} мс`,
    })
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
    }),
  )
}

export async function runDueChecks(now = Date.now()): Promise<number> {
  const all = await getDb().query.monitors.findMany({ where: eq(monitors.enabled, true), limit: 100 })
  const due = all.filter((m) => !m.lastCheckedAt || now - m.lastCheckedAt.getTime() >= m.intervalSec * 1000 - 2000)
  const allow = await getEgressAllowlist()
  await pool(due, 6, async (m) => recordCheck(m, await runCheck(m, allow)))
  return due.length
}
