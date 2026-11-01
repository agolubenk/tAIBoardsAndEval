/** Фильтры активных алертов: важность и ответственный (как в прототипе). */
import type { Alert } from '../../lib/types'
import { Select } from '../../ui/Controls'
import s from '../pages.module.css'

export interface AlertFilterValue {
  severity: '' | 'critical' | 'warning'
  /** '' — все; 'me' — мои; 'none' — не назначено; иначе email. */
  owner: string
}

export function filterAlerts(alerts: Alert[], f: AlertFilterValue, me: string | null): Alert[] {
  return alerts.filter((a) => {
    if (f.severity && a.severity !== f.severity) return false
    if (f.owner === 'none') return !a.acknowledgedBy
    if (f.owner === 'me') return Boolean(me) && a.acknowledgedBy === me
    if (f.owner) return a.acknowledgedBy === f.owner
    return true
  })
}

export function AlertFilters({ value, onChange, alerts }: { value: AlertFilterValue; onChange: (v: AlertFilterValue) => void; alerts: Alert[] }) {
  const owners = [...new Set(alerts.map((a) => a.acknowledgedBy).filter((x): x is string => Boolean(x)))].sort()
  return (
    <div className={s.filterBar} style={{ padding: '12px 16px 0' }}>
      <Select aria-label="Важность" value={value.severity} onChange={(e) => onChange({ ...value, severity: e.target.value as AlertFilterValue['severity'] })}>
        <option value="">Все уровни</option>
        <option value="critical">Критично</option>
        <option value="warning">Внимание</option>
      </Select>
      <Select aria-label="Ответственный" value={value.owner} onChange={(e) => onChange({ ...value, owner: e.target.value })}>
        <option value="">Все ответственные</option>
        <option value="me">Мои</option>
        <option value="none">Не назначено</option>
        {owners.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </div>
  )
}
