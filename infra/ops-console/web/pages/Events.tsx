import { useSearchParams } from 'react-router-dom'
import { PageHero } from '../ui/Glass'
import { EventFilterBar, EventsFeed, type EventFilters } from './EventsFeed'

export function EventsPage() {
  const [params, setParams] = useSearchParams()
  const filters: EventFilters = { kind: params.get('kind') ?? '', hours: params.get('hours') ?? '24', q: params.get('q') ?? '' }
  const set = (f: EventFilters) => {
    const next: Record<string, string> = {}
    if (f.kind) next.kind = f.kind
    if (f.hours !== '24') next.hours = f.hours
    if (f.q) next.q = f.q
    setParams(next, { replace: true })
  }
  return (
    <>
      <PageHero
        eyebrow="События"
        title="Лента событий"
        lead="Единая проверяемая хронология: алерты и восстановления, инциденты, перезапуски с причинами, техработы, деплои, изменения настроек и входы. Хранится 90 дней."
      />
      <EventFilterBar value={filters} onChange={set} />
      <EventsFeed filters={filters} />
    </>
  )
}
