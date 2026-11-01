import { isContainerDown } from '../../shared/container-state'
import type { AgentSnapshot } from './types'

export function hostMetrics(snap: AgentSnapshot | null | undefined) {
  const memPct = snap?.memory?.totalMb && snap.memory.usedMb !== undefined ? (snap.memory.usedMb / snap.memory.totalMb) * 100 : null
  const disks = (snap?.disks ?? []).filter((d) => d.totalGb > 0)
  const worst = disks.reduce<(typeof disks)[number] | null>(
    (acc, d) => (!acc || d.usedGb / d.totalGb > acc.usedGb / acc.totalGb ? d : acc),
    null,
  )
  return {
    cpu: snap?.cpu?.pct ?? null,
    memPct,
    disk: worst ? { mount: worst.mount, pct: (worst.usedGb / worst.totalGb) * 100, freeGb: worst.totalGb - worst.usedGb } : null,
  }
}

/**
 * Остановлен штатно — алерта нет: одноразовая задача завершилась кодом 0, а у соседних стеков ещё и любой контейнер,
 * которому restart policy не велит работать. Правило одно с алертами сервера (shared/container-state.ts).
 */
export function isExpectedExit(c: { state: string; restartPolicy: string; exitCode: number | null; mainStack?: boolean }): boolean {
  return c.state === 'exited' && !isContainerDown(c)
}

/** Подпись проекта контейнера: '' — запущен без compose. */
export function projectLabel(c: { composeProject?: string }): string {
  return c.composeProject || 'без compose'
}

export interface ProjectGroup<T> {
  project: string
  main: boolean
  containers: T[]
}

/** Контейнеры по compose-проектам: стек продукта первым, дальше по имени проекта, «без compose» — последним. */
export function groupByProject<T extends { composeProject?: string; mainStack?: boolean }>(containers: T[]): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>()
  for (const c of containers) {
    const project = c.composeProject ?? ''
    let g = groups.get(project)
    if (!g) groups.set(project, (g = { project, main: false, containers: [] }))
    g.main ||= c.mainStack === true
    g.containers.push(c)
  }
  const rank = (g: ProjectGroup<T>) => (g.main ? 0 : g.project ? 1 : 2)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.project.localeCompare(b.project))
}
