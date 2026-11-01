import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { fullDateTime, incidentCode, preciseDuration, timeAgo } from '../lib/format'
import { plural } from '../../shared/plural'
import type { Incident, UiStatus } from '../lib/types'
import { SeverityBadge, StatusBadge } from '../ui/Badge'
import { Button, Dialog, Field, FormError, Input, Select, Tabs, Textarea } from '../ui/Controls'
import { Empty, LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'

const STATUS: Record<Incident['status'], [string, UiStatus]> = {
  active: ['Активен', 'critical'],
  monitoring: ['Наблюдение', 'warning'],
  resolved: ['Закрыт', 'healthy'],
}

export function IncidentStatusBadge({ status }: { status: Incident['status'] }) {
  const [label, st] = STATUS[status]
  return <StatusBadge status={st} label={label} />
}

function NewIncidentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<'warning' | 'critical'>('critical')
  const [summary, setSummary] = useState('')
  const create = useAction(() => api.post<{ id: number }>('/incidents', { title, severity, summary }), {
    success: 'Инцидент открыт',
    invalidate: [['incidents']],
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Открыть инцидент вручную"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={title.trim().length < 3}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (r) => {
                  onClose()
                  navigate(`/incidents/${r.id}`)
                },
              })
            }
          >
            Открыть
          </Button>
        </>
      }
    >
      <p className={ui.muted}>
        Для проблем, которые правила не видят: жалобы пользователей, деградация внешнего API, плановые работы с риском.
      </p>
      <Field label="Заголовок">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Медленно открываются карточки кандидатов" />
      </Field>
      <Field label="Важность">
        <Select value={severity} onChange={(e) => setSeverity(e.target.value as 'warning' | 'critical')}>
          <option value="critical">Критично</option>
          <option value="warning">Внимание</option>
        </Select>
      </Field>
      <Field label="Что известно">
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <FormError error={create.error} />
    </Dialog>
  )
}

export function IncidentsPage() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(false)
  const filter = (params.get('status') as 'open' | 'resolved' | 'all' | null) ?? 'open'
  const q = useQuery({
    queryKey: ['incidents', filter],
    queryFn: () => api.get<{ incidents: Incident[] }>(`/incidents?status=${filter}`),
    refetchInterval: 20_000,
  })
  return (
    <>
      <PageHero
        eyebrow="Инциденты"
        title="Инциденты"
        lead="Критичный алерт открывает инцидент; симптомы того же объекта присоединяются к нему. Инцидент закрывается, когда восстановились все его алерты, — или вручную."
        actions={
          can('operator') ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Открыть инцидент
            </Button>
          ) : null
        }
      />
      <Tabs
        label="Фильтр инцидентов"
        value={filter}
        onChange={(v) => setParams(v === 'open' ? {} : { status: v })}
        items={[
          { id: 'open', label: 'Открытые' },
          { id: 'resolved', label: 'Закрытые' },
          { id: 'all', label: 'Все' },
        ]}
      />
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Panel flush>
          {!q.data ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={120} />
            </div>
          ) : q.data.incidents.length === 0 ? (
            <Empty title={filter === 'open' ? 'Открытых инцидентов нет' : 'Инцидентов нет'} />
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Инцидент</th>
                    <th>Важность</th>
                    <th>Затронуто</th>
                    <th>Начало</th>
                    <th>Длительность</th>
                    <th>Ответственный</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.incidents.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link className={ui.rowLink} to={`/incidents/${i.id}`}>
                          {incidentCode(i.id)} · {i.title}
                        </Link>
                        <span className={ui.cellSub}>
                          {i.summary ? i.summary.slice(0, 90) : i.createdBy === 'system' ? 'открыт правилом' : `открыл(а) ${i.createdBy}`}
                        </span>
                      </td>
                      <td>
                        <SeverityBadge severity={i.severity} />
                      </td>
                      <td className={ui.num}>{i.affected ? plural(i.affected, ['объект', 'объекта', 'объектов']) : '—'}</td>
                      <td className={ui.num} title={timeAgo(i.startedAt)}>
                        {fullDateTime(i.startedAt)}
                      </td>
                      <td className={ui.num}>{preciseDuration(i.startedAt, i.resolvedAt ?? Date.now())}</td>
                      <td>{i.assignee ?? <span className={ui.cellSub}>не назначен</span>}</td>
                      <td>
                        <IncidentStatusBadge status={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      <NewIncidentDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
