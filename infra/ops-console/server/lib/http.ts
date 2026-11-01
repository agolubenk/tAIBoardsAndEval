/**
 * Исходящие HTTP-запросы консоли — единственный путь наружу (проверки, Telegram, webhook,
 * GitHub, отчёты). Адреса часть задают пользователи, поэтому здесь защита от SSRF:
 *
 * - схема только http/https, учётные данные в URL запрещены;
 * - имя резолвится заранее, и каждый адрес должен быть публичным: loopback, частные сети
 *   (RFC 1918, ULA), CGNAT, link-local (метаданные облака), multicast и служебные диапазоны
 *   отклоняются;
 * - соединение закреплено на проверенном адресе (свой `lookup`) — повторный DNS-ответ
 *   (rebinding) не подменит цель; TLS проверяется по исходному имени;
 * - редиректы — только вручную, каждый шаг проходит ту же проверку, не больше 5;
 * - внутренние адреса допустимы только по явному списку владельца (`allowPrivateHosts`),
 *   и даже тогда link-local и «0.0.0.0» не открываются.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'

/** Фазы последнего запроса (после редиректов), мс; null — фазы не было (переиспользованное соединение, http). */
export interface HttpTimings {
  dnsMs: number | null
  connectMs: number | null
  tlsMs: number | null
  ttfbMs: number | null
}

export interface HttpResult {
  status: number
  ok: boolean
  text: string
  latencyMs: number
  /** Есть у настоящего запроса; у подменённого в тестах — может не быть. */
  timings?: HttpTimings
}

export interface HttpOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  /** Сколько байт тела читать максимум (по умолчанию 256 КБ). */
  maxBytes?: number
  /** Следовать редиректам (проверки доступности) или нет (webhook, отчёты). */
  followRedirects?: boolean
  /** Хосты/IP, которым владелец явно разрешил быть внутренними (Настройки → Общие). */
  allowPrivateHosts?: readonly string[]
  /**
   * Новое соединение на каждый запрос (проверки доступности): переиспользованный keep-alive сокет
   * прячет DNS, TCP и TLS — задержка выглядела бы меньше, чем у нового посетителя, а сбой TLS
   * обнаружился бы только после разрыва соединения.
   */
  freshConnection?: boolean
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly latencyMs: number,
  ) {
    super(message)
  }
}

const MAX_REDIRECTS = 5

export function assertSafeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('некорректный URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('разрешены только http и https')
  if (url.username || url.password) throw new Error('учётные данные в URL запрещены')
  return url
}

// ── Классификация адресов ───────────────────────────────────────────────────

/** Никогда не открываются, даже по списку владельца: метаданные облака, «любой адрес». */
const ALWAYS_BLOCKED = new net.BlockList()
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4')
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4')
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4')
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4')
ALWAYS_BLOCKED.addAddress('::', 'ipv6')
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6')
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6')

/** Внутренние: открываются только хостам из списка владельца. */
const PRIVATE = new net.BlockList()
for (const [net4, bits] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
] as const)
  PRIVATE.addSubnet(net4, bits, 'ipv4')
PRIVATE.addAddress('::1', 'ipv6')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('100::', 64, 'ipv6')
PRIVATE.addSubnet('2001:db8::', 32, 'ipv6')

/** IPv4, спрятанный в IPv6 (::ffff:a.b.c.d, NAT64 64:ff9b::/96), проверяется как IPv4. */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return dotted[1] ?? null
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (!hex) return null
  const hi = parseInt(hex[1] ?? '0', 16)
  const lo = parseInt(hex[2] ?? '0', 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export type AddressClass = 'public' | 'private' | 'blocked'

export function classifyAddress(ip: string): AddressClass {
  const v4 = net.isIPv4(ip) ? ip : embeddedIpv4(ip)
  if (v4) {
    if (ALWAYS_BLOCKED.check(v4, 'ipv4')) return 'blocked'
    return PRIVATE.check(v4, 'ipv4') ? 'private' : 'public'
  }
  if (!net.isIPv6(ip)) return 'blocked'
  if (ALWAYS_BLOCKED.check(ip, 'ipv6')) return 'blocked'
  return PRIVATE.check(ip, 'ipv6') ? 'private' : 'public'
}

interface ResolvedTarget {
  address: string
  family: 4 | 6
}

export async function resolveTarget(url: URL, allowPrivateHosts: readonly string[] = []): Promise<ResolvedTarget> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const allowed = allowPrivateHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) as 4 | 6 }] : await dnsLookup(host, { all: true, verbatim: true })
  if (!addrs.length) throw new Error(`${host}: адрес не найден`)
  // Все адреса имени должны пройти проверку: иначе резолвер мог бы выдать «внешний + внутренний».
  for (const a of addrs) {
    const cls = classifyAddress(a.address)
    // Сам адрес в текст не попадает: ошибку видит оператор, а внутренние адреса сети — не его данные.
    if (cls === 'blocked') throw new Error(`${host}: адрес запрещён для исходящих запросов`)
    if (cls === 'private' && !allowed.includes(host) && !allowed.includes(a.address)) {
      throw new Error(`${host}: внутренний адрес. Если это ваш сервис — добавьте «${host}» в «Настройки → Общие → Внутренние адреса»`)
    }
  }
  const first = addrs[0]!
  return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

/** lookup, который всегда возвращает уже проверенный адрес (защита от DNS rebinding). */
function pinnedLookup(target: ResolvedTarget): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }])
    else callback(null, target.address, target.family)
  }) as unknown as LookupFunction
}

// ── Запрос ──────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  location: string | null
  text: string
  timings: Omit<HttpTimings, 'dnsMs'>
}

function once(url: URL, target: ResolvedTarget, opts: HttpOptions, signal: AbortSignal): Promise<RawResponse> {
  const transport = url.protocol === 'https:' ? https : http
  const maxBytes = opts.maxBytes ?? 256 * 1024
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    let tConnect: number | null = null
    let tTls: number | null = null
    let tFirst: number | null = null
    const ms = (v: number) => Math.max(0, Math.round(v))
    const timings = () => ({
      connectMs: tConnect === null ? null : ms(tConnect - t0),
      tlsMs: tTls === null || tConnect === null ? null : ms(tTls - tConnect),
      ttfbMs: tFirst === null ? null : ms(tFirst - (tTls ?? tConnect ?? t0)),
    })
    const req = transport.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: {
          'User-Agent': 'hrh-ops-console/1.0',
          ...opts.headers,
          ...(opts.body ? { 'Content-Length': Buffer.byteLength(opts.body) } : {}),
        },
        lookup: pinnedLookup(target),
        ...(opts.freshConnection ? { agent: false } : {}),
        signal,
      },
      (res) => {
        tFirst = performance.now()
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          if (total >= maxBytes) return
          chunks.push(chunk)
          total += chunk.length
          if (total >= maxBytes) res.destroy()
        })
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
            text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
            timings: timings(),
          })
        res.on('end', finish)
        res.on('close', finish)
        res.on('error', reject)
      },
    )
    // Фазы соединения: у переиспользованного keep-alive сокета их нет — останутся null.
    req.on('socket', (sock) => {
      sock.once('connect', () => (tConnect = performance.now()))
      sock.once('secureConnect', () => (tTls = performance.now()))
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

export async function httpRequest(rawUrl: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 10_000
  const signal = AbortSignal.timeout(timeoutMs)
  let url = assertSafeUrl(rawUrl)
  try {
    for (let hop = 0; ; hop += 1) {
      const tDns = performance.now()
      const target = await resolveTarget(url, opts.allowPrivateHosts)
      const dnsMs = Math.round(performance.now() - tDns)
      const res = await once(url, target, opts, signal)
      const redirect = res.status >= 300 && res.status < 400 && res.location
      if (!redirect || !opts.followRedirects) {
        return {
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          text: opts.method === 'HEAD' ? '' : res.text,
          latencyMs: Date.now() - started,
          timings: { dnsMs, ...res.timings },
        }
      }
      if (hop >= MAX_REDIRECTS) throw new Error(`больше ${MAX_REDIRECTS} редиректов`)
      // Каждый шаг редиректа — новая проверка схемы, учётных данных и адреса.
      url = assertSafeUrl(new URL(res.location as string, url).toString())
    }
  } catch (err) {
    throw new HttpError(describeError(err, timeoutMs), Date.now() - started)
  }
}

function describeError(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err).slice(0, 300)
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `таймаут ${timeoutMs} мс`
  const code = (err as Error & { code?: string }).code
  return (code && !err.message.includes(code) ? `${err.message} (${code})` : err.message).slice(0, 300)
}
