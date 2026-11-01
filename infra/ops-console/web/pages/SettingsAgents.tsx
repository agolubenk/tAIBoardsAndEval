import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import { timeAgo } from '../lib/format'
import { StatusBadge } from '../ui/Badge'
import { Button, Check, Dialog, Field, FormError, Input } from '../ui/Controls'
import { Empty, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import type { AdminAgent } from './settingsTypes'
import { EnrollDialog } from './agents/EnrollDialog'

interface Issued {
  id: string
  secret: string
  env: string
}

function SecretOnce({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog
      open={Boolean(issued)}
      onClose={onClose}
      title="Секрет агента — показывается один раз"
      actions={
        <Button variant="primary" onClick={onClose}>
          Я сохранил
        </Button>
      }
    >
      {issued ? (
        <>
          <div className={s.secretBox}>
            Скопируйте строки в <code>/etc/hrh-ops-agent.env</code> на сервере (права 600). После закрытия окна секрет увидеть нельзя —
            только перевыпустить.
          </div>
          <pre className={ui.pre}>{issued.env}</pre>
          <div className={ui.row}>
            <Button
              icon="check"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.env).then(() => setCopied(true))
              }}
            >
              {copied ? 'Скопировано' : 'Скопировать'}
            </Button>
            <span className={ui.small}>
              Затем: <code>sudo ./install.sh</code> → <code>sudo systemctl enable --now hrh-ops-agent</code>
            </span>
          </div>
        </>
      ) : null}
    </Dialog>
  )
}

export function AgentsSettings() {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', environment: 'production' })
  const [issued, setIssued] = useState<Issued | null>(null)
  const [enrolling, setEnrolling] = useState<AdminAgent | null>(null)
  const q = useQuery({ queryKey: ['admin-agents'], queryFn: () => api.get<{ agents: AdminAgent[] }>('/admin/agents') })
  const create = useAction(() => api.post<Issued>('/admin/agents', draft), { invalidate: [['admin-agents'], ['agents']] })
  const rotate = useAction((id: string) => api.post<Issued>(`/admin/agents/${id}/rotate`), { invalidate: [['admin-agents']] })
  const toggle = useAction((a: AdminAgent) => api.patch(`/admin/agents/${a.id}`, { enabled: !a.enabled }), {
    success: 'Агент обновлён',
    invalidate: [['admin-agents'], ['agents']],
  })
  const remove = useAction((id: string) => api.del(`/admin/agents/${id}`), {
    success: 'Агент удалён',
    invalidate: [['admin-agents'], ['agents'], ['overview']],
  })
  return (
    <Panel
      title="Агенты серверов"
      hint="Агент — локальный контроллер хоста (infra/ops-console/agent): сам присылает метрики и забирает команды. Подпись HMAC, повтор запроса отклоняется."
      action={
        <Button variant="primary" small icon="plus" onClick={() => setCreating(true)}>
          Агент
        </Button>
      }
      flush
    >
      {!q.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={80} />
        </div>
      ) : q.data.agents.length === 0 ? (
        <Empty title="Агентов нет" icon="server">
          Создайте агента, скопируйте выданные переменные и поставьте контроллер на сервер.
        </Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Агент</th>
                <th>Связь</th>
                <th>Секрет</th>
                <th>Вкл.</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {q.data.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className={ui.cellMain}>{a.name}</span>
                    <span className={ui.cellSub}>
                      <code>{a.id}</code> · {a.environment}
                    </span>
                  </td>
                  <td>
                    {a.lastSeenAt ? (
                      <StatusBadge status="healthy" label={`отчёт ${timeAgo(a.lastSeenAt)}`} />
                    ) : (
                      <StatusBadge status="pending" label="ещё не подключался" />
                    )}
                  </td>
                  <td className={ui.num}>••••{a.secretHint}</td>
                  <td>
                    <Check
                      label={<span className="visually-hidden">Включён: {a.name}</span>}
                      checked={a.enabled}
                      onChange={() => toggle.mutate(a)}
                    />
                  </td>
                  <td>
                    <div className={s.actionsCell}>
                      <Button small icon="download" onClick={() => setEnrolling(a)}>
                        Команда установки
                      </Button>
                      <Button
                        small
                        icon="refresh"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Перевыпустить секрет «${a.name}»? Старый перестанет приниматься сразу — агент замолчит, пока на сервере не обновят env.`,
                            )
                          )
                            rotate.mutate(a.id, { onSuccess: setIssued })
                        }}
                      >
                        Перевыпустить
                      </Button>
                      <Button
                        small
                        variant="ghost"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Удалить агента «${a.name}»? Его контейнеры пропадут из консоли, история метрик останется до ретенции.`,
                            )
                          )
                            remove.mutate(a.id)
                        }}
                      >
                        Удалить
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Новый агент"
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              busy={create.isPending}
              disabled={!/^[a-z0-9-]{2,64}$/.test(draft.id) || !draft.name.trim()}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: (r) => {
                    setCreating(false)
                    setDraft({ id: '', name: '', environment: 'production' })
                    setIssued(r)
                  },
                })
              }
            >
              Создать и показать секрет
            </Button>
          </>
        }
      >
        <div className={`${ui.formGrid} ${ui.formGrid2}`}>
          <Field label="ID" hint="латиница в нижнем регистре, цифры, дефис">
            <Input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })} placeholder="contabo-main" />
          </Field>
          <Field label="Название">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Contabo VPS 30" />
          </Field>
          <Field label="Окружение">
            <Input value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} />
          </Field>
        </div>
        <FormError error={create.error} />
      </Dialog>
      <SecretOnce issued={issued} onClose={() => setIssued(null)} />
      <EnrollDialog agentId={enrolling?.id ?? null} name={enrolling?.name ?? ""} onClose={() => setEnrolling(null)} />
    </Panel>
  )
}
