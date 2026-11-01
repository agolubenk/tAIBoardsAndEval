import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { timeAgo } from '../lib/format'
import type { Channel } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button, Check, Dialog, Field, FormError, Input, Select } from '../ui/Controls'
import { Empty, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'

type Kind = Channel['kind']

const KIND_LABEL: Record<Kind, string> = { telegram: 'Telegram-бот', email: 'Email (SMTP)', webhook: 'Webhook с HMAC' }

interface Draft {
  kind: Kind
  name: string
  config: Record<string, string | boolean>
  secrets: Record<string, string>
  minSeverity: Channel['minSeverity']
  digest: boolean
  enabled: boolean
}

const DEFAULTS: Record<Kind, Record<string, string | boolean>> = {
  telegram: { chatId: '' },
  email: { host: '', port: '587', secure: false, user: '', from: '', to: '' },
  webhook: { url: 'https://' },
}

const empty = (kind: Kind): Draft => ({
  kind,
  name: '',
  config: { ...DEFAULTS[kind] },
  secrets: {},
  minSeverity: 'warning',
  digest: false,
  enabled: true,
})

function fromChannel(ch: Channel): Draft {
  const config: Record<string, string | boolean> = { ...DEFAULTS[ch.kind] }
  for (const [k, v] of Object.entries(ch.config)) config[k] = typeof v === 'boolean' ? v : String(v ?? '')
  return { kind: ch.kind, name: ch.name, config, secrets: {}, minSeverity: ch.minSeverity, digest: ch.digest, enabled: ch.enabled }
}

function SecretInput({
  label,
  field,
  d,
  mask,
  onChange,
  hint,
}: {
  label: string
  field: string
  d: Draft
  mask: string | null | undefined
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <Field label={label} hint={mask ? `Сейчас: ${mask}. Пусто — оставить прежнее значение.` : hint}>
      <Input
        type="password"
        autoComplete="new-password"
        value={d.secrets[field] ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={mask ? 'не менять' : ''}
      />
    </Field>
  )
}

interface Discovery {
  bot: string
  chats: Array<{ id: string; type: string; title: string }>
  hint: string | null
}

/** getMe + getUpdates: проверяет токен и показывает чаты, где бот получал сообщения. */
function TelegramChatFinder({ token, channelId, onPick }: { token: string; channelId?: number; onPick: (id: string) => void }) {
  const find = useAction(() => api.post<Discovery>('/channels/telegram/discover', { botToken: token, channelId }))
  const r = find.data
  return (
    <div className={`${ui.span2} ${ui.stack}`}>
      <div className={ui.row}>
        <Button small icon="refresh" busy={find.isPending} disabled={!token && !channelId} onClick={() => find.mutate(undefined)}>
          Найти чат
        </Button>
        <span className={ui.small}>Сначала напишите боту /start — консоль увидит этот чат.</span>
      </div>
      {r ? (
        <div className={ui.stack}>
          <span className={ui.small}>Бот: @{r.bot}</span>
          {r.chats.map((c) => (
            <Button key={c.id} small variant="ghost" onClick={() => onPick(c.id)}>
              {c.title} · {c.type} · {c.id}
            </Button>
          ))}
          {r.hint ? <span className={ui.small}>{r.hint}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function ChannelDialog({ channel, onClose }: { channel: Channel | null | undefined; onClose: () => void }) {
  const [d, setD] = useState<Draft>(empty('telegram'))
  useEffect(() => setD(channel ? fromChannel(channel) : empty('telegram')), [channel])
  const cfg = (k: string, v: string | boolean) => setD((x) => ({ ...x, config: { ...x.config, [k]: v } }))
  const sec = (k: string, v: string) => setD((x) => ({ ...x, secrets: { ...x.secrets, [k]: v } }))
  const save = useAction(
    () => {
      const config = d.kind === 'email' ? { ...d.config, port: Number(d.config.port) || 587 } : d.config
      const body = { name: d.name, config, secrets: d.secrets, minSeverity: d.minSeverity, digest: d.digest, enabled: d.enabled }
      return channel ? api.patch(`/channels/${channel.id}`, body) : api.post('/channels', { ...body, kind: d.kind })
    },
    { success: channel ? 'Канал сохранён' : 'Канал добавлен — отправьте тестовое сообщение', invalidate: [['channels']] },
  )
  const str = (k: string) => String(d.config[k] ?? '')
  return (
    <Dialog
      open={channel !== undefined}
      onClose={onClose}
      title={channel ? `Канал «${channel.name}»` : 'Новый канал уведомлений'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!d.name.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: onClose })}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Field label="Тип">
          <Select value={d.kind} disabled={Boolean(channel)} onChange={(e) => setD({ ...empty(e.target.value as Kind), name: d.name })}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Название">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Дежурные DevOps" />
        </Field>
        {d.kind === 'telegram' ? (
          <>
            <SecretInput
              label="Токен бота"
              field="botToken"
              d={d}
              mask={channel?.secretMasks.botToken}
              onChange={(v) => sec('botToken', v)}
              hint="Выдаёт @BotFather. Бот должен быть добавлен в чат."
            />
            <Field label="Chat ID" hint="Личный чат — число, группа — -100…">
              <Input value={str('chatId')} onChange={(e) => cfg('chatId', e.target.value)} />
            </Field>
            <TelegramChatFinder token={d.secrets.botToken ?? ''} channelId={channel?.id} onPick={(id) => cfg('chatId', id)} />
          </>
        ) : null}
        {d.kind === 'email' ? (
          <>
            <Field label="SMTP-хост">
              <Input value={str('host')} onChange={(e) => cfg('host', e.target.value)} placeholder="smtp.yandex.ru" />
            </Field>
            <Field label="Порт">
              <Input inputMode="numeric" value={str('port')} onChange={(e) => cfg('port', e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Логин">
              <Input value={str('user')} autoComplete="off" onChange={(e) => cfg('user', e.target.value)} />
            </Field>
            <SecretInput
              label="Пароль SMTP"
              field="password"
              d={d}
              mask={channel?.secretMasks.password}
              onChange={(v) => sec('password', v)}
            />
            <Field label="От кого">
              <Input value={str('from')} onChange={(e) => cfg('from', e.target.value)} placeholder="ops@hrhelper.space" />
            </Field>
            <Field label="Кому" hint="Несколько адресов — через запятую">
              <Input value={str('to')} onChange={(e) => cfg('to', e.target.value)} />
            </Field>
            <Check label="TLS сразу (порт 465)" checked={Boolean(d.config.secure)} onChange={(v) => cfg('secure', v)} />
          </>
        ) : null}
        {d.kind === 'webhook' ? (
          <>
            <Field label="URL" wide hint="POST с JSON, заголовки X-Ops-Timestamp и X-Ops-Signature: sha256=HMAC(ключ, «timestamp.body»)">
              <Input type="url" value={str('url')} onChange={(e) => cfg('url', e.target.value)} />
            </Field>
            <SecretInput
              label="Ключ подписи HMAC"
              field="signingSecret"
              d={d}
              mask={channel?.secretMasks.signingSecret}
              onChange={(v) => sec('signingSecret', v)}
              hint="Обязателен: webhook без подписи не создаётся"
            />
          </>
        ) : null}
        <Field label="Минимальная важность">
          <Select value={d.minSeverity} onChange={(e) => setD({ ...d, minSeverity: e.target.value as Draft['minSeverity'] })}>
            <option value="warning">Все алерты</option>
            <option value="critical">Только критичные</option>
          </Select>
        </Field>
        <div className={ui.stack}>
          <Check label="Ежедневный дайджест" checked={d.digest} onChange={(v) => setD({ ...d, digest: v })} />
          <Check label="Включён" checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} />
        </div>
      </div>
      <FormError error={save.error} />
    </Dialog>
  )
}

export function ChannelsPanel() {
  const { can } = useSession()
  const [editing, setEditing] = useState<Channel | null | undefined>(undefined)
  const q = useQuery({ queryKey: ['channels'], queryFn: () => api.get<{ channels: Channel[] }>('/channels') })
  const test = useAction((id: number) => api.post<{ ok: boolean }>(`/channels/${id}/test`), {
    success: 'Тестовое сообщение доставлено',
    invalidate: [['channels'], ['deliveries']],
  })
  const remove = useAction((id: number) => api.del(`/channels/${id}`), { success: 'Канал удалён', invalidate: [['channels']] })
  const owner = can('owner')
  return (
    <Panel
      title="Каналы уведомлений"
      hint="Алерт уходит во все включённые каналы, чья минимальная важность не выше важности алерта. В консоли алерты видны всегда."
      action={
        owner ? (
          <Button variant="primary" small icon="plus" onClick={() => setEditing(null)}>
            Канал
          </Button>
        ) : null
      }
      flush
    >
      {!q.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={100} />
        </div>
      ) : q.data.channels.length === 0 ? (
        <Empty title="Каналов нет" icon="send">
          {owner
            ? 'Добавьте Telegram-бота, почту или webhook — иначе алерты видны только в консоли.'
            : 'Каналы добавляет владелец консоли.'}
        </Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Канал</th>
                <th>Что получает</th>
                <th>Последняя проверка</th>
                <th>Последняя доставка</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {q.data.channels.map((ch) => (
                <tr key={ch.id} style={ch.enabled ? undefined : { opacity: 0.6 }}>
                  <td>
                    <span className={ui.cellMain}>{ch.name}</span>
                    <span className={ui.cellSub}>
                      {KIND_LABEL[ch.kind]}
                      {ch.enabled ? '' : ' · выключен'}
                    </span>
                  </td>
                  <td className={ui.small}>
                    {ch.minSeverity === 'critical' ? 'Только критичные' : 'Все алерты'}
                    {ch.digest ? ' + дайджест' : ''}
                  </td>
                  <td className={ui.small}>
                    {ch.lastTestAt ? (
                      <>
                        {ch.lastTestOk ? '✅' : '❌'} тест {timeAgo(ch.lastTestAt)}
                      </>
                    ) : (
                      'не проверялся'
                    )}
                  </td>
                  <td>
                    {ch.lastError && (!ch.lastOkAt || (ch.lastErrorAt ?? 0) > ch.lastOkAt) ? (
                      <StatusBadge status="critical" label={`${timeAgo(ch.lastErrorAt)}: ${ch.lastError}`} />
                    ) : ch.lastDeliveryAt ? (
                      <StatusBadge
                        status={ch.lastDeliveryOk ? 'healthy' : 'critical'}
                        label={`${ch.lastDeliveryOk ? 'Доставлено' : 'Ошибка'} ${timeAgo(ch.lastDeliveryAt)}`}
                      />
                    ) : ch.lastOkAt ? (
                      <StatusBadge status="pending" label="Только тест — алертов ещё не было" />
                    ) : (
                      <StatusBadge status="pending" label="Ещё не отправлялось" />
                    )}
                  </td>
                  <td>
                    <div className={s.actionsCell}>
                      <Button small icon="send" busy={test.isPending && test.variables === ch.id} onClick={() => test.mutate(ch.id)}>
                        Тест
                      </Button>
                      {owner ? (
                        <>
                          <Button small onClick={() => setEditing(ch)}>
                            Изменить
                          </Button>
                          <Button
                            small
                            variant="ghost"
                            onClick={() => {
                              if (window.confirm(`Удалить канал «${ch.name}»?`)) remove.mutate(ch.id)
                            }}
                          >
                            Удалить
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ChannelDialog channel={editing} onClose={() => setEditing(undefined)} />
    </Panel>
  )
}
