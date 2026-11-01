export interface GeneralSettings {
  consoleName: string
  checkRetentionDays: number
  metricRetentionDays: number
  activityRetentionDays: number
  deliveryRetentionDays: number
  rollupRetentionDays: number
  publicStatusEnabled: boolean
  publicStatusTitle: string
  agentSilentAfterIntervals: number
  restartCooldownSec: number
  privateEgressHosts: string
  timezone: string
  heartbeatUrl: string
}

export interface SettingsResponse {
  general: GeneralSettings
  github: { repo: string; workflow: string; tokenMask: string | null }
  reports: {
    enabled: boolean
    period: 'daily' | 'weekly'
    hourUtc: number
    destinationUrl: string
    secretMask: string | null
    lastPeriodKey: string
    /** Куда уйдёт следующий отчёт: свой приёмник, продукт по связке входа через платформу, никуда — или свой сломан. */
    receiver: 'manual' | 'product' | 'none' | 'broken'
    receiverError: string | null
  }
  runtime: { publicUrl: string; scheduler: string; cronConfigured: boolean; database: string; lastTickAt: number | null }
}

export interface AdminAgent {
  id: string
  name: string
  environment: string
  enabled: boolean
  secretHint: string
  lastSeenAt: number | null
  createdAt: number
}

export interface AdminUser {
  id: number
  email: string
  name: string
  role: 'owner' | 'operator' | 'viewer'
  disabled: boolean
  /** Входит через платформу (SSO): роль задаёт платформа. */
  sso: boolean
  lastLoginAt: number | null
  createdAt: number
}
