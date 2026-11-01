/** «Режим техработ»: объект, длительность, причина. Повторное включение продлевает окно. */
import { useState } from 'react'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import type { MaintenanceWindow } from '../../lib/types'
import { Button, Dialog, Field, FormError, Select, Textarea } from '../../ui/Controls'
import ui from '../../ui/styles'

const DURATIONS: Array<[number, string]> = [
  [30, '30 минут'],
  [60, '1 час'],
  [120, '2 часа'],
  [240, '4 часа'],
  [480, '8 часов'],
  [1440, 'сутки'],
]

export function MaintenanceDialog({
  scope,
  target = '',
  name,
  open,
  onClose,
}: {
  scope: MaintenanceWindow['scope']
  target?: string
  name: string
  open: boolean
  onClose: () => void
}) {
  const [minutes, setMinutes] = useState(120)
  const [reason, setReason] = useState('')
  const start = useAction(() => api.post('/maintenance', { scope, target, minutes, reason }), {
    success: 'Техработы включены — алерты по объекту не поднимаются',
    invalidate: [['maintenance'], ['overview'], ['agents'], ['host'], ['monitors'], ['monitor']],
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Режим техработ"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            icon="wrench"
            busy={start.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => start.mutate(undefined, { onSuccess: () => (setReason(''), onClose()) })}
          >
            Включить
          </Button>
        </>
      }
    >
      <p className={ui.muted}>
        На время окна алерты по «{name}» не поднимаются и не рассылаются; восстановления проходят как обычно. Если проблема останется
        после окна, алерт откроется заново.
      </p>
      <Field label="Объект">
        <span className={ui.cellMain}>{name}</span>
      </Field>
      <Field label="Длительность">
        <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {DURATIONS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Причина" hint="Её увидят все дежурные и журнал событий">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Плановое обновление PostgreSQL" maxLength={500} />
      </Field>
      <FormError error={start.error} />
    </Dialog>
  )
}
