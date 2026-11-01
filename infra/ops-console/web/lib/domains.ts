/**
 * Домены из двух источников в одну строку на имя: внешняя проверка HTTPS-мониторов (/monitors/tls) и конфигурация
 * nginx на хостах (/infra/domains, агент ≥ 1.5). Состояние — худшее из известных: «нет данных» одного источника не
 * прячет «критично» другого и не портит «в норме».
 */
import type { AgentDomain, Alert, TlsCert, UiStatus } from './types'

/** Сертификат на этом входе плохой для любого клиента. */
const CERT_ERRORS: Record<string, string> = {
  expired: 'сертификат истёк',
  name_mismatch: 'сертификат на другое имя',
  not_yet_valid: 'сертификат ещё не действует',
}
/** Плохой для части клиентов (самоподписанный, нет промежуточного) или агент не смог проверить — не повод для красного. */
const SOFT_ERRORS: Record<string, string> = {
  untrusted: 'недоверенная цепочка',
  verify_failed: 'проверка не прошла',
  connect: 'нет соединения с хоста',
  tls_handshake: 'сбой TLS-рукопожатия',
  unreachable: 'вход nginx не виден с хоста',
}

export function domainErrorLabel(code: string): string {
  return CERT_ERRORS[code] ?? SOFT_ERRORS[code] ?? code
}

function byDays(days: number | null): UiStatus {
  if (days === null) return 'unknown'
  return days < 7 ? 'critical' : days < 21 ? 'warning' : 'healthy'
}

export function externalStatus(t: TlsCert): UiStatus {
  return t.error ? 'critical' : byDays(t.daysLeft)
}

export function agentDomainStatus(d: AgentDomain): UiStatus {
  if (!d.tls) return 'unknown'
  if (d.error) return d.error in CERT_ERRORS ? 'critical' : 'warning'
  if (d.checkedAt === null) return 'pending'
  return byDays(d.daysLeft)
}

const KNOWN: Partial<Record<UiStatus, number>> = { critical: 0, warning: 1, healthy: 2 }

export function worseStatus(a: UiStatus, b: UiStatus): UiStatus {
  const ra = KNOWN[a]
  const rb = KNOWN[b]
  if (ra !== undefined && rb !== undefined) return ra <= rb ? a : b
  if (ra !== undefined) return a
  if (rb !== undefined) return b
  return a === 'pending' || b === 'pending' ? 'pending' : a
}

export interface DomainView {
  domain: string
  status: UiStatus
  external: TlsCert | null
  hosts: AgentDomain[]
  issuer: string
  daysLeft: number | null
  /** Что не так у источника, задавшего состояние (подпись для таблицы); null — сертификат в порядке или не проверялся. */
  problem: string | null
  tls: boolean
  checkedAt: number | null
  issues: Alert[]
}

export function mergeDomains(certs: TlsCert[], hosted: AgentDomain[], firing: Alert[]): DomainView[] {
  const views = new Map<string, DomainView>()
  const view = (domain: string): DomainView => {
    let v = views.get(domain)
    if (!v) {
      v = {
        domain,
        status: 'unknown',
        external: null,
        hosts: [],
        issuer: '',
        daysLeft: null,
        problem: null,
        tls: false,
        checkedAt: null,
        issues: [],
      }
      views.set(domain, v)
    }
    return v
  }
  const take = (
    v: DomainView,
    status: UiStatus,
    src: { issuer: string; daysLeft: number | null; error: string | null; checkedAt: number | null },
  ) => {
    const next = worseStatus(v.status, status)
    // Подписи (издатель, срок, ошибка) — от источника, который задал итоговое состояние; при равенстве — первого.
    if (next !== v.status || v.checkedAt === null) {
      v.issuer = src.issuer || v.issuer
      v.daysLeft = src.daysLeft
      v.problem = src.error ? domainErrorLabel(src.error) : null
    }
    v.status = next
    if (src.checkedAt !== null && (v.checkedAt === null || src.checkedAt > v.checkedAt)) v.checkedAt = src.checkedAt
  }
  for (const t of certs) {
    const v = view(t.domain.toLowerCase())
    v.external = t
    v.tls = true
    take(v, externalStatus(t), t)
  }
  for (const d of hosted) {
    const v = view(d.domain)
    v.hosts.push(d)
    v.tls ||= d.tls
    take(v, agentDomainStatus(d), d)
  }
  for (const a of firing) {
    // Отпечаток правила tls_expiry: rule:<id>:tls:<домен> — и у внешней проверки, и у агентской.
    const m = /:tls:(.+)$/.exec(a.fingerprint)
    const v = m ? views.get(m[1]!) : undefined
    if (v) v.issues.push(a)
  }
  return [...views.values()]
}
