/**
 * Связка отчётов с продуктом без ручной настройки: тот же канал доверия, что у входа через платформу.
 * Адрес — backend продукта server-side (OPS_SSO_API_URL, на проде — внутренняя сеть Docker), ключ
 * подписи — производный от общего секрета SSO и origin консоли (формула — shared/report-contract.ts).
 */
import { createHmac } from 'node:crypto'
import type { OpsEnv } from '../env'
import { OPS_REPORT_KEY_LABEL } from '../../shared/report-contract'

export const PRODUCT_REPORTS_PATH = '/api/v1/platform/ops-reports'
/** Короче — секрет слишком слабый, чтобы выводить из него ключ: связки нет (продукт отвечает так же). */
export const MIN_LINK_SECRET = 32

export function productLinkConfigured(env: OpsEnv): boolean {
  return Boolean(env.ssoApiUrl) && env.ssoClientSecret.length >= MIN_LINK_SECRET
}

export function productReportKey(secret: string, consoleOrigin: string): string {
  return createHmac('sha256', secret.trim()).update(`${OPS_REPORT_KEY_LABEL}\n${consoleOrigin}`).digest('hex')
}

/** Адрес, ключ и единственный внутренний хост, на который можно идти: backend продукта. */
export function productReceiver(env: OpsEnv): { url: string; key: string; allowPrivateHosts: string[] } {
  return {
    url: `${env.ssoApiUrl}${PRODUCT_REPORTS_PATH}`,
    key: productReportKey(env.ssoClientSecret, new URL(env.publicUrl).origin),
    // Только хост продукта — как у SSO (auth/sso.ts): общий список владельца сюда не нужен и не расширяется.
    allowPrivateHosts: [new URL(env.ssoApiUrl).hostname],
  }
}
