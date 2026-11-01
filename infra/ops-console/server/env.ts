/**
 * Конфигурация Ops-консоли — единственное место, где читается process.env.
 *
 * Локально (npm run dev / npm start) база — файл SQLite (libSQL), на Vercel — Turso
 * (libsql://…, тот же клиент и те же миграции). Секреты каналов и агентов шифруются
 * ключом OPS_ENCRYPTION_KEY; без него консоль не стартует — расшифровать уже сохранённое
 * без ключа нельзя, а молча сгенерированный ключ потерялся бы при рестарте.
 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

/** Лимиты вложений очереди — настройки, а не константы: ответ владельца на d-files-scope (21.10) меняет их без релиза. */
export interface OqFilesConfig {
  /** Каталог файлов; null — загрузки выключены (нет постоянного диска, например Vercel). */
  dir: string | null
  maxBytes: number
  maxPerItem: number
  retentionDays: number
  totalCapBytes: number
  /** Свободно на томе должно оставаться больше одного файла плюс этот запас (база и логи консоли там же). */
  freeReserveBytes: number
  kinds: string[]
}

export interface OpsEnv {
  isProduction: boolean
  databaseUrl: string
  databaseAuthToken: string | undefined
  /** 32 байта для AES-256-GCM (из base64/hex/любой строки — нормализуется sha256). */
  encryptionKey: Buffer
  /** Bearer для /api/cron/tick (Vercel Cron шлёт `Authorization: Bearer $CRON_SECRET`). */
  cronSecret: string | undefined
  /** Владелец, создаваемый при первом запуске, если пользователей ещё нет. */
  bootstrapEmail: string | undefined
  bootstrapPassword: string | undefined
  /** Публичный адрес консоли — для ссылок в уведомлениях. */
  publicUrl: string
  /**
   * Адрес задан явно (OPS_PUBLIC_URL / Render), а не выведен из VERCEL_URL — адреса конкретного
   * деплоя. Только тогда консоль ставит Telegram-вебхук: иначе он смотрел бы на старый деплой.
   */
  publicUrlExplicit: boolean
  port: number
  /** Интерфейс: локально 127.0.0.1 (консоль не видна в сети), на хостинге (Render) — 0.0.0.0. */
  host: string
  /**
   * Перед консолью стоит доверенный прокси (nginx на проде, Render, Vercel): IP клиента берётся из
   * X-Real-IP / последнего X-Forwarded-For, которые ставит прокси. Без прокси заголовкам не верим
   * (их подделает кто угодно) — берём адрес сокета.
   */
  trustProxy: boolean
  /** Хосты, по которым консоль отвечает (OPS_ALLOWED_HOSTS); пусто — любые. Loopback разрешён всегда. */
  allowedHosts: string[]
  /**
   * Кому из владельцев видны направления VPN и внешние адреса пиров (OPS_VPN_VIEWERS, e-mail через запятую). Пусто —
   * всем владельцам; владелец по SSO — любой суперадмин продукта, а при полном туннеле это история посещений.
   */
  vpnViewers: string[]
  /** Локальный режим: фоновый планировщик внутри процесса (на Vercel — внешний cron). */
  inProcessScheduler: boolean
  schedulerIntervalSec: number
  /** SSO через продукт: адрес SPA продукта (страница-посредник входа). Пусто — SSO выключен. */
  ssoProductUrl: string
  /**
   * Куда консоль ходит server-side (обмен кода, перепроверка доступа): база API продукта без
   * `/api/v1`. По умолчанию — ssoProductUrl; на проде — внутренний адрес backend в Docker-сети.
   */
  ssoApiUrl: string
  /** Общий секрет с backend (OPS_SSO_CLIENT_SECRET). Пусто — SSO выключен. */
  ssoClientSecret: string
  /** Файлы к входящим очереди (owner-queue): каталог и лимиты — переменные OQ_FILES_*, см. server/queue/files. */
  oqFiles: OqFilesConfig
}

function readKey(raw: string | undefined, isProduction: boolean): Buffer {
  if (!raw || raw.length < 16) {
    if (isProduction) {
      throw new Error('OPS_ENCRYPTION_KEY не задан (или короче 16 символов) — секреты нечем шифровать')
    }
    // Dev без ключа: детерминированный ключ, чтобы данные переживали рестарт. Не для prod.
    return createHash('sha256').update('hrh-ops-console-dev-only-key').digest()
  }
  return createHash('sha256').update(raw).digest()
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

const MB = 1024 * 1024

/** Каталог файлов: OQ_FILES_DIR, иначе рядом с файловой базой (тот же том), иначе выключено. */
function oqFilesDir(explicit: string | undefined, databaseUrl: string): string | null {
  // Абсолютный путь: иначе каталог зависел бы от рабочей папки процесса (консоль, миграция, CLI видели бы разные).
  if (explicit?.trim()) return resolve(explicit.trim())
  if (!databaseUrl.startsWith('file:')) return null
  return resolve(dirname(databaseUrl.slice('file:'.length)), 'oq-files')
}

let cached: OpsEnv | null = null

export function getEnv(): OpsEnv {
  if (cached) return cached
  const e = process.env
  const isProduction = e.NODE_ENV === 'production' || Boolean(e.VERCEL)
  cached = {
    isProduction,
    databaseUrl: e.OPS_DATABASE_URL || e.TURSO_DATABASE_URL || 'file:./data/ops.db',
    databaseAuthToken: e.OPS_DATABASE_AUTH_TOKEN || e.TURSO_AUTH_TOKEN || undefined,
    encryptionKey: readKey(e.OPS_ENCRYPTION_KEY, isProduction),
    cronSecret: e.OPS_CRON_SECRET || e.CRON_SECRET || undefined,
    bootstrapEmail: e.OPS_ADMIN_EMAIL?.trim().toLowerCase() || undefined,
    bootstrapPassword: e.OPS_ADMIN_PASSWORD || undefined,
    publicUrl: (e.OPS_PUBLIC_URL || e.RENDER_EXTERNAL_URL || (e.VERCEL_URL ? `https://${e.VERCEL_URL}` : 'http://localhost:8797')).replace(
      /\/$/,
      '',
    ),
    publicUrlExplicit: Boolean(e.OPS_PUBLIC_URL || e.RENDER_EXTERNAL_URL),
    port: readInt(e.OPS_PORT || e.PORT, 8797, 1, 65535),
    host: e.OPS_HOST || (e.RENDER ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: e.OPS_TRUST_PROXY === '1' || e.OPS_TRUST_PROXY === 'true' || Boolean(e.VERCEL) || Boolean(e.RENDER),
    allowedHosts: (e.OPS_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    vpnViewers: (e.OPS_VPN_VIEWERS ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
    inProcessScheduler: !e.VERCEL && e.OPS_SCHEDULER !== 'off',
    schedulerIntervalSec: readInt(e.OPS_SCHEDULER_INTERVAL_SEC, 20, 5, 600),
    ssoProductUrl: (e.OPS_SSO_PRODUCT_URL ?? '').trim().replace(/\/+$/, ''),
    ssoApiUrl: (e.OPS_SSO_API_URL || e.OPS_SSO_PRODUCT_URL || '').trim().replace(/\/+$/, ''),
    ssoClientSecret: (e.OPS_SSO_CLIENT_SECRET ?? '').trim(),
    oqFiles: {
      dir: e.VERCEL ? null : oqFilesDir(e.OQ_FILES_DIR, e.OPS_DATABASE_URL || e.TURSO_DATABASE_URL || 'file:./data/ops.db'),
      maxBytes: readInt(e.OQ_FILES_MAX_MB, 20, 1, 20) * MB,
      maxPerItem: readInt(e.OQ_FILES_MAX_PER_ITEM, 10, 1, 20),
      retentionDays: readInt(e.OQ_FILES_RETENTION_DAYS, 90, 1, 3650),
      totalCapBytes: readInt(e.OQ_FILES_TOTAL_CAP_MB, 4096, 100, 1_000_000) * MB,
      freeReserveBytes: readInt(e.OQ_FILES_FREE_RESERVE_MB, 1024, 0, 1_000_000) * MB,
      kinds: (e.OQ_FILES_KINDS ?? 'image,pdf,doc,sheet,text').split(',').map((k) => k.trim()).filter(Boolean),
    },
  }
  return cached
}

/** Только для тестов: подменить конфигурацию. */
export function setEnvForTests(patch: Partial<OpsEnv>): void {
  cached = { ...getEnv(), ...patch }
}
