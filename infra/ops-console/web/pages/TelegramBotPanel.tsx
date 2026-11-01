/** «Интеграции» (владелец): бот консоли, пароль бота, подписки всех админов. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import { fullDateTime, timeAgo } from '../lib/format'
import { StatusBadge } from '../ui/Badge'
import { Button, Dialog, Field, FormError, Input } from '../ui/Controls'
import { LoadError, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { Confirm, TG_STATUS, grouped, suspendedLine, type BotResponse } from './SettingsTelegram'

type PendingAction = { kind: 'remove' } | { kind: 'replace' } | { kind: 'unlink'; id: number; email: string }

export function TelegramBotPanel() {
  const q = useQuery({ queryKey: ['telegram-bot'], queryFn: () => api.get<BotResponse>('/telegram/bot') })
  const [token, setToken] = useState('')
  const [takeoverUrl, setTakeoverUrl] = useState<string | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [ask, setAsk] = useState<PendingAction | null>(null)
  const save = useAction((takeover: boolean) => api.put('/telegram/bot', { token, takeover }), { success: 'Бот подключён', invalidate: [['telegram-bot'], ['telegram-me']] })
  const remove = useAction(() => api.del('/telegram/bot'), { success: 'Бот отключён', invalidate: [['telegram-bot'], ['telegram-me']] })
  const rotate = useAction(() => api.put<{ password: string | null; prompted: number }>('/telegram/bot/password', { password: pw }), {
    success: (r) => `Пароль изменён. Просьбу ввести новый получили: ${r.prompted}`,
    invalidate: [['telegram-bot']],
  })
  const unfreeze = useAction(() => api.post('/telegram/bot/unfreeze'), { success: 'Ввод пароля снова открыт', invalidate: [['telegram-bot']] })
  const subAction = useAction(
    (v: { id: number; op: 'suspend' | 'resume' | 'unlink' }) =>
      v.op === 'unlink' ? api.del(`/telegram/subscriptions/${v.id}`) : api.post(`/telegram/subscriptions/${v.id}/${v.op}`),
    { success: 'Подписка обновлена', invalidate: [['telegram-bot'], ['users']] },
  )

  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <Skeleton height={160} />
  const { bot, subscriptions, confirmed, mode } = q.data
  const live = subscriptions.filter((x) => x.status !== 'suspended')
  const submitToken = (takeover: boolean) =>
    save.mutate(takeover, {
      onSuccess: () => {
        setToken('')
        setTakeoverUrl(null)
      },
      onError: (err) => {
        const m = /вебхук на (\S+)/.exec(err instanceof Error ? err.message : '')
        if (m) setTakeoverUrl(m[1] ?? null)
      },
    })
  const closePw = () => {
    setPwOpen(false)
    setPw('')
    setIssued(null)
    setCopied(false)
  }
  return (
    <>
      <Panel
        title="Telegram-бот"
        hint="Один бот для личных уведомлений админов (и, при желании, групповых каналов). Админ подключает Telegram в своём профиле: код подтверждения в консоли + пароль бота."
        action={
          bot ? (
            <StatusBadge
              status={bot.lastError || bot.frozenReason ? 'warning' : 'healthy'}
              label={bot.frozenReason ? 'Ввод пароля заморожен' : bot.lastError ? 'Есть ошибка' : 'Работает'}
            />
          ) : null
        }
      >
        {bot ? (
          <dl className={ui.kv}>
            <dt>Бот</dt>
            <dd>
              <a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer noopener">
                @{bot.username}
              </a>
            </dd>
            <dt>Принимает сообщения</dt>
            <dd>{bot.lastError ? `ошибка: ${bot.lastError}` : mode === 'webhook' ? 'да (вебхук)' : 'да (опрос — локальный режим)'}</dd>
            <dt>Подписки</dt>
            <dd>
              подтвердили текущий пароль — {confirmed} из {live.length}
            </dd>
            {bot.frozenReason ? (
              <>
                <dt>Заморожено</dt>
                <dd>
                  {bot.frozenReason}{' '}
                  <Button small busy={unfreeze.isPending} onClick={() => unfreeze.mutate(undefined)}>
                    Открыть ввод
                  </Button>
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <div className={`${ui.formGrid} ${ui.formGrid2}`} style={{ marginTop: 12 }}>
          <Field label={bot ? 'Новый токен бота' : 'Токен бота'} wide hint="Создайте бота у @BotFather и вставьте токен. Хранится зашифрованным; смена бота приостанавливает все подписки.">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" />
          </Field>
        </div>
        <FormError error={save.error} />
        {takeoverUrl ? (
          <p className={s.tgNote}>
            У бота уже стоит вебхук на {takeoverUrl}. Если это старая консоль — заберите его; если адрес чужой, смените токен у @BotFather.{' '}
            <Button small variant="danger" busy={save.isPending} onClick={() => submitToken(true)}>
              Забрать вебхук
            </Button>
          </p>
        ) : null}
        <div className={s.actionsRow}>
          <Button variant="primary" busy={save.isPending} disabled={!token} onClick={() => (bot ? setAsk({ kind: 'replace' }) : submitToken(false))}>
            {bot ? 'Сменить бота' : 'Подключить бота'}
          </Button>
          {bot ? (
            <>
              <Button onClick={() => setPwOpen(true)}>{bot.passwordSet ? 'Сменить пароль бота' : 'Задать пароль бота'}</Button>
              <Button variant="ghost" onClick={() => setAsk({ kind: 'remove' })}>
                Отключить бота
              </Button>
            </>
          ) : null}
        </div>
        {bot?.passwordChangedAt ? (
          <p className={s.muted}>
            Пароль бота: версия {bot.passwordVersion}, {fullDateTime(bot.passwordChangedAt)}
            {bot.passwordChangedBy ? ` (${bot.passwordChangedBy})` : ''}
          </p>
        ) : bot ? (
          <p className={s.tgNote}>Пароль бота не задан — подключившиеся админы не получат уведомлений, пока вы его не зададите.</p>
        ) : null}
      </Panel>

      {bot ? (
        <Panel title="Личные подписки" hint="Telegram-аккаунты админов. Приостановленную владельцем подписку возобновляет только владелец." flush>
          {subscriptions.length ? (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Учётка</th>
                    <th>Telegram</th>
                    <th>Статус</th>
                    <th>Последнее уведомление</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <span className={ui.cellMain}>{x.email}</span>
                        <span className={ui.cellSub}>{x.userDisabled ? 'учётка отключена' : x.name || '—'}</span>
                      </td>
                      <td>
                        <span className={ui.cellMain}>{x.username ? `@${x.username}` : x.displayName || '—'}</span>
                        <span className={ui.cellSub}>подключён {timeAgo(x.linkedAt)}</span>
                      </td>
                      <td>
                        <StatusBadge status={TG_STATUS[x.status][0]} label={TG_STATUS[x.status][1]} />
                        {x.status === 'suspended' ? <span className={ui.cellSub}>{suspendedLine(x)}</span> : null}
                      </td>
                      <td className={ui.num}>{x.lastDeliveryAt ? timeAgo(x.lastDeliveryAt) : '—'}</td>
                      <td>
                        <div className={s.actionsCell}>
                          {x.status === 'suspended' ? (
                            <Button small busy={subAction.isPending} onClick={() => subAction.mutate({ id: x.id, op: 'resume' })}>
                              Возобновить
                            </Button>
                          ) : (
                            <Button small busy={subAction.isPending} onClick={() => subAction.mutate({ id: x.id, op: 'suspend' })}>
                              Приостановить
                            </Button>
                          )}
                          <Button small variant="danger" onClick={() => setAsk({ kind: 'unlink', id: x.id, email: x.email })}>
                            Отвязать
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={s.muted} style={{ padding: '0 20px 20px' }}>
              Пока никто не подключил Telegram — админы делают это в Настройки → Профиль.
            </p>
          )}
        </Panel>
      ) : null}

      <Confirm
        open={ask !== null}
        title={ask?.kind === 'unlink' ? 'Отвязать Telegram?' : ask?.kind === 'remove' ? 'Отключить бота?' : 'Сменить бота?'}
        text={
          ask?.kind === 'unlink'
            ? `Отвязать Telegram ${ask.email}? Чтобы снова получать уведомления, придётся подключиться заново: код в профиле и пароль бота.`
            : ask?.kind === 'remove'
              ? `Все личные подписки (${live.length}) будут приостановлены, бот перестанет принимать сообщения. Групповые каналы со своим токеном продолжат работать.`
              : `Если это другой бот, все личные подписки (${live.length}) будут приостановлены — админам придётся подключить Telegram заново.`
        }
        action={ask?.kind === 'unlink' ? 'Отвязать' : ask?.kind === 'remove' ? 'Отключить' : 'Сменить'}
        busy={save.isPending || remove.isPending || subAction.isPending}
        onClose={() => setAsk(null)}
        onConfirm={() => {
          const done = { onSettled: () => setAsk(null) }
          if (ask?.kind === 'unlink') subAction.mutate({ id: ask.id, op: 'unlink' }, done)
          else if (ask?.kind === 'remove') remove.mutate(undefined, done)
          else {
            setAsk(null)
            submitToken(false)
          }
        }}
      />

      <Dialog
        open={pwOpen}
        dismissible={!issued}
        onClose={closePw}
        title={issued ? 'Новый пароль бота' : bot?.passwordSet ? 'Сменить пароль бота?' : 'Пароль бота'}
        actions={
          issued ? (
            <>
              <Button onClick={() => void navigator.clipboard?.writeText(issued).then(() => setCopied(true))}>{copied ? 'Скопировано' : 'Скопировать'}</Button>
              <Button variant="primary" onClick={closePw}>
                Я сохранил пароль
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={closePw}>
                Отмена
              </Button>
              <Button
                variant="primary"
                busy={rotate.isPending}
                disabled={pw.length > 0 && pw.replace(/[\s-]+/g, '').length < 12}
                onClick={() =>
                  rotate.mutate(undefined, {
                    onSuccess: (r) => {
                      setPw('')
                      if (r.password) setIssued(r.password)
                      else closePw()
                    },
                  })
                }
              >
                {pw ? 'Сохранить пароль' : 'Сгенерировать'}
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <>
            <p style={{ margin: 0 }}>Пароль показывается один раз. Передайте его админам не через Telegram. Пробелы при вводе можно не набирать.</p>
            <code className={s.tgSecret}>{grouped(issued)}</code>
          </>
        ) : (
          <>
            {bot?.passwordSet ? (
              <p style={{ margin: 0 }}>
                Подключённые админы ({live.length}) не будут получать уведомления, пока не введут новый пароль. Групповые каналы продолжат работать.
                Пароль покажем один раз — передайте его не через Telegram.
              </p>
            ) : (
              <p style={{ margin: 0 }}>Админы вводят этот пароль в боте после подключения Telegram в профиле. Это не пароль от учётки консоли.</p>
            )}
            <Field label="Пароль" hint="Пусто — сгенерировать (20 символов). Свой — минимум 12 символов; пробелы и дефисы не учитываются.">
              <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <FormError error={rotate.error} />
          </>
        )}
      </Dialog>
    </>
  )
}

/** Колонка «Telegram» в списке пользователей (владелец). */
