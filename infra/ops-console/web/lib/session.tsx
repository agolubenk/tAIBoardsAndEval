import { createContext, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { Role, SessionUser } from './types'

interface MeResponse {
  user: SessionUser | null
  needsBootstrap: boolean
  /** В консоли настроен вход через платформу (SSO). */
  ssoEnabled: boolean
}

interface SessionValue {
  user: SessionUser | null
  needsBootstrap: boolean
  ssoEnabled: boolean
  loading: boolean
  refresh: () => Promise<void>
  can: (min: Role) => boolean
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<MeResponse>('/auth/me'), staleTime: 60_000 })
  const user = me.data?.user ?? null
  const value: SessionValue = {
    user,
    needsBootstrap: me.data?.needsBootstrap ?? false,
    ssoEnabled: me.data?.ssoEnabled ?? false,
    loading: me.isLoading,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] })
    },
    can: (min) => Boolean(user && RANK[user.role] >= RANK[min]),
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext)
  if (!v) throw new Error('useSession вне SessionProvider')
  return v
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Владелец', operator: 'Оператор', viewer: 'Наблюдатель' }
