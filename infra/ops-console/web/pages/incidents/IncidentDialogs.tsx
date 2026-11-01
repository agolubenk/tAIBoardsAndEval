/** Диалоги инцидента: закрытие с итогом и комментарием, назначение ответственного. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import type { Incident } from '../../lib/types'
import { Button, Dialog, Field, FormError, Select, Textarea } from '../../ui/Controls'
import ui from '../../ui/styles'

type CloseResult = NonNullable<Incident['closeResult']>

export const CLOSE_RESULT: Record<CloseResult, string> = {
  fixed: 'Устранено',
  false_positive: 'Ложное срабатывание',
  accepted_risk: 'Принят риск',
}

export function CloseDialog({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<CloseResult>('fixed')
  const [comment, setComment] = useState('')
  const close = useAction(() => api.post(`/incidents/${id}/status`, { status: 'resolved', result, comment }), {
    success: 'Инцидент закрыт',
    invalidate: [['incident', String(id)], ['incidents'], ['overview']],
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Закрыть инцидент"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" busy={close.isPending} onClick={() => close.mutate(undefined, { onSuccess: onClose })}>
            Закрыть инцидент
          </Button>
        </>
      }
    >
      <Field label="Итог">
        <Select value={result} onChange={(e) => setResult(e.target.value as CloseResult)}>
          {Object.entries(CLOSE_RESULT).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Комментарий к закрытию" hint="Что сделано и как подтверждено восстановление — попадёт в хронологию и отчёт">
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
      </Field>
      <FormError error={close.error} />
    </Dialog>
  )
}

export function AssignDialog({
  id,
  current,
  me,
  open,
  onClose,
}: {
  id: number
  current: string | null
  me: string | null
  open: boolean
  onClose: () => void
}) {
  const [assignee, setAssignee] = useState<string>(current ?? me ?? '')
  const people = useQuery({
    queryKey: ['incident-assignees'],
    queryFn: () => api.get<{ assignees: Array<{ email: string; name: string }> }>('/incidents/assignees'),
    enabled: open,
  })
  const assign = useAction((email: string | null) => api.post(`/incidents/${id}/assign`, { assignee: email }), {
    success: 'Ответственный обновлён',
    invalidate: [['incident', String(id)], ['incidents']],
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ответственный за инцидент"
      actions={
        <>
          {current ? (
            <Button variant="ghost" busy={assign.isPending} onClick={() => assign.mutate(null, { onSuccess: onClose })}>
              Снять
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={!assignee} busy={assign.isPending} onClick={() => assign.mutate(assignee, { onSuccess: onClose })}>
            Назначить
          </Button>
        </>
      }
    >
      <p className={ui.muted}>Ответственный ведёт инцидент до закрытия: заметки, решения, итог.</p>
      <Field label="Кому">
        <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          {me ? <option value={me}>Мне ({me})</option> : null}
          {(people.data?.assignees ?? [])
            .filter((p) => p.email !== me)
            .map((p) => (
              <option key={p.email} value={p.email}>
                {p.name ? `${p.name} · ${p.email}` : p.email}
              </option>
            ))}
        </Select>
      </Field>
      <FormError error={assign.error ?? people.error} />
    </Dialog>
  )
}
