import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from './lib/api'
import { SessionProvider, useSession } from './lib/session'
import { Shell } from './layout/Shell'
import { ToastProvider } from './ui/Toast'
import { Skeleton } from './ui/Glass'
import { LoginPage } from './pages/Login'
import { PublicStatusPage } from './pages/PublicStatus'

/**
 * Экраны под входом — отдельными чанками: публичная /status и вход не тянут код всей консоли
 * (на 3G это секунды).
 */
function screen<M>(load: () => Promise<M>, pick: (m: M) => ComponentType) {
  return lazy(() => load().then((m) => ({ default: pick(m) })))
}
const loaders = {
  overview: () => import('./pages/Overview'),
  infrastructure: () => import('./pages/Infrastructure'),
  host: () => import('./pages/Host'),
  monitoring: () => import('./pages/Monitoring'),
  alerts: () => import('./pages/Alerts'),
  incidents: () => import('./pages/Incidents'),
  incident: () => import('./pages/incidents/IncidentPage'),
  deploys: () => import('./pages/Deploys'),
  events: () => import('./pages/Events'),
  reports: () => import('./pages/Reports'),
  settings: () => import('./pages/Settings'),
}
/** Экран, на который открыта вкладка, — грузим сразу, параллельно с /me (глубокая ссылка не ждёт второй запрос). */
const ENTRY: Array<[RegExp, () => Promise<unknown>]> = [
  [/^\/$/, loaders.overview],
  [/^\/infrastructure\/[^/]+/, loaders.host],
  [/^\/infrastructure/, loaders.infrastructure],
  [/^\/monitoring/, loaders.monitoring],
  [/^\/alerts/, loaders.alerts],
  [/^\/incidents\/[^/]+/, loaders.incident],
  [/^\/incidents/, loaders.incidents],
  [/^\/deploys/, loaders.deploys],
  [/^\/events/, loaders.events],
  [/^\/reports/, loaders.reports],
  [/^\/settings/, loaders.settings],
]
if (typeof window !== 'undefined') {
  const entry = ENTRY.find(([re]) => re.test(window.location.pathname))
  if (entry) void entry[1]().catch(() => undefined)
  // Вкладка открыта до пересборки консоли: чанка прежней сборки уже нет. Одна перезагрузка за минуту
  // подтянет свежий index.html; чаще — не перезагружаем (ошибку покажет ErrorBoundary экрана).
  window.addEventListener('vite:preloadError', (event) => {
    let last = 0
    try {
      last = Number(sessionStorage.getItem('ops:chunk-reload') ?? 0)
    } catch {
      /* без sessionStorage — без автоперезагрузки */
      return
    }
    if (Date.now() - last < 60_000) return
    event.preventDefault()
    try {
      sessionStorage.setItem('ops:chunk-reload', String(Date.now()))
    } catch {
      return
    }
    window.location.reload()
  })
}
const OverviewPage = screen(loaders.overview, (m) => m.OverviewPage)
const InfrastructurePage = screen(loaders.infrastructure, (m) => m.InfrastructurePage)
const HostPage = screen(loaders.host, (m) => m.HostPage)
const MonitoringPage = screen(loaders.monitoring, (m) => m.MonitoringPage)
const AlertsPage = screen(loaders.alerts, (m) => m.AlertsPage)
const IncidentsPage = screen(loaders.incidents, (m) => m.IncidentsPage)
const IncidentPage = screen(loaders.incident, (m) => m.IncidentPage)
const DeploysPage = screen(loaders.deploys, (m) => m.DeploysPage)
const EventsPage = screen(loaders.events, (m) => m.EventsPage)
const ReportsPage = screen(loaders.reports, (m) => m.ReportsPage)
const ReportPage = screen(loaders.reports, (m) => m.ReportPage)
const SettingsPage = screen(loaders.settings, (m) => m.SettingsPage)

const queryClient: QueryClient = new QueryClient({
  // Сессию закрыли на сервере (истекла, доступ отозван в платформе) — перечитать /me:
  // RequireSession уведёт на вход, а не оставит страницу с ошибками на каждом запросе.
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (err instanceof ApiError && err.status === 401 && query.queryKey[0] !== 'me') {
        void queryClient.invalidateQueries({ queryKey: ['me'] })
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // 401/403/404 не повторяем — это ответ, а не сбой сети.
      retry: (count, err) => !(err instanceof ApiError && [401, 403, 404].includes(err.status)) && count < 2,
    },
  },
})

function RequireSession({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()
  const location = useLocation()
  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton height={48} />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  // Меню и шапка видны сразу, пока грузится чанк экрана.
  return (
    <Shell>
      <Suspense fallback={<Skeleton height={48} />}>{children}</Suspense>
    </Shell>
  )
}

const page = (el: ReactNode) => <RequireSession>{el}</RequireSession>

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/status" element={<PublicStatusPage />} />
              <Route path="/" element={page(<OverviewPage />)} />
              <Route path="/infrastructure" element={page(<InfrastructurePage />)} />
              <Route path="/infrastructure/:id" element={page(<HostPage />)} />
              <Route path="/monitoring" element={page(<MonitoringPage />)} />
              <Route path="/alerts" element={page(<AlertsPage />)} />
              <Route path="/incidents" element={page(<IncidentsPage />)} />
              <Route path="/incidents/:id" element={page(<IncidentPage />)} />
              <Route path="/deploys" element={page(<DeploysPage />)} />
              <Route path="/events" element={page(<EventsPage />)} />
              <Route path="/reports" element={page(<ReportsPage />)} />
              <Route path="/reports/:id" element={page(<ReportPage />)} />
              <Route path="/settings" element={page(<SettingsPage />)} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </SessionProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
