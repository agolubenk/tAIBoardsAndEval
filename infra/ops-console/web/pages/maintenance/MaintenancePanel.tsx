/** Настройки → «Техработы»: активные и недавние окна, включить для всей консоли, завершить досрочно. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { fullDateTime, timeAgo } from '../../lib/format'
import type { MaintenanceWindow } from '../../lib/types'
import { StatusBadge } from '../../ui/Badge'
import { Button } from '../../ui/Controls'
import { Empty, LoadError, Panel, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'
import { MaintenanceDialog } from './MaintenanceDialog'

const SCOPE: Record<MaintenanceWindow['scope'], string> = { all: 'Консоль', agent: 'Хост', monitor: 'Проверка' }

export function MaintenancePanel() {
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  const q = useQuery({ queryKey: ['maintenance'], queryFn: () => api.get<{ windows: MaintenanceWindow[] }>('/maintenance'), refetchInterval: 30_000 })
  const end = useAction((id: number) => api.post(`/maintenance/${id}/end`), {
    success: 'Техработы завершены — алерты снова поднимаются',
    invalidate: [['maintenance'], ['overview'], ['agents'], ['host'], ['monitors'], ['monitor']],
  })
  const now = Date.now()
  return (
    <Panel
      title="Техработы"
      hint="На время окна алерты по объекту не поднимаются и не рассылаются. Включить для хоста или проверки — на их странице."
      action={
        can('operator') ? (
          <Button icon="wrench" onClick={() => setOpen(true)}>
            Техработы для всей консоли
          </Button>
        ) : null
      }
    >
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton height={100} />
      ) : q.data.windows.length === 0 ? (
        <Empty title="Окон техработ не было" icon="wrench">
          За последние 30 дней работ не объявляли.
        </Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Объект</th>
                <th>Причина</th>
                <th>Окно</th>
                <th>Кто</th>
                <th>Состояние</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.windows.map((w) => {
                const active = !w.endedAt && w.endsAt > now && w.startsAt <= now
                return (
                  <tr key={w.id}>
                    <td>
                      <span className={ui.cellMain}>{w.targetName ?? w.target}</span>
                      <span className={ui.cellSub}>{SCOPE[w.scope]}</span>
                    </td>
                    <td>{w.reason}</td>
                    <td className={ui.num}>
                      {fullDateTime(w.startsAt)}
                      <span className={ui.cellSub}>до {fullDateTime(w.endedAt ?? w.endsAt)}</span>
                    </td>
                    <td>
                      {w.createdBy}
                      {w.endedBy ? <span className={ui.cellSub}>завершил(а) {w.endedBy}</span> : null}
                    </td>
                    <td>
                      {active ? (
                        <StatusBadge status="maintenance" label={`Идут · ещё ${timeAgo(w.endsAt).replace(/^через /, '')}`} />
                      ) : (
                        <StatusBadge status="unknown" label={w.endedAt ? 'Завершены досрочно' : 'Завершены'} />
                      )}
                    </td>
                    <td>
                      {active && can('operator') ? (
                        <Button small busy={end.isPending && end.variables === w.id} onClick={() => end.mutate(w.id)}>
                          Завершить
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <MaintenanceDialog scope="all" name="вся консоль" open={open} onClose={() => setOpen(false)} />
    </Panel>
  )
}
