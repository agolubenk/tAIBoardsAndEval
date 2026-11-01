import { useState } from 'react'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import type { Container } from '../lib/types'
import { Button, Dialog, Field, Input, Textarea } from '../ui/Controls'
import ui from '../ui/styles'
import s from './pages.module.css'

/**
 * Перезапуск контейнера. Stateful (хранит данные) — только после ввода точного имени
 * (решение владельца 2026-10-06). Причина обязательна: уходит в ленту, инцидент и отчёт совету.
 */
export function RestartDialog({ agentId, container, onClose }: { agentId: string; container: Container | null; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const restart = useAction(
    (c: Container) =>
      api.post<{ commandId: number }>(`/infra/agents/${encodeURIComponent(agentId)}/containers/${encodeURIComponent(c.name)}/restart`, {
        reason,
        confirmName: c.stateful ? confirm : undefined,
      }),
    { success: 'Команда отправлена — агент выполнит её при следующем отчёте (до ~15 с)', invalidate: [['host', agentId], ['overview']] },
  )
  const close = () => {
    setReason('')
    setConfirm('')
    restart.reset()
    onClose()
  }
  const c = container
  const canSubmit = Boolean(c) && reason.trim().length >= 3 && (!c?.stateful || confirm === c.name)
  return (
    <Dialog
      open={Boolean(c)}
      onClose={close}
      title={c ? `Перезапустить ${c.name}?` : ''}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Отмена
          </Button>
          <Button
            variant={c?.stateful ? 'danger' : 'primary'}
            icon="restart"
            disabled={!canSubmit}
            busy={restart.isPending}
            onClick={() => c && restart.mutate(c, { onSuccess: close })}
          >
            Перезапустить
          </Button>
        </>
      }
    >
      {c ? (
        <>
          <p className={ui.muted}>
            Консоль поставит команду в очередь, контроллер на сервере выполнит <code>docker restart -t 30 {c.name}</code>. Контейнер будет
            недоступен несколько секунд.
          </p>
          {c.stateful ? (
            <div className={s.secretBox} role="alert">
              <strong>Контейнер хранит данные.</strong> Перезапуск оборвёт активные соединения и транзакции всех сервисов, которые от него
              зависят. Чтобы подтвердить, введите имя контейнера.
            </div>
          ) : null}
          <Field label="Причина" hint="Видна в ленте, в инциденте и в отчёте ИИ-совету">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: unhealthy после деплоя, утечка памяти"
              maxLength={300}
              autoFocus
            />
          </Field>
          {c.stateful ? (
            <Field label={`Введите «${c.name}»`}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
        </>
      ) : null}
    </Dialog>
  )
}
