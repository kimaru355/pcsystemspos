import { cookies } from 'next/headers'

export const OUTLET_FILTER_COOKIE = 'pos_outlet_filter'

/** 'all' or the id of one outlet the user may see. */
export type OutletFilter = 'all' | string

/** A stored choice only counts while it is still one of the user's outlets. */
export function resolveOutletFilter(raw: string | undefined, allowedIds: readonly string[]): OutletFilter {
  return raw && allowedIds.includes(raw) ? raw : 'all'
}

/** Request-time: call inside <Suspense>. */
export async function readOutletFilter(allowedIds: readonly string[]): Promise<OutletFilter> {
  return resolveOutletFilter((await cookies()).get(OUTLET_FILTER_COOKIE)?.value, allowedIds)
}
