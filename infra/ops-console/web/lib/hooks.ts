import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { errorText } from './api'
import { useToast } from '../ui/Toast'

/** Мутация с тостом и сбросом связанных запросов. */
export function useAction<TVars, TRes = unknown>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { success?: string | ((r: TRes) => string); invalidate?: QueryKey[] } = {},
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (res) => {
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(res) : opts.success)
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })))
      await qc.invalidateQueries({ queryKey: ['counts'] })
    },
    onError: (err) => toast(errorText(err), true),
  })
}
