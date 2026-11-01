/**
 * Схема Ops-консоли (SQLite/libSQL: локальный файл или Turso — тот же DDL).
 *
 * Время — integer миллисекунд (timestamp_ms): одинаково читается в SQLite и Turso, без
 * часовых поясов в БД. Секреты (токены каналов, агентов, GitHub) — только в колонках *_enc
 * (AES-256-GCM, server/lib/crypto.ts); наружу отдаётся маска.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'

import { bool, now, ts } from './columns'

// ── Доступ ──────────────────────────────────────────────────────────────────

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull().unique(),
    name: text('name').notNull().default(''),
    /** owner — всё, включая пользователей и секреты; operator — перезапуски, алерты, правила; viewer — чтение. */
    role: text('role', { enum: ['owner', 'operator', 'viewer'] })
      .notNull()
      .default('viewer'),
    /** '' у SSO-учёток: verifyPassword с пустым хэшем всегда false — паролем не войти. */
    passwordHash: text('password_hash').notNull(),
    disabled: bool('disabled').notNull().default(false),
    createdAt: ts('created_at').notNull().default(now),
    lastLoginAt: ts('last_login_at'),
    /**
     * id PlatformAdmin для входа через платформу (SSO, продукт — IdP); у локальных учёток — null.
     * Роль такой учётки задаёт платформа: суперадмин → owner, выданный доступ → operator.
     */
    platformId: text('platform_id'),
    /** Когда право входа последний раз подтверждено платформой (перепроверка каждые 5 мин). */
    ssoCheckedAt: ts('sso_checked_at'),
  },
  (t) => [uniqueIndex('idx_users_platform_id').on(t.platformId)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** sha256 токена cookie — сам токен в БД не хранится. */
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().default(now),
    ip: text('ip').notNull().default(''),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
)

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_login_attempts_key').on(t.key, t.createdAt)],
)

// ── Агенты хостов ───────────────────────────────────────────────────────────

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  environment: text('environment').notNull().default('production'),
  secretEnc: text('secret_enc').notNull(),
  secretHint: text('secret_hint').notNull().default(''),
  enabled: bool('enabled').notNull().default(true),
  /** Интервал отчётов, который агент сообщает сам; от него считается «агент молчит». */
  reportIntervalSec: integer('report_interval_sec').notNull().default(15),
  /** Последний принятый X-Ops-Timestamp (мс) — отсекает повтор подписанного запроса. */
  lastRequestTs: integer('last_request_ts').notNull().default(0),
  lastSeenAt: ts('last_seen_at'),
  /** Метрики пишутся в историю не чаще раза в минуту (лимиты записей Turso). */
  lastSampleAt: ts('last_sample_at'),
  /** Последний полный снимок агента (JSON) — для страницы хоста без агрегаций. */
  lastSnapshotJson: text('last_snapshot_json'),
  createdAt: ts('created_at').notNull().default(now),
})

export const metricSamples = sqliteTable(
  'metric_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    metric: text('metric').notNull(),
    value: real('value').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_metric_agent_time').on(t.agentId, t.metric, t.createdAt)],
)

/** Текущее состояние контейнера (одна строка на контейнер агента; история — в metric_samples). */
export const containers = sqliteTable(
  'containers',
  {
    agentId: text('agent_id').notNull(),
    name: text('name').notNull(),
    image: text('image').notNull().default(''),
    state: text('state').notNull(),
    health: text('health').notNull().default('none'),
    statusText: text('status_text').notNull().default(''),
    restartCount: integer('restart_count').notNull().default(0),
    cpuPct: real('cpu_pct'),
    memMb: real('mem_mb'),
    memLimitMb: real('mem_limit_mb'),
    /** Убито ядром по нехватке памяти, всего у контейнера (журнал ядра, агент ≥ 1.4); null — агент не сообщает. */
    oomKills: integer('oom_kills'),
    /** Пик памяти с запуска контейнера, МБ (cgroup memory.peak). */
    memPeakMb: real('mem_peak_mb'),
    /** Пик swap с запуска контейнера, МБ (cgroup memory.swap.peak). */
    swapPeakMb: real('swap_peak_mb'),
    startedAt: ts('started_at'),
    composeService: text('compose_service').notNull().default(''),
    /** Compose-проект; '' — без compose или агент до 1.5 (тогда видел только основной проект). */
    composeProject: text('compose_project').notNull().default(''),
    /** Хост выполнит перезапуск (агент ≥ 1.5); null — старый агент, решение за хостом. */
    restartable: bool('restartable'),
    /** Стек продукта (OPS_COMPOSE_PROJECT): «упал» у соседних стеков — только если контейнер по restart policy должен работать. */
    mainStack: bool('main_stack').notNull().default(true),
    restartPolicy: text('restart_policy').notNull().default(''),
    exitCode: integer('exit_code'),
    /** Вывод последней проверки healthcheck (обрезан) — почему контейнер unhealthy. */
    healthLog: text('health_log').notNull().default(''),
    /** Хранит данные — перезапуск только с вводом имени (решение владельца 2026-10-06). */
    stateful: bool('stateful').notNull().default(false),
    updatedAt: ts('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.name] })],
)

/** Команды агенту: агент забирает их сам (входящих портов на сервере нет). */
export const commands = sqliteTable(
  'commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    type: text('type', { enum: ['restart'] }).notNull(),
    target: text('target').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'claimed', 'succeeded', 'failed', 'expired'] })
      .notNull()
      .default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: ts('requested_at').notNull().default(now),
    claimedAt: ts('claimed_at'),
    finishedAt: ts('finished_at'),
    output: text('output').notNull().default(''),
  },
  (t) => [index('idx_commands_agent_status').on(t.agentId, t.status), index('idx_commands_time').on(t.requestedAt)],
)

// ── Внешние проверки ────────────────────────────────────────────────────────

export const MONITOR_TYPES = ['http', 'tcp', 'dns'] as const
export const DNS_RECORDS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'] as const

export const monitors = sqliteTable('monitors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** http — URL; tcp — «хост:порт»; dns — имя хоста (запись dnsRecord). */
  type: text('type', { enum: MONITOR_TYPES }).notNull().default('http'),
  url: text('url').notNull(),
  dnsRecord: text('dns_record', { enum: DNS_RECORDS }).notNull().default('A'),
  /** dns — ожидаемое значение в ответе (подстрока); null — любой непустой ответ. */
  expectValue: text('expect_value'),
  /** Подпись для публичной страницы статуса: «Веб-приложение и API». */
  description: text('description').notNull().default(''),
  method: text('method', { enum: ['GET', 'HEAD'] })
    .notNull()
    .default('GET'),
  /** null — любой 2xx/3xx. */
  expectStatus: integer('expect_status'),
  /** Тело — JSON с `status: "ok"` (health-эндпоинты продукта). */
  expectHealthJson: bool('expect_health_json').notNull().default(false),
  keyword: text('keyword'),
  intervalSec: integer('interval_sec').notNull().default(60),
  timeoutMs: integer('timeout_ms').notNull().default(8000),
  tags: text('tags').notNull().default(''),
  enabled: bool('enabled').notNull().default(true),
  /** Показывать на публичной status-странице. */
  isPublic: bool('is_public').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  failStreak: integer('fail_streak').notNull().default(0),
  lastCheckedAt: ts('last_checked_at'),
  lastOk: bool('last_ok'),
  lastStatusCode: integer('last_status_code'),
  lastLatencyMs: integer('last_latency_ms'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull().default(now),
})

export const checkResults = sqliteTable(
  'check_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitorId: integer('monitor_id').notNull(),
    ok: bool('ok').notNull(),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    /** Фазы запроса, мс: DNS, TCP-соединение, TLS, до первого байта (null — фаза не было/не измерена). */
    dnsMs: integer('dns_ms'),
    connectMs: integer('connect_ms'),
    tlsMs: integer('tls_ms'),
    ttfbMs: integer('ttfb_ms'),
    error: text('error'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_check_monitor_time').on(t.monitorId, t.createdAt)],
)

/**
 * Агрегаты проверок: «h» — час, «d» — сутки (начало окна, мс UTC). Обзор и SLA читают их,
 * а не сырые check_results: на Turso оплачиваются прочитанные строки.
 */
export const checkRollups = sqliteTable(
  'check_rollups',
  {
    monitorId: integer('monitor_id').notNull(),
    grain: text('grain', { enum: ['h', 'd'] }).notNull(),
    bucketStart: integer('bucket_start').notNull(),
    total: integer('total').notNull().default(0),
    okCount: integer('ok_count').notNull().default(0),
    latencySum: integer('latency_sum').notNull().default(0),
    latencyCount: integer('latency_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.grain, t.bucketStart] })],
)

export const tlsChecks = sqliteTable('tls_checks', {
  domain: text('domain').primaryKey(),
  issuer: text('issuer').notNull().default(''),
  validTo: ts('valid_to'),
  daysLeft: integer('days_left'),
  error: text('error'),
  checkedAt: ts('checked_at').notNull().default(now),
})

// ── Алерты и инциденты ──────────────────────────────────────────────────────

export const ALERT_RULE_KINDS = [
  'host_metric',
  'container_down',
  'container_unhealthy',
  'container_restarts',
  'container_oom',
  'agent_silent',
  'monitor_down',
  'tls_expiry',
  'deploy_failed',
  /** Деплой идёт дольше порога (threshold — минуты). */
  'deploy_slow',
  /** Деплой сменил сервисам образ, а rollback-prev им не поставил: откат только пересборкой. */
  'deploy_rollback_prev',
] as const
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number]

export const alertRules = sqliteTable('alert_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ALERT_RULE_KINDS }).notNull(),
  /** null — все агенты. */
  agentId: text('agent_id'),
  /**
   * Для host_metric: cpu_pct, mem_pct, disk_pct, load1, nginx_5xx_rpm, biz_* …; для container_unhealthy — пакетные
   * сервисы «занят ≠ завис» через запятую (diarization,whisper; server/alerts/container-busy.ts).
   */
  metric: text('metric'),
  op: text('op', { enum: ['gt', 'lt'] })
    .notNull()
    .default('gt'),
  /** host_metric — порог; container_restarts — перезапусков за окно; tls_expiry — дней. */
  threshold: real('threshold').notNull().default(0),
  /** Подряд отчётов за порогом, прежде чем стрелять (против дребезга). */
  forSamples: integer('for_samples').notNull().default(1),
  severity: text('severity', { enum: ['warning', 'critical'] })
    .notNull()
    .default('warning'),
  /** Повтор уведомления о незакрытом алерте — не чаще, мин. */
  repeatMin: integer('repeat_min').notNull().default(240),
  enabled: bool('enabled').notNull().default(true),
  builtin: bool('builtin').notNull().default(false),
  createdAt: ts('created_at').notNull().default(now),
})

export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** rule + объект: один активный алерт на пару, повторные срабатывания его обновляют. */
    fingerprint: text('fingerprint').notNull(),
    ruleId: integer('rule_id'),
    severity: text('severity', { enum: ['warning', 'critical'] }).notNull(),
    title: text('title').notNull(),
    object: text('object').notNull(),
    detail: text('detail').notNull().default(''),
    value: text('value').notNull().default(''),
    /** Ссылка в консоли на объект (хост, монитор). */
    route: text('route').notNull().default(''),
    status: text('status', { enum: ['firing', 'resolved'] })
      .notNull()
      .default('firing'),
    breachStreak: integer('breach_streak').notNull().default(0),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: ts('acknowledged_at'),
    silencedUntil: ts('silenced_until'),
    incidentId: integer('incident_id'),
    startedAt: ts('started_at').notNull().default(now),
    lastSeenAt: ts('last_seen_at').notNull().default(now),
    resolvedAt: ts('resolved_at'),
    lastNotifiedAt: ts('last_notified_at'),
    /** Факты на момент последнего наблюдения: [[подпись, значение], …] — для уведомлений и UI. */
    factsJson: text('facts_json').notNull().default('[]'),
    /** Что сделать: подсказка по причине (код выхода, корреляция с внешними проверками…). */
    hint: text('hint').notNull().default(''),
    /** Внешние ссылки: [[подпись, url], …] (запуск в GitHub и т. п.). */
    linksJson: text('links_json').notNull().default('[]'),
    /** Кто закрыл вручную (email); null — закрылся сам по наблюдению. */
    resolvedBy: text('resolved_by'),
    /** Как восстановилось: «снова на связи, отчёт 15:08:12», «HTTP 200 за 180 мс»… */
    resolution: text('resolution').notNull().default(''),
  },
  (t) => [index('idx_alerts_fp_status').on(t.fingerprint, t.status), index('idx_alerts_status_time').on(t.status, t.startedAt)],
)

/** Пред-алертное состояние (счётчики «подряд за порогом»): переживает рестарт и serverless. */
export const ruleStreaks = sqliteTable('rule_streaks', {
  fingerprint: text('fingerprint').primaryKey(),
  streak: integer('streak').notNull().default(0),
  updatedAt: ts('updated_at').notNull().default(now),
})

export const incidents = sqliteTable(
  'incidents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    severity: text('severity', { enum: ['warning', 'critical'] }).notNull(),
    status: text('status', { enum: ['active', 'monitoring', 'resolved'] })
      .notNull()
      .default('active'),
    summary: text('summary').notNull().default(''),
    createdBy: text('created_by').notNull().default('system'),
    startedAt: ts('started_at').notNull().default(now),
    resolvedAt: ts('resolved_at'),
    /** Ответственный (email); null — не назначен. */
    assignee: text('assignee'),
    assignedAt: ts('assigned_at'),
    /** Итог закрытия: устранено / ложное срабатывание / принят риск (null — закрылся сам). */
    closeResult: text('close_result', { enum: ['fixed', 'false_positive', 'accepted_risk'] }),
    closeComment: text('close_comment').notNull().default(''),
  },
  (t) => [index('idx_incidents_status').on(t.status, t.startedAt)],
)

export const incidentEvents = sqliteTable(
  'incident_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    incidentId: integer('incident_id').notNull(),
    kind: text('kind', { enum: ['opened', 'alert', 'note', 'status', 'action', 'resolved'] }).notNull(),
    message: text('message').notNull(),
    author: text('author').notNull().default('system'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_incident_events').on(t.incidentId, t.createdAt)],
)

// ── Уведомления ─────────────────────────────────────────────────────────────

export const CHANNEL_KINDS = ['telegram', 'email', 'webhook'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export const channels = sqliteTable('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
  name: text('name').notNull(),
  /** Несекретная часть: chat id, адреса, URL, SMTP-хост — JSON. */
  configJson: text('config_json').notNull().default('{}'),
  /** Секретная часть (токен бота, SMTP-пароль, ключ подписи webhook) — JSON, зашифрован. */
  secretEnc: text('secret_enc'),
  minSeverity: text('min_severity', { enum: ['warning', 'critical'] })
    .notNull()
    .default('warning'),
  /** Отправлять ли сюда ежедневный дайджест. */
  digest: bool('digest').notNull().default(false),
  enabled: bool('enabled').notNull().default(true),
  lastOkAt: ts('last_ok_at'),
  lastError: text('last_error'),
  lastErrorAt: ts('last_error_at'),
  createdAt: ts('created_at').notNull().default(now),
})

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id'),
    target: text('target').notNull(),
    kind: text('kind', { enum: ['alert', 'resolved', 'test', 'digest', 'report'] }).notNull(),
    alertId: integer('alert_id'),
    ok: bool('ok').notNull(),
    error: text('error'),
    /** Id сообщения в канале (Telegram message_id): первое по алерту — корень ветки и карточка для правки. */
    externalId: text('external_id'),
    /** Личная Telegram-подписка (tg_subscriptions.id); у доставок в каналы — null. */
    subscriptionId: integer('subscription_id'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [
    index('idx_deliveries_time').on(t.createdAt),
    index('idx_deliveries_alert').on(t.alertId, t.channelId),
    index('idx_deliveries_alert_sub').on(t.alertId, t.subscriptionId),
  ],
)

// ── Деплои, отчёты, лента, настройки ────────────────────────────────────────

export const deploys = sqliteTable(
  'deploys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runKey: text('run_key').notNull(),
    workflow: text('workflow').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    headSha: text('head_sha').notNull().default(''),
    title: text('title').notNull().default(''),
    actor: text('actor').notNull().default(''),
    url: text('url').notNull().default(''),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('idx_deploys_run').on(t.runKey)],
)

/** Отчёты для ИИ-совета директоров продукта (контракт — shared/report-contract.ts). */
export const reports = sqliteTable(
  'reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    period: text('period', { enum: ['daily', 'weekly'] }).notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    /** Ровно то тело, что подписывается и уходит: повторная доставка шлёт его байт в байт. */
    payloadJson: text('payload_json').notNull(),
    /** pending — собран, ещё не отправлялся (или процесс упал между сборкой и отправкой). */
    deliveryStatus: text('delivery_status', { enum: ['pending', 'not_configured', 'sent', 'failed'] }).notNull(),
    deliveryError: text('delivery_error'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: ts('last_attempt_at'),
    createdBy: text('created_by').notNull().default('system'),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_reports_time').on(t.createdAt)],
)

export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['alert', 'incident', 'action', 'config', 'deploy', 'agent', 'report', 'auth'] }).notNull(),
    message: text('message').notNull(),
    actor: text('actor').notNull().default('system'),
    route: text('route').notNull().default(''),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [index('idx_activity_time').on(t.createdAt)],
)

/** Ключ → JSON: интеграции, расписание отчётов, аренды планировщика, служебные отметки. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().default(now),
})

export * from './schema-telegram'
export * from './schema-operations'
export * from './schema-deploys'
export * from './schema-queue'
export * from './schema-domains'
export * from './schema-vpn'
