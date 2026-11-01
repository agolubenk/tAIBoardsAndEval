import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { Logo } from '../layout/Shell'
import { Button, Field, FormError, Input } from '../ui/Controls'
import { Panel } from '../ui/Glass'
import { safeLoginNext } from '../../shared/login-next'
import s from './pages.module.css'

/** Причины отказа из /api/auth/sso/callback (?sso=<reason>). */
const SSO_ERRORS: Record<string, string> = {
  off: 'Вход через платформу не настроен в этой консоли.',
  state: 'Сессия входа истекла или открыта в другой вкладке — нажмите «Войти через платформу» ещё раз.',
  denied: 'Доступ к консоли не выдан. Его выдаёт суперадмин платформы: «Платформа и надёжность → Ops-консоль: доступы».',
  conflict:
    'Email аккаунта платформы уже занят локальной учёткой консоли. Владелец консоли может сменить ей email (Настройки → Пользователи) или вы — свой email в профиле продукта.',
  throttled: 'Слишком много неудачных попыток входа через платформу с этого адреса. Подождите 15 минут.',
  disabled: 'Учётка заблокирована в консоли (Настройки → Пользователи).',
  exchange: 'Продукт не ответил. Попробуйте позже или войдите локальной учёткой.',
}

export function LoginPage() {
  const { user, needsBootstrap, ssoEnabled, refresh } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const ssoReason = params.get('sso')
  // ?next=/queue — туда и вернуть после входа. /queue рисует сервер, поэтому переход — полной загрузкой.
  const next = safeLoginNext(params.get('next'))
  const ssoError = ssoReason ? (SSO_ERRORS[ssoReason] ?? 'Вход через платформу не удался.') : null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [ssoBusy, setSsoBusy] = useState(false)
  useEffect(() => {
    if (user && next) window.location.replace(next)
  }, [user, next])
  if (user) return next ? null : <Navigate to="/" replace />

  const startSso = async () => {
    setSsoBusy(true)
    setError(null)
    try {
      const path = next ? `/auth/sso/start?next=${encodeURIComponent(next)}` : '/auth/sso/start'
      const { redirectUrl } = await api.post<{ redirectUrl: string }>(path, {})
      window.location.assign(redirectUrl)
    } catch (err) {
      setError(err)
      setSsoBusy(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/login', { email, password })
      await refresh()
      // С ?next= уводит эффект выше, как только сессия появится.
      if (!next) navigate('/')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={s.login}>
      <form className={s.loginCard} onSubmit={(e) => void submit(e)}>
        <div className={s.loginBrand}>
          <Logo size={36} />
          HR Helper Ops
        </div>
        <Panel
          title="Вход в консоль"
          hint={
            ssoEnabled
              ? 'Админы платформы входят своим аккаунтом продукта. Локальная учётка — запасной вход, если продукт недоступен.'
              : 'Отдельная администрация: учётки консоли не связаны с продуктом.'
          }
        >
          <div className={s.loginCard}>
            {needsBootstrap ? (
              <div className={s.secretBox}>
                Пользователей ещё нет. Задайте <code>OPS_ADMIN_EMAIL</code> и <code>OPS_ADMIN_PASSWORD</code> в окружении консоли и
                перезапустите её — создастся владелец.
              </div>
            ) : null}
            {ssoError ? (
              <div className={s.secretBox} role="alert">
                {ssoError}
              </div>
            ) : null}
            {ssoEnabled ? (
              <>
                <Button type="button" variant="primary" busy={ssoBusy} disabled={busy} onClick={() => void startSso()}>
                  Войти через платформу
                </Button>
                <div className={s.loginOr}>или локальной учёткой</div>
              </>
            ) : null}
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Пароль">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <FormError error={error} />
            <Button type="submit" variant={ssoEnabled ? 'glass' : 'primary'} busy={busy} disabled={ssoBusy}>
              Войти
            </Button>
          </div>
        </Panel>
        <p className={s.loginNote}>После 5 неудачных попыток вход по этой учётке блокируется на 15 минут.</p>
      </form>
    </div>
  )
}
