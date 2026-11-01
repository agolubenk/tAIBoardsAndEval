/**
 * Домены хоста из отчёта агента (агент ≥ 1.5, `nginx -T` → server_name): таблица agent_domains и правило tls_expiry
 * для имён, которые не проверяет внешний монитор. Отпечаток алерта общий с внешней проверкой (monitors/tls.ts) —
 * домен, у которого позже появится HTTPS-монитор, продолжит тот же алерт, а не откроет второй.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentDomains, tlsChecks } from '../db/schema'
import type { AgentReport } from '../../shared/agent-contract'
import { getRulesByKind, observe, type AlertRule } from '../alerts/store'
import type { AgentRow } from './signature'

const DAY_MS = 86_400_000
/** Внешняя проверка раз в 6 ч; свежее суток — значит, она жива и алерт по домену ведёт она. */
const EXTERNAL_FRESH_MS = 24 * 3_600_000

type DomainRow = typeof agentDomains.$inferInsert

/**
 * Поля отчёта, которые попадают в подсказку алерта (команда для копирования) — только в своей форме: отчёт подписан
 * секретом агента, но секрет лежит и у консоли, а оператор вставит команду в терминал сервера.
 */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const ERROR_CODES = new Set([
  'expired',
  'name_mismatch',
  'untrusted',
  'not_yet_valid',
  'verify_failed',
  'tls_handshake',
  'connect',
  'unreachable',
])
/** Отказы, при которых срок — того самого сертификата; у недоверенного или выписанного на другое имя срок чужой. */
const DATED_ERRORS = new Set(['expired', 'not_yet_valid'])

/** Unix-секунды агента → Date; мусор (0, отрицательное, за пределами Date) — null, а не Invalid Date в базе. */
function fromUnix(sec: number | undefined): Date | null {
  return sec !== undefined && sec > 0 && sec < 1e11 ? new Date(Math.round(sec * 1000)) : null
}

export function daysLeft(validTo: Date | null | undefined, now = Date.now()): number | null {
  return validTo ? Math.floor((validTo.getTime() - now) / DAY_MS) : null
}

export function domainRows(agentId: string, report: AgentReport, now = new Date()): DomainRow[] {
  const rows = new Map<string, DomainRow>()
  for (const d of report.domains ?? []) {
    const domain = d.name.toLowerCase()
    if (rows.has(domain) || !HOST_NAME.test(domain)) continue
    rows.set(domain, {
      agentId,
      domain,
      source: DOCKER_NAME.test(d.source) ? d.source : '',
      port: d.port ?? null,
      tls: d.tls,
      issuer: d.issuer,
      validTo: fromUnix(d.validTo),
      error: d.error ? (ERROR_CODES.has(d.error) ? d.error : 'verify_failed') : null,
      checkedAt: fromUnix(d.checkedAt),
      stale: d.stale ?? false,
      updatedAt: now,
    })
  }
  return [...rows.values()]
}

/**
 * Список из отчёта заменяет прежний целиком. Нет поля domains — агент старый или список не менялся: ничего не трогаем.
 * Агент обрезал список (найдено больше, чем прислал) — отсутствующее имя не пропало из nginx: не удаляем и не закрываем.
 */
export async function syncDomains(agent: AgentRow, report: AgentReport): Promise<void> {
  if (!report.domains) return
  const db = getDb()
  const rows = domainRows(agent.id, report)
  const truncated = (report.domainsTotal ?? 0) > report.domains.length
  const previous = await db.select({ domain: agentDomains.domain }).from(agentDomains).where(eq(agentDomains.agentId, agent.id)).limit(500)
  if (rows.length)
    await db
      .insert(agentDomains)
      .values(rows)
      .onConflictDoUpdate({
        target: [agentDomains.agentId, agentDomains.domain],
        set: {
          source: sql`excluded.source`,
          port: sql`excluded.port`,
          tls: sql`excluded.tls`,
          issuer: sql`excluded.issuer`,
          validTo: sql`excluded.valid_to`,
          error: sql`excluded.error`,
          checkedAt: sql`excluded.checked_at`,
          stale: sql`excluded.stale`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
  const names = rows.map((r) => r.domain)
  if (!truncated)
    await db
      .delete(agentDomains)
      .where(
        names.length ? and(eq(agentDomains.agentId, agent.id), notInArray(agentDomains.domain, names)) : eq(agentDomains.agentId, agent.id),
      )
  const current = new Set(names)
  await evaluateDomainCerts(agent, rows, truncated ? [] : previous.map((p) => p.domain).filter((d) => !current.has(d)))
}

/** Домены, срок которых уже сторожит живая внешняя проверка: агентский замер их алерт не трогает. */
async function externallyWatched(names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set()
  const since = Date.now() - EXTERNAL_FRESH_MS
  const rows = await getDb()
    .select({ domain: tlsChecks.domain, daysLeft: tlsChecks.daysLeft, checkedAt: tlsChecks.checkedAt })
    .from(tlsChecks)
    .where(inArray(tlsChecks.domain, names))
    .limit(200)
  return new Set(rows.filter((r) => r.daysLeft !== null && r.checkedAt.getTime() > since).map((r) => r.domain))
}

const appliesTo = (rule: AlertRule, agentId: string) => rule.agentId === null || rule.agentId === agentId

export async function evaluateDomainCerts(agent: AgentRow, rows: DomainRow[], vanished: string[]): Promise<void> {
  const rules = (await getRulesByKind('tls_expiry')).filter((r) => appliesTo(r, agent.id))
  if (!rules.length) return
  const watched = await externallyWatched([...rows.map((r) => r.domain), ...vanished])
  const route = `/infrastructure/${agent.id}`
  // Как у внешней проверки: оценивается только известный срок; отказ рукопожатия виден в таблице доменов, не алертом.
  // Срок недоверенного или чужого сертификата не открывает и не закрывает алерт: самоподписанный сертификат до 2099
  // у соседнего nginx иначе «продлил» бы истекающий сертификат продукта.
  const measured = rows.filter(
    (r) => r.tls && !watched.has(r.domain) && daysLeft(r.validTo) !== null && (!r.error || DATED_ERRORS.has(r.error)),
  )
  await Promise.all([
    ...measured.map(async (r) => {
      const left = daysLeft(r.validTo) as number
      const until = r.validTo ? r.validTo.toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '—'
      for (const rule of rules)
        await observe({
          rule,
          fingerprint: `rule:${rule.id}:tls:${r.domain}`,
          breached: left < rule.threshold,
          title: rule.name,
          object: r.domain,
          value: `истекает через ${left} дн. (${until})`,
          facts: [
            ['Действует до', until],
            ['Осталось', `${left} дн. (порог ${rule.threshold})`],
            ['Издатель', r.issuer || '—'],
            ['Где', `${agent.name} · nginx ${r.source || '—'}${r.port ? `:${r.port}` : ''}`],
          ],
          hint: `Сертификат отдаёт nginx в контейнере ${r.source || '?'} — внешнего монитора у домена нет, срок проверил агент хоста. Откуда сертификат: docker exec ${r.source || '<nginx>'} nginx -T | grep -n ssl_certificate; продлевает тот, кто его выпустил (certbot/acme этого стека).`,
          route,
          recovery: `сертификат обновлён: действует до ${until}`,
        })
    }),
    // Домен больше не отдаётся nginx — горящий по нему алерт закрываем, иначе он висел бы вечно.
    ...vanished
      .filter((d) => !watched.has(d))
      .map(async (domain) => {
        for (const rule of rules)
          await observe({
            rule,
            fingerprint: `rule:${rule.id}:tls:${domain}`,
            breached: false,
            title: rule.name,
            object: domain,
            route,
            recovery: `домен больше не обслуживается nginx на ${agent.name}`,
          })
      }),
  ])
}
