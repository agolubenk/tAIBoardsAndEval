/**
 * Карточка инцидента: хронология (неизменяемый журнал), затронутые объекты, связанные факты
 * (деплои, перезапуски, сбои доставки рядом по времени), подсказки правил — как наблюдения, а не
 * подтверждённая причина. Действия: подтвердить (все алерты в работу + взять себе), назначить,
 * на наблюдение, закрыть с итогом и комментарием.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useAction } from '../../lib/hooks'
import { fullDateTime, incidentCode, preciseDuration, timeShort } from '../../lib/format'
import type { Alert, Incident, IncidentEvent, IncidentFact } from '../../lib/types'
import { SeverityBadge, StatusBadge } from '../../ui/Badge'
import { Button, Field, Textarea } from '../../ui/Controls'
import { cx, Empty, LoadError, PageHero, Panel, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'
import s from '../pages.module.css'
import { IncidentStatusBadge } from '../Incidents'
import { AssignDialog, CLOSE_RESULT, CloseDialog } from './IncidentDialogs'

const TL_CLASS: Partial<Record<IncidentEvent['kind'], string | undefined>> = {
  alert: s.tlAlert,
  action: s.tlAction,
  resolved: s.tlResolved,
}

const FACT_ICON: Record<IncidentFact['kind'], string> = { deploy: '🚀', restart: '🔁', delivery: '📭' }

interface IncidentResponse {
  incident: Incident
  events: IncidentEvent[]
  alerts: Alert[]
  facts: IncidentFact[]
}

export function IncidentPage() {
  const { id = '' } = useParams()
  const { can, user } = useSession()
  const [note, setNote] = useState('')
  const [dialog, setDialog] = useState<'close' | 'assign' | null>(null)
  const q = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api.get<IncidentResponse>(`/incidents/${encodeURIComponent(id)}`),
    refetchInterval: 15_000,
  })
  const invalidate = [['incident', id], ['incidents'], ['overview']]
  const addNote = useAction(() => api.post(`/incidents/${id}/notes`, { message: note }), { success: 'Заметка добавлена', invalidate })
  const setStatus = useAction((status: Incident['status']) => api.post(`/incidents/${id}/status`, { status }), {
    success: 'Статус обновлён',
    invalidate,
  })
  const ack = useAction(() => api.post<{ acked: number }>(`/incidents/${id}/ack`), {
    success: (r) => (r.acked ? `В работе: алертов ${r.acked}, повторы остановлены` : 'Инцидент взят в работу'),
    invalidate,
  })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <Skeleton height={300} />
  const { incident: inc, events, alerts, facts } = q.data
  const open = inc.status !== 'resolved'
  const firingUnacked = alerts.some((a) => a.status === 'firing' && !a.acknowledgedBy)
  const hints = [...new Set(alerts.map((a) => a.hint).filter(Boolean))].slice(0, 3)
  const objects = [...new Map(alerts.map((a) => [a.object, a])).values()]

  return (
    <>
      <p className={ui.small}>
        <Link to="/incidents">Инциденты</Link> <span className={ui.faint}>/ {incidentCode(inc.id)}</span>
      </p>
      <PageHero
        eyebrow={`${incidentCode(inc.id)} · начало ${fullDateTime(inc.startedAt)}`}
        title={inc.title}
        titleAside={
          <>
            <SeverityBadge severity={inc.severity} />
            <IncidentStatusBadge status={inc.status} />
          </>
        }
        lead={[
          inc.summary,
          `${open ? 'Активен' : 'Длился'} ${preciseDuration(inc.startedAt, inc.resolvedAt ?? Date.now())}`,
          `ответственный: ${inc.assignee ?? 'не назначен'}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          can('operator') ? (
            open ? (
              <>
                {firingUnacked || !inc.assignee ? (
                  <Button variant="primary" icon="check" busy={ack.isPending} onClick={() => ack.mutate(undefined)}>
                    Подтвердить
                  </Button>
                ) : null}
                <Button icon="user" onClick={() => setDialog('assign')}>
                  {inc.assignee ? 'Переназначить' : 'Назначить'}
                </Button>
                {inc.status !== 'monitoring' ? <Button onClick={() => setStatus.mutate('monitoring')}>На наблюдение</Button> : null}
                <Button onClick={() => setDialog('close')}>Закрыть</Button>
              </>
            ) : (
              <Button onClick={() => setStatus.mutate('active')}>Открыть снова</Button>
            )
          ) : null
        }
      />
      {!open && (inc.closeResult || inc.closeComment) ? (
        <Panel compact>
          <b>Итог: {inc.closeResult ? CLOSE_RESULT[inc.closeResult] : 'закрыт'}</b>
          {inc.closeComment ? <p className={ui.muted}>{inc.closeComment}</p> : null}
        </Panel>
      ) : null}
      <div className={s.split}>
        <Panel title="Хронология" hint="Неизменяемый журнал: события правил, действия и заметки людей">
          <ol className={s.timeline}>
            {events.map((e) => (
              <li key={e.id} className={cx(s.timelineItem, TL_CLASS[e.kind])}>
                <div>{e.message}</div>
                <div className={s.tlMeta}>
                  {fullDateTime(e.createdAt)} · {e.author}
                </div>
              </li>
            ))}
          </ol>
          {hints.length ? (
            <div className={s.aiHint}>
              <span className={s.aiBadge}>Подсказка правил</span>
              {hints.map((h) => (
                <p key={h}>{h}</p>
              ))}
              <small className={ui.faint}>Это наблюдение по фактам, не подтверждённая причина.</small>
            </div>
          ) : null}
          {can('operator') && open ? (
            <div className={ui.stack}>
              <Field label="Заметка" hint="Факты расследования, выполненные проверки, договорённости — попадут в хронологию и отчёт">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              </Field>
              <div>
                <Button icon="plus" disabled={!note.trim()} busy={addNote.isPending} onClick={() => addNote.mutate(undefined, { onSuccess: () => setNote('') })}>
                  Добавить заметку
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
        <div className={ui.stack}>
          <Panel title="Затронуто" hint={`${objects.length} ${objects.length === 1 ? 'объект' : 'объектов'} · алертов ${alerts.length}`}>
            {alerts.length === 0 ? (
              <Empty title="Алертов нет" icon="bell">
                Инцидент открыт вручную.
              </Empty>
            ) : (
              <ul className={s.feed}>
                {alerts.map((a) => (
                  <li key={a.id} className={s.feedItem}>
                    <span className={s.feedTime} title={fullDateTime(a.startedAt)}>
                      {timeShort(a.startedAt)}
                    </span>
                    <span className={ui.stack} style={{ gap: 4 }}>
                      <span className={ui.row}>
                        <SeverityBadge severity={a.severity} />
                        {a.status === 'resolved' ? <StatusBadge status="healthy" label="Восстановлен" /> : null}
                        {a.acknowledgedBy ? <span className={ui.cellSub}>в работе: {a.acknowledgedBy}</span> : null}
                      </span>
                      <Link to={a.route || `/alerts?focus=${a.id}`}>
                        <b>{a.object}</b> — {a.title}
                      </Link>
                      <span className={s.feedActor}>{a.value || a.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Связанные факты" hint="Что менялось рядом по времени — для расследования, не вывод">
            {facts.length === 0 && !alerts.some((a) => a.facts.length) ? (
              <Empty title="Рядом ничего не менялось" icon="list">
                Деплоев, перезапусков и сбоев доставки около начала не было.
              </Empty>
            ) : (
              <ul className={s.factList}>
                {facts.map((f, i) => (
                  <li key={i} className={f.tone === 'bad' ? s.factBad : undefined}>
                    <span aria-hidden>{FACT_ICON[f.kind]}</span>{' '}
                    {f.url ? (
                      <a href={f.url} target="_blank" rel="noreferrer">
                        {f.text}
                      </a>
                    ) : (
                      f.text
                    )}
                  </li>
                ))}
                {alerts
                  .flatMap((a) => a.facts.slice(0, 3).map(([k, v]) => [a.object, k, v] as const))
                  .slice(0, 8)
                  .map(([obj, k, v], i) => (
                    <li key={`f${i}`}>
                      <span aria-hidden>📌</span> {obj}: {k} — <b>{v}</b>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <CloseDialog id={inc.id} open={dialog === 'close'} onClose={() => setDialog(null)} />
      <AssignDialog id={inc.id} current={inc.assignee} me={user?.email ?? null} open={dialog === 'assign'} onClose={() => setDialog(null)} />
    </>
  )
}
