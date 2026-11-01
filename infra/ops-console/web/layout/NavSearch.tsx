/**
 * Поиск в меню: разделы и их вкладки — сразу, объекты (серверы, контейнеры, мониторы, горящие
 * алерты, открытые инциденты) — из тех же запросов, что у страниц (общий кэш React Query).
 * «/» или Ctrl/⌘+K — к полю, ↑/↓ — по результатам, Enter — открыть, Esc — очистить.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import type { AgentSummary, Alert, Container, Incident, Monitor } from '../lib/types'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/Glass'
import { HIT_GROUPS, searchEntities, searchSections, tokenize, type SearchHit } from './navigation'
import s from './shell.module.css'

/** Объекты ищутся с двух символов: одна буква совпадает почти со всем. */
const MIN_ENTITY_QUERY = 2
const STALE_MS = 30_000

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

function useSearchData(enabled: boolean) {
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentSummary[]; containers: Container[] }>('/infra/agents'),
    enabled,
    staleTime: STALE_MS,
  })
  const monitors = useQuery({
    queryKey: ['monitors'],
    queryFn: () => api.get<{ monitors: Monitor[] }>('/monitors'),
    enabled,
    staleTime: STALE_MS,
  })
  // Ключи и адреса — как у страниц «Алерты» и «Инциденты»: результат уже в кэше, если там были.
  const alerts = useQuery({
    queryKey: ['alerts', 'active'],
    queryFn: () => api.get<{ alerts: Alert[] }>('/alerts?status=firing&days=14'),
    enabled,
    staleTime: STALE_MS,
  })
  const incidents = useQuery({
    queryKey: ['incidents', 'open'],
    queryFn: () => api.get<{ incidents: Incident[] }>('/incidents?status=open'),
    enabled,
    staleTime: STALE_MS,
  })
  const loading = enabled && [agents, monitors, alerts, incidents].some((q) => q.isLoading)
  // Упавший источник — не «ничего не найдено»: иначе существующий сервер выглядит отсутствующим.
  const failed = enabled && [agents, monitors, alerts, incidents].some((q) => q.isError)
  return {
    loading,
    failed,
    data: {
      agents: agents.data?.agents,
      containers: agents.data?.containers,
      monitors: monitors.data?.monitors,
      alerts: alerts.data?.alerts,
      incidents: incidents.data?.incidents,
    },
  }
}

export function NavSearch({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const { can } = useSession()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(0)
  const tokens = useMemo(() => tokenize(query), [query])
  const wantsEntities = tokens.join(' ').length >= MIN_ENTITY_QUERY
  const { data, loading, failed } = useSearchData(wantsEntities)

  const hits = useMemo<SearchHit[]>(() => {
    if (!tokens.length) return []
    return [...searchSections(tokens, can), ...(wantsEntities ? searchEntities(tokens, data) : [])]
  }, [tokens, can, wantsEntities, data])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
      if (combo || (e.key === '/' && !isTypingTarget(e.target))) {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = (hit: SearchHit) => {
    onQuery('')
    input.current?.blur()
    navigate(hit.to)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault()
      setActive((i) => (i + 1) % hits.length)
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault()
      setActive((i) => (i - 1 + hits.length) % hits.length)
    } else if (e.key === 'Enter') {
      const hit = hits[active]
      if (hit) {
        e.preventDefault()
        open(hit)
      }
    } else if (e.key === 'Escape') {
      if (query) onQuery('')
      else input.current?.blur()
    }
  }

  const listId = 'nav-search-results'
  const showResults = tokens.length > 0
  let index = -1

  return (
    <div className={s.search}>
      <label className={s.searchField}>
        <span className={s.searchIcon}>
          <Icon name="search" size={15} />
        </span>
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Найти раздел, сервер, контейнер…"
          aria-label="Поиск по разделам и объектам консоли"
          role="combobox"
          aria-expanded={showResults}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showResults && hits[active] ? `nav-hit-${active}` : undefined}
          className={s.searchInput}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button type="button" className={s.searchClear} onClick={() => onQuery('')} aria-label="Очистить поиск">
            <Icon name="x" size={14} />
          </button>
        ) : (
          <kbd className={s.searchKbd} aria-hidden>
            /
          </kbd>
        )}
      </label>
      {showResults ? (
        <div id={listId} role="listbox" aria-label="Результаты поиска" className={s.results}>
          {HIT_GROUPS.map((group) => {
            const items = hits.filter((h) => h.group === group)
            if (!items.length) return null
            return (
              <div key={group} role="group" aria-label={group} className={s.resultGroup}>
                <div className={s.resultGroupLabel} aria-hidden>
                  {group}
                </div>
                {items.map((hit) => {
                  index += 1
                  const i = index
                  return (
                    <Link
                      key={hit.key}
                      id={`nav-hit-${i}`}
                      role="option"
                      aria-selected={i === active}
                      to={hit.to}
                      className={cx(s.result, i === active && s.resultActive)}
                      onMouseEnter={() => setActive(i)}
                      onClick={(e) => {
                        // Ctrl/⌘/Shift/средняя кнопка — браузер открывает ссылку сам (новая вкладка/окно).
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                        e.preventDefault()
                        open(hit)
                      }}
                    >
                      <Icon name={hit.icon} size={15} />
                      <span className={s.resultText}>
                        <span className={s.resultLabel}>{hit.label}</span>
                        <span className={s.resultContext}>{hit.context}</span>
                      </span>
                    </Link>
                  )
                })}
              </div>
            )
          })}
          {!hits.length ? (
            <p className={s.resultsEmpty}>
              {loading ? 'Ищем…' : failed ? 'Не удалось загрузить объекты для поиска — повторите позже' : 'Ничего не найдено'}
            </p>
          ) : loading ? (
            <p className={s.resultsEmpty}>Ищем среди объектов…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
