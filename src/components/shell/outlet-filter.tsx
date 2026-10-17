'use client'

import { useTransition } from 'react'
import { Store } from 'lucide-react'
import { setOutletFilter } from '@/app/admin/actions'

export type OutletOption = { id: string; code: string; name: string }

/** Scopes the admin area. Owners default to every outlet; managers to their own. */
export function OutletFilter({
  outlets,
  value,
  allLabel,
}: {
  outlets: OutletOption[]
  value: string
  allLabel: string
}) {
  const [pending, start] = useTransition()
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Showing outlet</span>
      <Store aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
      <select
        value={value}
        disabled={pending || outlets.length === 0}
        aria-busy={pending}
        onChange={(e) => {
          const next = e.target.value
          start(() => setOutletFilter(next))
        }}
        className="h-9 max-w-[16rem] truncate rounded-md border border-input bg-surface pr-8 pl-8 text-sm font-medium outline-none hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
      >
        <option value="all">{allLabel}</option>
        {outlets.map((o) => (
          <option key={o.id} value={o.id}>
            {o.code} · {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}
