/** Заметки дежурных к алерту: «что уже проверили» — видны всем, кто откроет алерт. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { fullDateTime } from '../../lib/format'
import type { Alert } from '../../lib/types'
import { Button, Dialog, Field, FormError, Textarea } from '../../ui/Controls'
import { Empty, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'
import s from '../pages.module.css'

interface Note {
  id: number
  author: string
  message: string
  createdAt: number
}

export function AlertNotesDialog({ alert, onClose }: { alert: Alert | null; onClose: () => void }) {
  const { can, user } = useSession()
  const [text, setText] = useState('')
  const id = alert?.id
  const q = useQuery({
    queryKey: ['alert-notes', id],
    queryFn: () => api.get<{ notes: Note[] }>(`/alerts/${id}/notes`),
    enabled: Boolean(id),
  })
  const add = useAction(() => api.post(`/alerts/${id}/notes`, { message: text }), {
    success: 'Заметка добавлена',
    invalidate: [['alert-notes', id], ['alerts']],
  })
  const ack = useAction(() => api.post(`/alerts/${id}/ack`), { success: 'Алерт взят в работу', invalidate: [['alerts'], ['overview']] })
  return (
    <Dialog
      open={Boolean(alert)}
      onClose={onClose}
      title={alert ? `${alert.title} — ${alert.object}` : ''}
      actions={
        <>
          {alert && can('operator') && alert.status === 'firing' && !alert.acknowledgedBy ? (
            <Button busy={ack.isPending} onClick={() => ack.mutate(undefined)}>
              Взять себе{user ? ` (${user.email})` : ''}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
        </>
      }
    >
      {alert ? (
        <dl className={ui.kv}>
          <dt>Источник</dt>
          <dd>{alert.object}</dd>
          <dt>Условие</dt>
          <dd>{[alert.value, alert.detail].filter(Boolean).join(' · ') || '—'}</dd>
          {alert.acknowledgedBy ? (
            <>
              <dt>В работе</dt>
              <dd>{alert.acknowledgedBy}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <h3 className={ui.panelTitle}>Заметки</h3>
      {!q.data ? (
        <Skeleton height={60} />
      ) : q.data.notes.length === 0 ? (
        <Empty title="Заметок нет" icon="message">
          Запишите, что уже проверили, — следующий дежурный не будет повторять.
        </Empty>
      ) : (
        <ol className={s.timeline}>
          {q.data.notes.map((n) => (
            <li key={n.id} className={s.timelineItem}>
              <div>{n.message}</div>
              <div className={s.tlMeta}>
                {fullDateTime(n.createdAt)} · {n.author}
              </div>
            </li>
          ))}
        </ol>
      )}
      {can('operator') ? (
        <>
          <Field label="Комментарий оператора" hint={alert?.incidentId ? 'Попадёт и в хронологию инцидента' : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Что уже проверили?" maxLength={2000} />
          </Field>
          <div>
            <Button icon="plus" disabled={!text.trim()} busy={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => setText('') })}>
              Добавить
            </Button>
          </div>
          <FormError error={add.error} />
        </>
      ) : null}
    </Dialog>
  )
}
