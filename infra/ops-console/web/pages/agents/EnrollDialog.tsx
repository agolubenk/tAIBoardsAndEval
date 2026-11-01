/**
 * «Команда установки»: одноразовая команда на 15 минут — сервер сам скачает агента, получит секрет и
 * запустится; окно ждёт первого отчёта (шаги как в прототипе: код → команда → heartbeat).
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAction } from '../../lib/hooks'
import { timeAgo } from '../../lib/format'
import type { AgentSummary } from '../../lib/types'
import { Button, Dialog, FormError } from '../../ui/Controls'
import ui from '../../ui/styles'
import s from '../pages.module.css'

interface Enrollment {
  id: string
  expiresAt: number
  command: string
}

export function EnrollDialog({ agentId, name, onClose }: { agentId: string | null; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [issuedAt, setIssuedAt] = useState(0)
  const issue = useAction(() => api.post<Enrollment>(`/admin/agents/${agentId}/enroll`))
  const open = Boolean(agentId)
  useEffect(() => {
    if (open && agentId) {
      setCopied(false)
      setIssuedAt(Date.now())
      issue.mutate(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- новый код — только при открытии для агента
  }, [open, agentId])
  const host = useQuery({
    queryKey: ['host', agentId],
    queryFn: () => api.get<{ agent: AgentSummary }>(`/infra/agents/${encodeURIComponent(agentId ?? '')}`),
    enabled: open && Boolean(issue.data),
    refetchInterval: 3_000,
  })
  const seen = host.data?.agent.lastSeenAt
  const connected = Boolean(seen && seen > issuedAt)
  const e = issue.data
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Подключение сервера «${name}»`}
      actions={
        <Button variant={connected ? 'primary' : 'ghost'} onClick={onClose}>
          {connected ? 'Готово' : 'Закрыть'}
        </Button>
      }
    >
      <ol className={s.steps}>
        <li className={e ? s.stepDone : undefined}>Одноразовый код создан{e ? ` — действует до ${new Date(e.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '…'}</li>
        <li className={copied ? s.stepDone : undefined}>Выполните команду на сервере (нужны root, python3, systemd)</li>
        <li className={connected ? s.stepDone : undefined}>
          {connected ? `Первый отчёт получен ${timeAgo(seen)}` : 'Ждём первый отчёт агента (обычно ~15 секунд после установки)…'}
        </li>
      </ol>
      {e ? (
        <>
          <pre className={ui.pre}>{e.command}</pre>
          <div className={ui.row}>
            <Button icon="check" onClick={() => void navigator.clipboard?.writeText(e.command).then(() => setCopied(true))}>
              {copied ? 'Скопировано' : 'Копировать'}
            </Button>
            <Button variant="ghost" icon="refresh" busy={issue.isPending} onClick={() => (setIssuedAt(Date.now()), issue.mutate(undefined))}>
              Новый код
            </Button>
          </div>
          <div className={s.secretBox}>
            Код одноразовый и живёт 15 минут. Установщик скачает файлы агента с этой консоли (сверит контрольные суммы), получит
            новый секрет агента и запустит службу — секрет не проходит через браузер. Прежний секрет агента перестанет работать.
          </div>
        </>
      ) : null}
      <FormError error={issue.error} />
    </Dialog>
  )
}
