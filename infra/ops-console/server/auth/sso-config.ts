/** Включён ли SSO через продукт — без зависимостей, чтобы его могли спрашивать и подписки Telegram. */
import type { OpsEnv } from '../env'

export const ssoEnabled = (env: OpsEnv): boolean => Boolean(env.ssoProductUrl && env.ssoApiUrl && env.ssoClientSecret)
