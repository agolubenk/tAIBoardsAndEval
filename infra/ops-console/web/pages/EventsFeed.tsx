/** Лента событий с фильтрами — страница «События» и вкладка «События» на странице хоста. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { ActivityDot, activityText } from '../ui/ActivityText'
import { fullDateTime } from '../lib/format'
import type { ActivityItem } from '../lib/types'
import { Button, Input, Select } from '../ui/Controls'
import { Icon } from '../ui/Icon'
import { Empty, LoadError, Panel, Skeleton } from '../ui/Glass'
import s from './pages.module.css'

export const EVENT_KINDS: Array<[ActivityItem['kind'] | '', string]> = [
  ['', 'Все типы'],
  ['alert', 'Алерты'],
  ['incident', 'Инциденты'],
  ['action', 'Действия (перезапуски, техработы)'],
  ['deploy', 'Деплои'],
  ['agent', 'Агенты'],
  ['config', 'Настройки'],
  ['report', 'Отчёты'],
  ['auth', 'Входы и доступы'],
]

export const EVENT_RANGES: Array<[string, string]> = [
  ['24', 'Последние 24 часа'],
  ['168', '7 дней'],
  ['720', '30 дней'],
  ['', 'Всё (90 дней)'],
]

interface Page {
  events: ActivityItem[]
  nextBefore: number | null
}

export interface EventFilters {
  kind: string
  hours: string
  q: string
}

export function eventsQueryString(f: EventFilters, route?: string): string {
  const p = new URLSearchParams()
  if (f.kind) p.set('kind', f.kind)
  if (f.hours) p.set('hours', f.hours)
  if (f.q.trim()) p.set('q', f.q.trim())
  if (route) p.set('route', route)
  return p.toString()
}

/** Значение с задержкой: поиск не дёргает API на каждую букву. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function EventFilterBar({ value, onChange, exportRoute }: { value: EventFilters; onChange: (f: EventFilters) => void; exportRoute?: string }) {
  return (
    <div className={s.filterBar}>
      <Input
        type="search"
        aria-label="Поиск в событиях"
        placeholder="Поиск: текст события или кто"
        value={value.q}
        onChange={(e) => onChange({ ...value, q: e.target.value })}
      />
      <Select aria-label="Тип событий" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value })}>
        {EVENT_KINDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </Select>
      <Select aria-label="Период" value={value.hours} onChange={(e) => onChange({ ...value, hours: e.target.value })}>
        {EVENT_RANGES.map(([h, label]) => (
          <option key={h} value={h}>
            {label}
          </option>
        ))}
      </Select>
      <a className={s.csvLink} href={`/api/events/activity.csv?${eventsQueryString(value, exportRoute)}`} download>
        <Icon name="download" size={16} /> Экспорт CSV
      </a>
    </div>
  )
}

export function EventsFeed({ filters, route }: { filters: EventFilters; route?: string }) {
  const debounced = useDebounced(filters)
  const qs = eventsQueryString(debounced, route)
  const q = useInfiniteQuery({
    queryKey: ['events', qs],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<Page>(`/events/activity?limit=60${qs ? `&${qs}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
  })
  const events = q.data?.pages.flatMap((p) => p.events) ?? []
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />
  return (
    <Panel>
      {!q.data ? (
        <Skeleton height={200} />
      ) : events.length === 0 ? (
        <Empty title="Событий нет" icon="list">
          {filters.q || filters.kind ? 'Под фильтры ничего не попало — ослабьте их.' : 'За выбранный период ничего не происходило.'}
        </Empty>
      ) : (
        <>
          <ul className={s.feed}>
            {events.map((e) => (
              <li key={e.id} className={s.feedItem} style={{ gridTemplateColumns: '150px minmax(0, 1fr)' }}>
                <span className={s.feedTime}>{fullDateTime(e.createdAt)}</span>
                <span>
                  <ActivityDot message={e.message} />
                  {e.route ? <Link to={e.route}>{activityText(e.message)}</Link> : activityText(e.message)}
                  {e.actor !== 'system' ? <span className={s.feedActor}> · {e.actor}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {q.hasNextPage ? (
            <div style={{ marginTop: 12 }}>
              <Button busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                Показать ещё
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  )
}
