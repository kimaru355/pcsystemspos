'use server'

import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { listOutlets } from '@/server/services/outlets'
import { OUTLET_FILTER_COOKIE, resolveOutletFilter } from '@/server/outlet-filter'
import { requireTenant } from '@/server/tenant'

/** Narrows every admin screen to one outlet, or back to all of the user's outlets. */
export async function setOutletFilter(outletId: string): Promise<void> {
  const ctx = await requireTenant()
  const allowed = (await listOutlets(db, ctx)).map((o) => o.id)
  const value = resolveOutletFilter(outletId, allowed)
  const jar = await cookies()
  if (value === 'all') jar.delete(OUTLET_FILTER_COOKIE)
  else
    jar.set(OUTLET_FILTER_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })
}
