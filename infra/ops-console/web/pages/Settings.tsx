import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ROLE_LABEL, useSession } from '../lib/session'
import { useAction } from '../lib/hooks'
import { timeAgo } from '../lib/format'
import type { Role } from '../lib/types'
import { StatusBadge } from '../ui/Badge'
import { Button, Dialog, Field, FormError, Input, Select, Tabs } from '../ui/Controls'
import { LoadError, PageHero, Panel, Skeleton } from '../ui/Glass'
import ui from '../ui/styles'
import s from './pages.module.css'
import { AgentsSettings } from './SettingsAgents'
import { TelegramCell, useTelegramByUser } from './SettingsTelegram'
import { TelegramProfile } from './TelegramProfile'
import { TelegramBotPanel } from './TelegramBotPanel'
import { MaintenancePanel } from './maintenance/MaintenancePanel'
import { GeneralForm } from './settings/GeneralForm'
import { OnboardingPanel } from './settings/Onboarding'
import type { AdminUser, SettingsResponse } from './settingsTypes'

type Tab = 'onboarding' | 'general' | 'agents' | 'users' | 'maintenance' | 'integrations' | 'profile'

function UsersSettings() {
  const { user: me } = useSession()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ email: '', name: '', role: 'operator' as Role, password: '' })
  /** Смена email локальной учётки — так снимается конфликт со входом через платформу. */
  const [emailEdit, setEmailEdit] = useState<{ id: number; email: string } | null>(null)
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ users: AdminUser[] }>('/admin/users') })
  const tg = useTelegramByUser()
  const create = useAction(() => api.post('/admin/users', draft), { success: 'Пользователь добавлен', invalidate: [['users']] })
  const patch = useAction((v: { id: number; body: Record<string, unknown> }) => api.patch(`/admin/users/${v.id}`, v.body), {
    success: 'Пользователь обновлён',
    invalidate: [['users']],
  })
  return (
    <Panel
      title="Пользователи консоли"
      hint="Владелец — всё; оператор — перезапуски, алерты, правила, мониторы; наблюдатель — только чтение. Учётки «через платформу» создаются при первом входе админа платформы, их роль и доступ меняются в продукте."
      action={
        <Button variant="primary" small icon="plus" onClick={() => setCreating(true)}>
          Пользователь
        </Button>
      }
      flush
    >
      {q.isError ? (
        <LoadError error={q.error} />
      ) : !q.data ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={80} />
        </div>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль</th>
                <th>Telegram</th>
                <th>Последний вход</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {q.data.users.map((u) => (
                <tr key={u.id} style={u.disabled ? { opacity: 0.6 } : undefined}>
                  <td>
                    <span className={ui.cellMain}>{u.email}</span>
                    <span className={ui.cellSub}>
                      {u.name || '—'}
                      {u.sso ? ' · через платформу' : ''}
                      {u.id === me?.id ? ' · это вы' : ''}
                    </span>
                  </td>
                  <td>
                    <Select
                      aria-label={`Роль ${u.email}`}
                      title={u.sso ? 'Роль задаёт платформа: суперадмин — владелец, выданный доступ — оператор' : undefined}
                      value={u.role}
                      disabled={patch.isPending || u.sso}
                      onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value } })}
                      style={{ minWidth: 150 }}
                    >
                      {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <TelegramCell ready={tg.ready} sub={tg.byUser.get(u.id)} />
                  </td>
                  <td className={ui.num}>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'не входил'}</td>
                  <td>
                    <div className={s.actionsCell}>
                      {u.disabled ? <StatusBadge status="unknown" label="Заблокирован" /> : null}
                      {!u.sso ? (
                        <Button small variant="ghost" onClick={() => setEmailEdit({ id: u.id, email: u.email })}>
                          Email
                        </Button>
                      ) : null}
                      {u.id !== me?.id ? (
                        <Button small variant="ghost" onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabled } })}>
                          {u.disabled ? 'Разблокировать' : 'Заблокировать'}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={emailEdit !== null}
        onClose={() => setEmailEdit(null)}
        title="Email учётки"
        actions={
          <>
            <Button variant="ghost" onClick={() => setEmailEdit(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              busy={patch.isPending}
              disabled={!emailEdit?.email.includes('@')}
              onClick={() =>
                emailEdit && patch.mutate({ id: emailEdit.id, body: { email: emailEdit.email } }, { onSuccess: () => setEmailEdit(null) })
              }
            >
              Сохранить
            </Button>
          </>
        }
      >
        <Field label="Email" hint="Вход по этой учётке — с новым email. Сессии не завершаются.">
          <Input
            type="email"
            value={emailEdit?.email ?? ''}
            onChange={(e) => setEmailEdit((v) => (v ? { ...v, email: e.target.value } : v))}
          />
        </Field>
      </Dialog>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Новый пользователь"
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              busy={create.isPending}
              disabled={!draft.email.includes('@') || draft.password.length < 10}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: () => {
                    setCreating(false)
                    setDraft({ email: '', name: '', role: 'operator', password: '' })
                  },
                })
              }
            >
              Добавить
            </Button>
          </>
        }
      >
        <div className={`${ui.formGrid} ${ui.formGrid2}`}>
          <Field label="Email">
            <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          <Field label="Имя">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Роль">
            <Select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Временный пароль" hint="Минимум 10 символов; передайте лично и попросите сменить">
            <Input
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </Field>
        </div>
        <FormError error={create.error} />
      </Dialog>
    </Panel>
  )
}

function IntegrationsForm({ data }: { data: SettingsResponse }) {
  const { can } = useSession()
  const owner = can('owner')
  const [d, setD] = useState({ repo: data.github.repo, workflow: data.github.workflow, token: '' })
  const save = useAction(() => api.put('/settings/github', d), {
    success: 'GitHub сохранён — деплои подтянутся в течение 2 минут',
    invalidate: [['settings']],
  })
  return (
    <Panel
      title="GitHub Actions"
      hint="Fine-grained токен только на этот репозиторий с правом Actions: read. Хранится зашифрованным, наружу — только маска."
    >
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Field label="Репозиторий">
          <Input value={d.repo} disabled={!owner} onChange={(e) => setD({ ...d, repo: e.target.value })} />
        </Field>
        <Field label="Workflow деплоя">
          <Input value={d.workflow} disabled={!owner} onChange={(e) => setD({ ...d, workflow: e.target.value })} />
        </Field>
        {owner ? (
          <Field
            label="Токен"
            wide
            hint={data.github.tokenMask ? `Сейчас: ${data.github.tokenMask}. Пусто — оставить.` : 'Не задан — деплои не отслеживаются'}
          >
            <Input type="password" autoComplete="new-password" value={d.token} onChange={(e) => setD({ ...d, token: e.target.value })} />
          </Field>
        ) : null}
      </div>
      <FormError error={save.error} />
      {owner ? (
        <div style={{ marginTop: 14 }}>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            Сохранить
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

function ProfileForm() {
  return (
    <>
      <TelegramProfile />
      <AccountForm />
    </>
  )
}

function AccountForm() {
  const { user } = useSession()
  if (user?.sso) {
    return (
      <Panel title="Вход через платформу" hint="Пароля у этой учётки нет — вход идёт через аккаунт продукта.">
        <p style={{ margin: 0, color: 'var(--lg-text-2)' }}>
          Роль в консоли задаёт платформа: суперадмин — владелец, выданный доступ — оператор. Доступ выдаёт и отзывает
          суперадмин платформы в разделе «Платформа и надёжность → Ops-консоль: доступы»; консоль сверяется с ним каждые 5 минут.
        </p>
      </Panel>
    )
  }
  return <PasswordForm />
}

function PasswordForm() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useAction(() => api.post('/auth/password', { current, next }), { success: 'Пароль изменён — войдите заново' })
  return (
    <Panel title="Смена пароля" hint="После смены все сессии завершаются, включая текущую.">
      <div className={`${ui.formGrid} ${ui.formGrid2}`}>
        <Field label="Текущий пароль">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Новый пароль" hint="Минимум 10 символов">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
      <FormError error={change.error} />
      <div style={{ marginTop: 14 }}>
        <Button
          variant="primary"
          busy={change.isPending}
          disabled={!current || next.length < 10}
          onClick={() =>
            change.mutate(undefined, {
              onSuccess: () => {
                qc.clear()
                navigate('/login')
              },
            })
          }
        >
          Сменить пароль
        </Button>
      </div>
    </Panel>
  )
}

export function SettingsPage() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const owner = can('owner')
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'onboarding', label: 'Онбординг' },
    { id: 'general', label: 'Общие' },
    ...(owner
      ? [
          { id: 'agents' as const, label: 'Агенты' },
          { id: 'users' as const, label: 'Пользователи' },
        ]
      : []),
    { id: 'maintenance', label: 'Техработы' },
    { id: 'integrations', label: 'Интеграции' },
    { id: 'profile', label: 'Профиль' },
  ]
  const raw = params.get('tab') as Tab | null
  const tab: Tab = raw && tabs.some((t) => t.id === raw) ? raw : 'general'
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/settings') })
  return (
    <>
      <PageHero
        eyebrow="Настройки"
        title="Настройки консоли"
        lead={
          owner
            ? 'Секреты (токены, ключи подписи) хранятся зашифрованными и не показываются повторно.'
            : 'Изменять настройки может владелец консоли.'
        }
      />
      <Tabs label="Раздел настроек" value={tab} onChange={(v) => setParams(v === 'general' ? {} : { tab: v })} items={tabs} />
      {q.isError ? <LoadError error={q.error} onRetry={() => void q.refetch()} /> : null}
      {tab === 'agents' ? <AgentsSettings /> : null}
      {tab === 'users' ? <UsersSettings /> : null}
      {tab === 'profile' ? <ProfileForm /> : null}
      {tab === 'maintenance' ? <MaintenancePanel /> : null}
      {tab === 'onboarding' ? <OnboardingPanel /> : null}
      {tab === 'general' ? q.data ? <GeneralForm data={q.data} /> : <Skeleton height={240} /> : null}
      {tab === 'integrations' ? (
        <>
          {owner ? <TelegramBotPanel /> : null}
          {q.data ? <IntegrationsForm data={q.data} /> : <Skeleton height={160} />}
        </>
      ) : null}
    </>
  )
}
