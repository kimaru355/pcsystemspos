import { isUuid } from '@/domain/ids'
import type { Outlet } from '@/server/services/outlets'

/**
 * The outlet a stock page shows: the `outlet` param when it is one of the (active) outlets in
 * scope, otherwise the first of them. A missing, malformed or out-of-scope value never errors.
 */
export function pickOutlet(active: Outlet[], raw: string): Outlet | null {
  if (isUuid(raw)) {
    const hit = active.find((o) => o.id === raw)
    if (hit) return hit
  }
  return active[0] ?? null
}

export function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ''
}
