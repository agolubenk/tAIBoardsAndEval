/**
 * WireGuard хоста (агент ≥ 1.6): что из блока vpn идёт в общий снимок (его видят все роли), что — только владельцу
 * (внешние адреса пиров и куда они ходили), и метрики для графиков.
 */
import { lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentVpn } from '../db/schema'
import type { AgentReport, AgentVpn } from '../../shared/agent-contract'

/** В снимок хоста: пиры без внешних адресов, без направлений. */
export function vpnSummary(vpn: AgentVpn) {
  const { destinations, peers, ...rest } = vpn
  return { ...rest, peers: peers.map(({ endpoint, ...p }) => p) }
}

/** Метрики графиков и правил: сумма скоростей пиров и сколько их на связи. Только по свежему снимку сборщика. */
export function vpnSamples(vpn: AgentVpn | undefined, put: (k: string, v: number | undefined) => void) {
  if (vpn?.state !== 'ok') return
  const sum = (k: 'rxBps' | 'txBps') =>
    vpn.peers.some((p) => p[k] !== undefined) ? vpn.peers.reduce((a, p) => a + (p[k] ?? 0), 0) : undefined
  put('vpn_rx_bps', sum('rxBps'))
  put('vpn_tx_bps', sum('txBps'))
  put('vpn_peers_online', vpn.peers.filter((p) => p.online).length)
}

/** Запись только с новым снимком сборщика (в нём есть destinations) — одна строка на агента, раз в ~5 минут. */
export async function syncVpn(agentId: string, report: AgentReport): Promise<void> {
  const dest = report.vpn?.destinations
  if (!report.vpn || !dest) return
  const endpoints = report.vpn.peers.filter((p) => p.endpoint).map((p) => ({ ip: p.ip, name: p.name, endpoint: p.endpoint }))
  const values = {
    endpointsJson: JSON.stringify(endpoints),
    destinationsJson: JSON.stringify({ h1: dest.h1, h24: dest.h24 }),
    capturedAt: new Date(dest.at * 1000),
    updatedAt: new Date(),
  }
  await getDb()
    .insert(agentVpn)
    .values({ agentId, ...values })
    .onConflictDoUpdate({ target: agentVpn.agentId, set: values })
}

/** Окно направлений — сутки; строку старше (сборщик остановлен, агент откатан, блок vpn перестал приходить) удаляет tick. */
export const VPN_KEEP_MS = 25 * 3600_000

export async function pruneVpn(now: number): Promise<void> {
  await getDb().delete(agentVpn).where(lt(agentVpn.capturedAt, new Date(now - VPN_KEEP_MS)))
}

/** Для журнала — только код ошибки: сообщение drizzle содержит параметры запроса, то есть внешние адреса и направления. */
export function errCode(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const own = (err as { code?: unknown }).code
  const cause = (err as { cause?: { code?: unknown } }).cause?.code
  const code = typeof own === 'string' ? own : cause
  return typeof code === 'string' ? code.slice(0, 64) : err.name
}

/** Снимок агента для списков (обзор, инфраструктура): без блока vpn — его показывает только страница сервера. */
export function listSnapshot(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  const snap = JSON.parse(json) as Record<string, unknown>
  delete snap.vpn
  return snap
}
