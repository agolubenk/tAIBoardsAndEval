/** «Заглушки»: алерты под тишиной и окна техработ — всё, что сейчас подавляет уведомления. */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { fullDateTime, timeAgo } from '../../lib/format'
import type { Alert, MaintenanceWindow } from '../../lib/types'
import { SeverityBadge } from '../../ui/Badge'
import { Button } from '../../ui/Controls'
import { Empty, Panel, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'

export function SilencesPanel({ alerts }: { alerts: Alert[] | undefined }) {
  const { can } = useSession()
  const maint = useQuery({ queryKey: ['maintenance'], queryFn: () => api.get<{ windows: MaintenanceWindow[] }>('/maintenance') })
  const unsilence = useAction((id: number) => api.post(`/alerts/${id}/silence`, { minutes: 0 }), {
    success: 'Тишина снята — повторы снова идут',
    invalidate: [['alerts']],
  })
  const now = Date.now()
  const silenced = (alerts ?? []).filter((a) => a.silencedUntil && a.silencedUntil > now)
  const windows = (maint.data?.windows ?? []).filter((w) => !w.endedAt && w.endsAt > now && w.startsAt <= now)
  return (
    <>
      <Panel title="Тишина по алертам" hint="Алерт горит в консоли, но повторные уведомления не уходят" flush>
        {!alerts ? (
          <Skeleton height={80} />
        ) : silenced.length === 0 ? (
          <Empty title="Тишины нет" icon="mute" />
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Важность</th>
                  <th>Алерт</th>
                  <th>До</th>
                  {can('operator') ? <th aria-label="Действия" /> : null}
                </tr>
              </thead>
              <tbody>
                {silenced.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <SeverityBadge severity={a.severity} />
                    </td>
                    <td>
                      <Link className={ui.rowLink} to={`/alerts?focus=${a.id}`}>
                        {a.title}
                      </Link>
                      <span className={ui.cellSub}>{a.object}</span>
                    </td>
                    <td className={ui.num}>
                      {fullDateTime(a.silencedUntil)}
                      <span className={ui.cellSub}>{timeAgo(a.silencedUntil)}</span>
                    </td>
                    {can('operator') ? (
                      <td>
                        <Button small busy={unsilence.isPending && unsilence.variables === a.id} onClick={() => unsilence.mutate(a.id)}>
                          Снять
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel
        title="Техработы"
        hint="На время окна алерты по объекту не поднимаются вовсе"
        action={
          <Link to="/settings?tab=maintenance" className={ui.small}>
            Все окна →
          </Link>
        }
      >
        {windows.length === 0 ? (
          <Empty title="Техработ сейчас нет" icon="wrench" />
        ) : (
          <ul className={ui.stack}>
            {windows.map((w) => (
              <li key={w.id}>
                🛠 <b>{w.targetName ?? w.target}</b> до {fullDateTime(w.endsAt)} — {w.reason} <span className={ui.faint}>({w.createdBy})</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  )
}
