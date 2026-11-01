/** Сведение состояния объекта к статусу интерфейса (как в прототипе Ops Atlas). */
export type UiStatus = 'healthy' | 'warning' | 'critical' | 'unknown' | 'pending' | 'maintenance'

export interface FiringAlertLite {
  severity: 'warning' | 'critical'
  route: string
}

export function worstAlert(alerts: FiringAlertLite[], routePrefix: string): UiStatus | null {
  const mine = alerts.filter(
    (a) => a.route === routePrefix || a.route.startsWith(`${routePrefix}?`) || a.route.startsWith(`${routePrefix}/`),
  )
  if (mine.some((a) => a.severity === 'critical')) return 'critical'
  if (mine.length) return 'warning'
  return null
}

export function agentUiStatus(
  agent: { id: string; lastSeenAt: Date | null; reportIntervalSec: number; enabled: boolean },
  firing: FiringAlertLite[],
  silentAfterIntervals: number,
  now = Date.now(),
  inMaintenance = false,
): UiStatus {
  if (!agent.enabled) return 'unknown'
  if (inMaintenance) return 'maintenance'
  if (!agent.lastSeenAt) return 'pending'
  if (now - agent.lastSeenAt.getTime() > agent.reportIntervalSec * silentAfterIntervals * 1000) return 'unknown'
  return worstAlert(firing, `/infrastructure/${encodeURIComponent(agent.id)}`) ?? 'healthy'
}
