import type { Command, Severity, UiStatus } from '../lib/types'
import { Icon, type IconName } from './Icon'
import s from './styles'

const STATUS: Record<UiStatus, [string, string, IconName]> = {
  healthy: ['В норме', s.healthy ?? '', 'check'],
  warning: ['Требует внимания', s.warning ?? '', 'triangle'],
  critical: ['Критично', s.critical ?? '', 'alert'],
  unknown: ['Нет данных', s.unknown ?? '', 'help'],
  pending: ['Ожидает подключения', s.pending ?? '', 'clock'],
  maintenance: ['Техработы', s.accent ?? '', 'wrench'],
}

export function StatusBadge({ status, label }: { status: UiStatus; label?: string }) {
  const [text, tone, icon] = STATUS[status]
  return (
    <span className={`${s.badge} ${tone}`}>
      <Icon name={icon} />
      {label ?? text}
    </span>
  )
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <StatusBadge status={severity === 'critical' ? 'critical' : 'warning'} label={severity === 'critical' ? 'Критично' : 'Внимание'} />
}

const CONTAINER_STATE: Record<string, [string, UiStatus]> = {
  running: ['Работает', 'healthy'],
  restarting: ['Перезапускается', 'warning'],
  exited: ['Остановлен', 'critical'],
  dead: ['Мёртв', 'critical'],
  paused: ['Пауза', 'unknown'],
  created: ['Создан', 'pending'],
}

export function ContainerStateBadge({ state, expectedExit }: { state: string; expectedExit?: boolean }) {
  if (state === 'exited' && expectedExit) return <StatusBadge status="unknown" label="Завершён (0)" />
  const [label, status] = CONTAINER_STATE[state] ?? [state, 'unknown']
  return <StatusBadge status={status} label={label} />
}

export function HealthBadge({ health }: { health: string }) {
  if (health === 'healthy') return <StatusBadge status="healthy" label="healthy" />
  if (health === 'unhealthy') return <StatusBadge status="critical" label="unhealthy" />
  if (health === 'starting') return <StatusBadge status="pending" label="starting" />
  return <span className={s.faint}>—</span>
}

const CMD: Record<Command['status'], [string, UiStatus]> = {
  pending: ['В очереди', 'pending'],
  claimed: ['Выполняется', 'warning'],
  succeeded: ['Выполнен', 'healthy'],
  failed: ['Ошибка', 'critical'],
  expired: ['Истёк', 'unknown'],
}

export function CommandBadge({ status }: { status: Command['status'] }) {
  const [label, st] = CMD[status]
  return <StatusBadge status={st} label={label} />
}
