/** Профиль: личная Telegram-подписка (любая учётка, включая вход через платформу). */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useAction } from '../lib/hooks'
import { fullDateTime, timeAgo } from '../lib/format'
import { StatusBadge } from '../ui/Badge'
import { Button, Check, Field, FormError, Input, Select } from '../ui/Controls'
import { LoadError, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { Confirm, LinkStep, TG_STATUS, suspendedLine, type MeResponse } from './SettingsTelegram'

export function TelegramProfile() {
  const q = useQuery({
    queryKey: ['telegram-me'],
    queryFn: () => api.get<MeResponse>('/telegram/me'),
    // Человек уходит в Telegram и возвращается: статус обновляем часто, пока идёт подключение.
    refetchInterval: (query) => {
      const d = query.state.data
      return d?.pending || d?.subscription?.status === 'awaiting_password' || d?.subscription?.status === 'reconfirm' ? 3000 : false
    },
    refetchOnWindowFocus: true,
  })
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null)
  const [code, setCode] = useState('')
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const createLink = useAction(() => api.post<{ url: string; expiresAt: number }>('/telegram/me/link'), { invalidate: [['telegram-me']] })
  const cancelLink = useAction(() => api.del('/telegram/me/link'), { invalidate: [['telegram-me']] })
  const confirm = useAction(() => api.post('/telegram/me/confirm', { code }), {
    success: 'Telegram привязан — осталось ввести пароль бота',
    invalidate: [['telegram-me']],
  })
  const patch = useAction((body: Record<string, unknown>) => api.patch('/telegram/me', body), { success: 'Сохранено', invalidate: [['telegram-me']] })
  const resume = useAction(() => api.post('/telegram/me/resume'), { success: 'Возобновлено — введите пароль бота в Telegram', invalidate: [['telegram-me']] })
  const stop = useAction(() => api.post('/telegram/me/stop'), { success: 'Уведомления в Telegram приостановлены', invalidate: [['telegram-me']] })
  const unlink = useAction(() => api.del('/telegram/me'), { success: 'Telegram отвязан', invalidate: [['telegram-me']] })

  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <Skeleton height={120} />
  const { bot, subscription: sub, pending } = q.data
  if (!bot) {
    return (
      <Panel title="Telegram" hint="Личные уведомления об алертах в Telegram.">
        <p className={s.muted}>Бот консоли ещё не подключён — его подключает владелец (Настройки → Интеграции).</p>
      </Panel>
    )
  }
  const botLink = (
    <a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer noopener">
      @{bot.username}
    </a>
  )
  const startLink = () => createLink.mutate(undefined, { onSuccess: (r) => setLink(r) })
  const stopLink = () => cancelLink.mutate(undefined, { onSuccess: () => setLink(null) })
  const activeLink = pending?.stage === 'link' && link && link.expiresAt > Date.now() ? link : null
  const awaitingCode = pending?.stage === 'code'
  const staleBot = Boolean(sub?.otherBot)
  return (
    <Panel
      title="Telegram"
      hint="Личные уведомления об алертах. Подключение подтверждается кодом здесь и паролем бота, который выдаёт владелец консоли."
      action={sub && !staleBot ? <StatusBadge status={TG_STATUS[sub.status][0]} label={TG_STATUS[sub.status][1]} /> : null}
    >
      {awaitingCode ? (
        <form
          className={s.tgStep}
          onSubmit={(e) => {
            e.preventDefault()
            if (code.replace(/\D/g, '').length === 6) confirm.mutate(undefined, { onSuccess: () => setCode('') })
          }}
        >
          <p>
            Бот прислал код из 6 цифр{pending.telegram ? <> в Telegram <b>{pending.telegram}</b></> : null}. Введите его — так консоль убедится, что
            Telegram ваш. Если это не ваш аккаунт — нажмите «Отмена».
          </p>
          <div className={s.actionsRow}>
            <Input
              aria-label="Код из Telegram"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="000 000"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ maxWidth: 160 }}
            />
            <Button type="submit" variant="primary" busy={confirm.isPending} disabled={code.replace(/\D/g, '').length !== 6}>
              Подтвердить
            </Button>
            <Button variant="ghost" busy={cancelLink.isPending} onClick={stopLink}>
              Отмена
            </Button>
          </div>
          <FormError error={confirm.error} />
        </form>
      ) : null}

      {!awaitingCode && sub && staleBot ? (
        <div className={s.tgStep}>
          <p className={s.tgNote}>Бот консоли сменён — подключите Telegram заново.</p>
          {activeLink ? (
            <LinkStep link={activeLink} lead="Откройте нового бота и нажмите «Старт»." onCancel={stopLink} />
          ) : (
            <div className={s.actionsRow}>
              <Button variant="primary" busy={createLink.isPending} onClick={startLink}>
                Подключить Telegram
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {!awaitingCode && sub && !staleBot ? (
        <>
          <dl className={ui.kv}>
            <dt>Аккаунт</dt>
            <dd>
              {sub.displayName || '—'}
              {sub.username ? ` · @${sub.username}` : ''}
            </dd>
            <dt>Подключён</dt>
            <dd>{fullDateTime(sub.linkedAt)}</dd>
            {sub.status === 'suspended' ? (
              <>
                <dt>Причина</dt>
                <dd>{suspendedLine(sub)}</dd>
              </>
            ) : null}
            {sub.lastDeliveryAt ? (
              <>
                <dt>Последнее уведомление</dt>
                <dd>{timeAgo(sub.lastDeliveryAt)}</dd>
              </>
            ) : null}
          </dl>
          {sub.status === 'awaiting_password' || sub.status === 'reconfirm' ? (
            <p className={s.tgNote}>
              {!bot.passwordSet ? (
                'Владелец консоли ещё не задал пароль бота — уведомления включатся после его ввода.'
              ) : bot.viaApp ? (
                <>Откройте чат с {botLink} и нажмите «Ввести пароль». Пароль выдаёт владелец консоли — это не пароль от учётки.</>
              ) : (
                <>Отправьте пароль бота сообщением в чат с {botLink} — бот сразу удалит это сообщение.</>
              )}
            </p>
          ) : null}
          <div className={`${ui.formGrid} ${ui.formGrid2}`} style={{ marginTop: 12 }}>
            <Field label="Что присылать" hint="Если вы и в групповом Telegram-канале, предупреждения придут дважды — оставьте здесь только критичные.">
              <Select value={sub.minSeverity} disabled={patch.isPending} onChange={(e) => patch.mutate({ minSeverity: e.target.value })}>
                <option value="warning">Предупреждения и критичные</option>
                <option value="critical">Только критичные</option>
              </Select>
            </Field>
            <Field label="Дайджест">
              <Check checked={sub.digest} disabled={patch.isPending} onChange={(v) => patch.mutate({ digest: v })} label="Суточный отчёт" />
            </Field>
          </div>
          {activeLink ? (
            <LinkStep link={activeLink} lead="Откройте бота из нового аккаунта — текущий работает, пока новый не подтвердите кодом." onCancel={stopLink} />
          ) : (
            <div className={s.actionsRow}>
              {sub.status === 'suspended' ? (
                sub.ownerLock ? null : (
                  <Button variant="primary" busy={resume.isPending} onClick={() => resume.mutate(undefined)}>
                    Возобновить
                  </Button>
                )
              ) : (
                <Button busy={stop.isPending} onClick={() => stop.mutate(undefined)}>
                  Приостановить
                </Button>
              )}
              {!sub.ownerLock ? (
                <>
                  <Button variant="ghost" busy={createLink.isPending} onClick={startLink}>
                    Подключить другой аккаунт
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmUnlink(true)}>
                    Отвязать
                  </Button>
                </>
              ) : null}
            </div>
          )}
          {sub.ownerLock && sub.status === 'suspended' ? (
            <p className={s.muted}>Уведомления остановил владелец консоли (или за перебор пароля бота) — возобновить их может только он.</p>
          ) : null}
        </>
      ) : null}

      {!awaitingCode && !sub ? (
        activeLink ? (
          <LinkStep link={activeLink} lead="Откройте бота и нажмите «Старт»." onCancel={stopLink} />
        ) : (
          <div className={s.actionsRow}>
            <Button variant="primary" busy={createLink.isPending} onClick={startLink}>
              Подключить Telegram
            </Button>
          </div>
        )
      ) : null}

      <Confirm
        open={confirmUnlink}
        title="Отвязать Telegram?"
        text="Уведомления перестанут приходить. Чтобы снова их получать, придётся подключиться заново: код в профиле и пароль бота."
        action="Отвязать"
        busy={unlink.isPending}
        onClose={() => setConfirmUnlink(false)}
        onConfirm={() => unlink.mutate(undefined, { onSettled: () => setConfirmUnlink(false) })}
      />
    </Panel>
  )
}

