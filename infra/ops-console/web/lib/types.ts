/** Ответы API консоли (зеркало server/routes/*). Даты — мс UTC. */
export type Role = 'owner' | 'operator' | 'viewer'
export type Severity = 'warning' | 'critical'
export type UiStatus = 'healthy' | 'warning' | 'critical' | 'unknown' | 'pending' | 'maintenance'

export interface SessionUser {
  id: number
  email: string
  name: string
  role: Role
  /** Вход через платформу (SSO): роль задаёт платформа, пароля нет. */
  sso: boolean
}

export interface Alert {
  id: number
  fingerprint: string
  ruleId: number | null
  severity: Severity
  title: string
  object: string
  detail: string
  value: string
  route: string
  status: 'firing' | 'resolved'
  acknowledgedBy: string | null
  acknowledgedAt: number | null
  silencedUntil: number | null
  incidentId: number | null
  startedAt: number
  lastSeenAt: number
  resolvedAt: number | null
  lastNotifiedAt: number | null
  facts: Array<[string, string]>
  hint: string
  links: Array<[string, string]>
  resolvedBy: string | null
  resolution: string
  /** Сколько заметок дежурных (только в списке). */
  notes?: number
}

export interface Incident {
  id: number
  title: string
  severity: Severity
  status: 'active' | 'monitoring' | 'resolved'
  summary: string
  createdBy: string
  startedAt: number
  resolvedAt: number | null
  assignee: string | null
  assignedAt: number | null
  closeResult: 'fixed' | 'false_positive' | 'accepted_risk' | null
  closeComment: string
  /** Только в списке: сколько алертов сгруппировано. */
  affected?: number
}

export interface IncidentFact {
  kind: 'deploy' | 'restart' | 'delivery'
  text: string
  offsetMin: number
  tone: 'neutral' | 'bad'
  url?: string
}

export interface IncidentEvent {
  id: number
  incidentId: number
  kind: 'opened' | 'alert' | 'note' | 'status' | 'action' | 'resolved'
  message: string
  author: string
  createdAt: number
}

export interface UptimeDay {
  day: number
  pct: number | null
}

export interface Monitor {
  id: number
  name: string
  url: string
  maintenance?: MaintenanceWindow | null
  method: 'GET' | 'HEAD'
  expectStatus: number | null
  expectHealthJson: boolean
  keyword: string | null
  intervalSec: number
  timeoutMs: number
  tags: string
  enabled: boolean
  isPublic: boolean
  sortOrder: number
  failStreak: number
  lastCheckedAt: number | null
  lastOk: boolean | null
  lastStatusCode: number | null
  lastLatencyMs: number | null
  lastError: string | null
  uptime30d: UptimeDay[]
  uptime24h: number | null
  avgLatency24h: number | null
  type: 'http' | 'tcp' | 'dns'
  dnsRecord: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT'
  expectValue: string | null
  description: string
  latency24h?: LatencyStats | null
}

export interface LatencyStats {
  p50: number | null
  p95: number | null
  p99: number | null
  samples: number
}

export interface CheckRow {
  id: number
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  dnsMs: number | null
  connectMs: number | null
  tlsMs: number | null
  ttfbMs: number | null
  error: string | null
  createdAt: number
}

export interface MonitorDetailStats {
  latency: LatencyStats
  errors: Array<{ error: string; count: number; lastAt: number }>
  failures: Array<{ t: number; error: string }>
  phases: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null }
}

export interface AgentSnapshot {
  hostname?: string
  os?: string
  osName?: string
  agentVersion?: string
  uptimeSec?: number
  cpu?: { pct?: number; load1?: number; load5?: number; load15?: number; cores?: number }
  memory?: { totalMb?: number; usedMb?: number; swapTotalMb?: number; swapUsedMb?: number }
  disks?: Array<{ mount: string; totalGb: number; usedGb: number; inodePct?: number }>
  network?: { rxBytesPerSec?: number; txBytesPerSec?: number; errors?: number }
  nginx?: { requestsPerMin: number; errors4xxPerMin: number; errors5xxPerMin: number; topPaths: Array<[string, number]> }
  business?: Record<string, number>
  dockerError?: string
  /** Основной compose-проект хоста (агент ≥ 1.5). */
  mainProject?: string
  /** Контейнеры, которые видит агент: в снимке — только счётчики, сами строки — в /infra/agents. */
  containerCounts?: { running: number; total: number }
  /** Контейнеры nginx, не отдавшие конфигурацию (`nginx -T` упал) — их домены могли не попасть в список (агент ≥ 1.5). */
  domainsFailed?: string[]
  /** Сколько имён нашёл агент, когда прислал не все (лимит отчёта — 100, стек продукта — первым). */
  domainsTotal?: number
  /** WireGuard (агент ≥ 1.6 со сборщиком hrh-ops-vpn): пиры без внешних адресов — их и направления видит только владелец. */
  vpn?: VpnSummary
  receivedAt?: number
}

export interface VpnPeer {
  name: string
  iface: string
  ip: string
  online: boolean
  handshakeAgeSec: number | null
  /** Байт от клиента и к клиенту с запуска интерфейса. */
  rx: number
  tx: number
  rxBps?: number
  txBps?: number
  rttMs?: number
  lossPct?: number
  pingAgeSec?: number
}

export interface VpnSummary {
  state: string
  error?: string
  at?: number
  interval?: number
  peers: VpnPeer[]
  flowsSource?: string
  flowsAcct?: boolean
  flowsTruncated?: boolean
}

export interface VpnDestination {
  peer: string
  proto: string
  dst: string
  port: number
  /** Байт от клиента к адресу и обратно за окно. */
  up: number
  down: number
  conns: number
  host?: string
}

export interface VpnWindow {
  rows: VpnDestination[]
  keys: number
  total: [number, number, number]
}

/** GET /infra/agents/:id/vpn — только владелец. */
export interface VpnOwnerData {
  endpoints: Array<{ ip: string; name: string; endpoint: string }>
  destinations: { h1?: VpnWindow; h24?: VpnWindow }
  /** Время снимка сборщика, по которому посчитаны окна. */
  capturedAt: number | null
  updatedAt: number
}

export interface AgentSummary {
  id: string
  name: string
  environment: string
  enabled: boolean
  status: UiStatus
  maintenance?: MaintenanceWindow | null
  lastSeenAt: number | null
  reportIntervalSec: number
  snapshot: AgentSnapshot | null
}

export interface Container {
  agentId: string
  name: string
  image: string
  state: string
  health: string
  statusText: string
  restartCount: number
  cpuPct: number | null
  memMb: number | null
  memLimitMb: number | null
  /** Пик памяти с запуска, МБ (агент ≥ 1.4). */
  memPeakMb?: number | null
  /** Пик swap с запуска, МБ (агент ≥ 1.4). */
  swapPeakMb?: number | null
  /** Убито ядром по нехватке памяти, всего у контейнера (журнал ядра, агент ≥ 1.4). */
  oomKills?: number | null
  startedAt: number | null
  composeService: string
  /** Compose-проект; '' — без compose (агент ≥ 1.5 видит контейнеры всех проектов). */
  composeProject?: string
  /** false — хост не перезапустит (OPS_RESTART_PROJECTS/ALLOW/DENY); null — агент до 1.5, решает хост. */
  restartable?: boolean | null
  /** Стек продукта (OPS_COMPOSE_PROJECT): у соседних «остановлен» — проблема, только если по restart policy должен работать. */
  mainStack?: boolean
  restartPolicy: string
  exitCode: number | null
  stateful: boolean
  updatedAt: number
}

export interface Command {
  id: number
  agentId: string
  type: 'restart'
  target: string
  reason: string
  status: 'pending' | 'claimed' | 'succeeded' | 'failed' | 'expired'
  requestedBy: string
  requestedAt: number
  claimedAt: number | null
  finishedAt: number | null
  output: string
}

export interface ActivityItem {
  id: number
  kind: 'alert' | 'incident' | 'action' | 'config' | 'deploy' | 'agent' | 'report' | 'auth'
  message: string
  actor: string
  route: string
  createdAt: number
}

export interface Deploy {
  id: number
  runKey: string
  workflow: string
  status: string
  conclusion: string | null
  headSha: string
  title: string
  actor: string
  url: string
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
  incident?: { incidentId: number; afterMin: number } | null
  /** Пункты очереди владельца, связанные с деплоем; поле есть только у роли owner. */
  queue?: DeployQueueLinks | null
}

export interface DeployQueueLinks {
  links: { id: string; kind: string; title: string; done: boolean }[]
  more: number
}

export interface Overview {
  consoleName: string
  alerts: Alert[]
  incidents: Incident[]
  monitors: Monitor[]
  agents: Array<AgentSummary & { containers: { total: number; running: number; unhealthy: number } }>
  activity: ActivityItem[]
  deploys: Deploy[]
  commands: Command[]
  kpis: OverviewKpis
  maintenance: MaintenanceWindow[]
  serverTime: number
}

export interface OverviewKpis {
  containers: { total: number; running: number; restarting: number; unhealthy: number; stopped: number }
  tls: { total: number; atRisk: number; nearest: { domain: string; daysLeft: number | null; error: string | null } | null }
  notifications: {
    channels: number
    failing: Array<{ name: string; error: string; at: number | null }>
    lastOkAt: number | null
    subscriptions: number
    subscriptionsFailing: number
  }
}

export type ResourceWindow = '6h' | '24h' | '7d'

export interface WatchedResource {
  agentId: string
  host: string
  metric: 'cpu_pct' | 'mem_pct' | 'disk_pct'
  value: number
  delta: number | null
  threshold: number | null
  fullInHours: number | null
  detail: string
  level: 'critical' | 'warning' | 'watch'
  points: Array<[number, number]>
}

export interface AlertRule {
  id: number
  name: string
  kind:
    | 'host_metric'
    | 'container_down'
    | 'container_unhealthy'
    | 'container_restarts'
    | 'container_oom'
    | 'agent_silent'
    | 'monitor_down'
    | 'tls_expiry'
    | 'deploy_failed'
    | 'deploy_slow'
    | 'deploy_rollback_prev'
  agentId: string | null
  metric: string | null
  op: 'gt' | 'lt'
  threshold: number
  forSamples: number
  severity: Severity
  repeatMin: number
  enabled: boolean
  builtin: boolean
}

export interface Channel {
  id: number
  kind: 'telegram' | 'email' | 'webhook'
  name: string
  config: Record<string, unknown>
  secretMasks: Record<string, string | null>
  minSeverity: Severity
  digest: boolean
  enabled: boolean
  lastOkAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  lastTestAt?: number | null
  lastTestOk?: boolean | null
  lastDeliveryAt?: number | null
  lastDeliveryOk?: boolean | null
}

export interface Delivery {
  id: number
  channelId: number | null
  target: string
  kind: 'alert' | 'resolved' | 'test' | 'digest' | 'report'
  alertId: number | null
  ok: boolean
  error: string | null
  createdAt: number
}

export interface TlsCert {
  domain: string
  issuer: string
  validTo: number | null
  daysLeft: number | null
  error: string | null
  checkedAt: number
}

/** Имя из конфигурации nginx на хосте и что агент увидел у его сертификата (/infra/domains, агент ≥ 1.5). */
export interface AgentDomain {
  agentId: string
  agentName: string
  domain: string
  /** Контейнер nginx, в конфигурации которого найдено имя. */
  source: string
  port: number | null
  tls: boolean
  issuer: string
  validTo: number | null
  daysLeft: number | null
  /** expired · name_mismatch · not_yet_valid · untrusted · verify_failed · connect · tls_handshake · unreachable */
  error: string | null
  checkedAt: number | null
  /** Конфигурацию не удалось перечитать — имя из прошлого удачного разбора. */
  stale: boolean
  updatedAt: number
}

export interface DeploySource {
  configured: boolean
  repo: string
  workflow: string
  lastSyncAt: number | null
  lastSyncOk: boolean
  lastSyncError: string
}

export interface MaintenanceWindow {
  id: number
  scope: 'all' | 'agent' | 'monitor'
  target: string
  reason: string
  startsAt: number
  endsAt: number
  createdBy: string
  endedAt: number | null
  endedBy: string | null
  /** Только в списке /maintenance. */
  targetName?: string
}
