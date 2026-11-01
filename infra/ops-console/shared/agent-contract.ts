/**
 * Контракт «агент хоста → консоль» (POST /api/agent/report). Агент — infra/ops-console/agent/
 * hrh-ops-agent.py; любое поле необязательно, кроме идентификации: старый агент с меньшим
 * набором метрик продолжает работать. Лимиты длин — против раздувания БД одним отчётом.
 */
import { z } from 'zod'

const str = (max: number) => z.string().max(max)
const num = z.number().finite()

export const agentContainerSchema = z.object({
  name: str(190),
  image: str(300).default(''),
  state: str(32),
  health: str(32).default('none'),
  status: str(255).default(''),
  restartCount: z.number().int().min(0).default(0),
  startedAt: str(64).optional(),
  cpuPct: num.optional(),
  memMb: num.optional(),
  memLimitMb: num.optional(),
  composeService: str(120).default(''),
  /** Compose-проект контейнера; '' — запущен без compose (агент ≥ 1.5 видит контейнеры всех проектов). */
  composeProject: str(120).default(''),
  /** Хост выполнит перезапуск (OPS_RESTART_PROJECTS/ALLOW/DENY, агент ≥ 1.5); нет поля — старый агент, как раньше. */
  restartable: z.boolean().optional(),
  restartPolicy: str(32).default(''),
  /** Вывод последней проверки healthcheck (обрезан агентом) — почему контейнер unhealthy. */
  healthLog: str(400).default(''),
  /** Ядро убило процесс по нехватке памяти (docker inspect .State.OOMKilled). */
  oomKilled: z.boolean().optional(),
  /**
   * Процессов этого контейнера, убитых ядром по нехватке памяти, всего — по журналу ядра (агент ≥ 1.4). Итог растёт
   * и переживает перезапуск контейнера и агента; у пересозданного контейнера (новый id) начинается заново.
   */
  oomKills: z.number().int().min(0).optional(),
  /** Пик памяти контейнера с запуска, МБ (cgroup memory.peak, агент ≥ 1.4). */
  memPeakMb: num.optional(),
  /** Пик swap контейнера с запуска, МБ (cgroup memory.swap.peak, агент ≥ 1.4): упирался в потолок и уходил в swap хоста. */
  swapPeakMb: num.optional(),
  /** Кого ядро убило по нехватке памяти за 3 суток, «pluginsmanager ×4, uvicorn ×1 (память хоста)» (журнал ядра, агент ≥ 1.4). */
  oomVictims: str(200).optional(),
  exitCode: z.number().int().optional(),
  /** Метка контейнера `ops.stateful=true` — хранит данные, перезапуск только с вводом имени. */
  stateful: z.boolean().optional(),
})

/**
 * Имя, которое отдаёт nginx в одном из контейнеров хоста (агент ≥ 1.5, `nginx -T` → server_name/listen), и что агент
 * увидел у его сертификата локальным рукопожатием с SNI. Сроки — Unix, с.
 */
export const agentDomainSchema = z.object({
  name: str(253),
  /** Контейнер nginx, в конфигурации которого имя найдено. */
  source: str(190).default(''),
  port: z.number().int().min(1).max(65535).optional(),
  /** Есть listen … ssl — у имени должен быть сертификат. */
  tls: z.boolean().default(false),
  validTo: num.optional(),
  issuer: str(120).default(''),
  /** Код отказа проверки: expired, name_mismatch, untrusted, not_yet_valid, verify_failed, tls_handshake, connect, unreachable. */
  error: str(32).optional(),
  checkedAt: num.optional(),
  /** Конфигурацию nginx не удалось перечитать — имя из прошлого удачного разбора. */
  stale: z.boolean().optional(),
})

export const commandResultSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(['succeeded', 'failed']),
  output: str(4000).default(''),
})

/**
 * Пир WireGuard (агент ≥ 1.6, корневой сборщик hrh-ops-vpnd.py). Счётчики — с точки зрения сервера: rx — пришло от
 * пира, tx — ушло к нему. Скорость, RTT и потери — только при свежем снимке сборщика; RTT — ping раз в 5 мин, и только
 * пока пир шлёт трафик.
 */
export const agentVpnPeerSchema = z.object({
  name: str(64),
  iface: str(32).default(''),
  ip: str(64),
  online: z.boolean().default(false),
  handshakeAgeSec: z.number().int().min(0).nullable().default(null),
  rx: num.min(0).default(0),
  tx: num.min(0).default(0),
  rxBps: num.min(0).optional(),
  txBps: num.min(0).optional(),
  rttMs: num.min(0).optional(),
  lossPct: num.min(0).max(100).optional(),
  pingAgeSec: z.number().int().min(0).optional(),
  /** Внешний адрес пира (IP:порт) — видит только владелец, в снимок хоста не попадает. */
  endpoint: str(80).optional(),
})

/** Куда ходил пир: прирост байт и новые соединения по (протокол, адрес, порт) за окно. host — PTR адреса. */
export const agentVpnDestinationSchema = z.object({
  peer: str(64),
  proto: str(16),
  dst: str(64),
  port: z.number().int().min(0).max(65535),
  up: num.min(0),
  down: num.min(0),
  conns: z.number().int().min(0),
  host: str(120).optional(),
})

const vpnWindowSchema = z.object({
  rows: z.array(agentVpnDestinationSchema).max(50),
  /** Сколько направлений в окне всего (без «прочего»). */
  keys: z.number().int().min(0).default(0),
  /** [от пиров, к пирам, соединений] — всё окно, включая не попавшее в rows. */
  total: z.tuple([num.min(0), num.min(0), num.min(0)]).default([0, 0, 0]),
})

/**
 * WireGuard хоста. state: ok · no_wg (wg не ответил) · stale (сборщик не обновлял файл 3 интервала) · error (файл не
 * читается). destinations — только с новым снимком сборщика (раз в ~30 с); нет поля — прошлые в силе.
 */
export const agentVpnSchema = z.object({
  state: str(16),
  error: str(32).optional(),
  at: num.optional(),
  interval: z.number().int().min(1).max(3600).optional(),
  peers: z.array(agentVpnPeerSchema).max(32).default([]),
  flowsSource: str(16).optional(),
  /** net.netfilter.nf_conntrack_acct: без него в направлениях только число соединений. */
  flowsAcct: z.boolean().optional(),
  flowsTruncated: z.boolean().optional(),
  destinations: z.object({ at: num, h1: vpnWindowSchema, h24: vpnWindowSchema }).optional(),
})

/** Не чаще раза в час: агент шлёт отчёт каждые 15 с, и кривой блок иначе забил бы журнал. */
let vpnWarnedAt = 0

export const agentReportSchema = z.object({
  agentVersion: str(32),
  hostname: str(190).default(''),
  os: str(190).default(''),
  /** Дистрибутив: «Ubuntu 24.04.1 LTS» (агент ≥ 1.2). */
  osName: str(120).optional(),
  intervalSec: z.number().int().min(5).max(600).default(15),
  capturedAt: str(64).optional(),
  uptimeSec: z.number().int().min(0).optional(),
  cpu: z
    .object({
      pct: num.optional(),
      load1: num.optional(),
      load5: num.optional(),
      load15: num.optional(),
      cores: z.number().int().optional(),
    })
    .optional(),
  memory: z.object({ totalMb: num.optional(), usedMb: num.optional(), swapTotalMb: num.optional(), swapUsedMb: num.optional() }).optional(),
  disks: z
    .array(z.object({ mount: str(190), totalGb: num, usedGb: num, inodePct: num.optional() }))
    .max(20)
    .default([]),
  /** errors — ошибки приёма и передачи за интервал отчёта (агент ≥ 1.2). */
  network: z.object({ rxBytesPerSec: num.optional(), txBytesPerSec: num.optional(), errors: num.optional() }).optional(),
  containers: z.array(agentContainerSchema).max(200).optional(),
  /** Основной compose-проект хоста (OPS_COMPOSE_PROJECT, агент ≥ 1.5): его контейнеры — стек продукта. */
  mainProject: str(120).optional(),
  dockerError: str(300).optional(),
  nginx: z
    .object({
      requestsPerMin: num,
      errors4xxPerMin: num,
      errors5xxPerMin: num,
      topPaths: z
        .array(z.tuple([str(120), num]))
        .max(10)
        .default([]),
    })
    .optional(),
  business: z.record(str(48), num).optional(),
  /** Время замера бизнес-метрик (Unix, с) и команды, которые в нём упали (агент ≥ 1.3). */
  businessAt: num.optional(),
  businessFailed: z.array(str(48)).max(20).optional(),
  /**
   * Домены хоста по конфигурации nginx (агент ≥ 1.5). Приходят не в каждом отчёте — при изменении и раз в час;
   * нет поля — список не менялся, а не «доменов нет». domainsTotal — сколько найдено до обрезки по 100.
   */
  domains: z.array(agentDomainSchema).max(100).optional(),
  domainsAt: num.optional(),
  domainsTotal: z.number().int().min(0).optional(),
  /**
   * Контейнеры nginx, не отдавшие конфигурацию (`nginx -T` упал): их имена в списке — с прошлого разбора или нет вовсе.
   * В отличие от domains — в каждом отчёте, пока отказ длится; нет поля — отказов нет.
   */
  domainsFailed: z.array(str(190)).max(20).optional(),
  commandResults: z.array(commandResultSchema).max(20).default([]),
  /** Кривой блок VPN не должен стоить хосту отчёта (контейнеры, алерты): он отбрасывается один. */
  vpn: agentVpnSchema.optional().catch(({ error }) => {
    if (Date.now() - vpnWarnedAt > 3_600_000) {
      vpnWarnedAt = Date.now()
      console.warn('[ops] vpn block dropped:', error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.code}`).join('; '))
    }
    return undefined
  }),
})

export type AgentReport = z.infer<typeof agentReportSchema>
export type AgentContainer = z.infer<typeof agentContainerSchema>
export type AgentDomain = z.infer<typeof agentDomainSchema>
export type AgentVpn = z.infer<typeof agentVpnSchema>

export interface AgentCommand {
  id: number
  type: 'restart'
  target: string
}

export interface AgentReportResponse {
  ok: true
  serverTime: number
  commands: AgentCommand[]
}

/** Заголовки подписи: HMAC-SHA256(secret, `${ts}.${METHOD}.${path}.${sha256(body)}`). */
export const AGENT_HEADERS = {
  agent: 'x-ops-agent',
  timestamp: 'x-ops-timestamp',
  signature: 'x-ops-signature',
} as const

export function agentSigningPayload(ts: string, method: string, path: string, bodySha256Hex: string): string {
  return `${ts}.${method.toUpperCase()}.${path}.${bodySha256Hex}`
}
