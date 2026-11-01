/** Отдача строк БД наружу: даты → мс, секреты не покидают сервер. */
import type { alerts, channels, monitors } from '../db/schema'
import { decryptJson, maskSecret } from '../lib/crypto'
import { channelSecretFields } from '../notify/channel-config'
import type { ChannelKind } from '../db/schema'

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

export function serializeAlert(a: typeof alerts.$inferSelect) {
  return {
    ...a,
    startedAt: a.startedAt.getTime(),
    lastSeenAt: a.lastSeenAt.getTime(),
    resolvedAt: ms(a.resolvedAt),
    acknowledgedAt: ms(a.acknowledgedAt),
    silencedUntil: ms(a.silencedUntil),
    lastNotifiedAt: ms(a.lastNotifiedAt),
    facts: pairs(a.factsJson),
    links: pairs(a.linksJson),
  }
}

function pairs(json: string): Array<[string, string]> {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v)
      ? v.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string')
      : []
  } catch {
    return []
  }
}

export function serializeMonitor(m: typeof monitors.$inferSelect) {
  return { ...m, lastCheckedAt: ms(m.lastCheckedAt), createdAt: m.createdAt.getTime() }
}

export function serializeChannel(ch: typeof channels.$inferSelect) {
  let secrets: Record<string, string> = {}
  try {
    secrets = decryptJson(ch.secretEnc)
  } catch {
    secrets = {}
  }
  const secretMasks = Object.fromEntries(channelSecretFields[ch.kind as ChannelKind].map((f) => [f, maskSecret(secrets[f])]))
  const { secretEnc: _secret, ...rest } = ch
  return {
    ...rest,
    config: JSON.parse(ch.configJson) as Record<string, unknown>,
    secretMasks,
    lastOkAt: ms(ch.lastOkAt),
    lastErrorAt: ms(ch.lastErrorAt),
    createdAt: ch.createdAt.getTime(),
  }
}
