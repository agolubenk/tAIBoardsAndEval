/** Онбординг: чек-лист подготовки консоли — шаг готов только по факту успешной проверки. */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LinkButton } from '../../ui/Controls'
import { Icon } from '../../ui/Icon'
import { LoadError, Panel, Skeleton } from '../../ui/Glass'
import s from '../pages.module.css'

interface Step {
  id: string
  title: string
  done: boolean
  detail: string
  to: string
  required: boolean
}

/**
 * compact — на главной: только пока не пройдены обязательные шаги (проверка, агент, доставка), и
 * только они; необязательные (деплои, публичная страница) — в настройках, чтобы главная не
 * напоминала о них вечно.
 */
export function OnboardingPanel({ compact }: { compact?: boolean }) {
  const { can } = useSession()
  const q = useQuery({ queryKey: ['onboarding'], queryFn: () => api.get<{ steps: Step[] }>('/overview/onboarding'), refetchInterval: 30_000 })
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  const steps = compact ? q.data?.steps.filter((x) => x.required) : q.data?.steps
  const done = steps?.filter((x) => x.done).length ?? 0
  if (compact && steps && done === steps.length) return null
  return (
    <Panel
      title="Подготовка консоли"
      hint="Шаг засчитывается только по факту: проверка ответила, отчёт пришёл, уведомление доставлено"
      action={steps ? <span className={s.stepsCount}>{`${done} из ${steps.length}`}</span> : null}
    >
      {!steps ? (
        <Skeleton height={140} />
      ) : (
        <ul className={s.checklist}>
          {steps.map((x) => (
            <li key={x.id} className={x.done ? s.checkDone : undefined}>
              <span className={s.checkIcon} aria-hidden>
                <Icon name={x.done ? 'check' : 'clock'} size={15} />
              </span>
              <span className={s.checkBody}>
                <b>{x.title}</b>
                <span>{x.detail}</span>
              </span>
              {!x.done && can('operator') ? (
                <LinkButton to={x.to} small>
                  Настроить
                </LinkButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
