import { Suspense } from 'react'
import Link from 'next/link'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { listCustomers } from '@/server/services/reports'
import { requireTenant } from '@/server/tenant'
import { inputClass } from '../_forms/styles'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
const when = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' })
const COLUMNS = 'lg:grid-cols-[minmax(0,1fr)_10rem_5rem_9rem_9rem_7rem]'

export default function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Customers" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <CustomersContent searchParams={searchParams} />
    </Suspense>
  )
}

async function CustomersContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  const q = one(params.q).trim()
  const owing = one(params.owing) === '1'
  const rows = await listCustomers(db, ctx, { search: q || undefined, owingOnly: owing })
  const totals = rows.reduce((t, r) => ({ owed: t.owed + r.owedCents, credit: t.credit + r.creditCents }), { owed: 0, credit: 0 })
  return (
    <>
      <PageHeader
        title="Customers"
        description="Everyone named on an order: what they still owe on open orders, and goods they took on credit."
      />
      <form method="get" role="search" className="flex flex-wrap items-end gap-3 pb-6">
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <label htmlFor="cust-q" className="text-sm font-medium">
            Search
          </label>
          <input id="cust-q" name="q" type="search" defaultValue={q} placeholder="Name or phone" className={inputClass} />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="owing" value="1" defaultChecked={owing} /> Owing only
        </label>
        <Button type="submit" variant="outline" size="lg">
          Filter
        </Button>
      </form>
      <Region
        id="customers-heading"
        title={q || owing ? 'Matching customers' : 'Customers'}
        aside={
          <span className="figures text-xs text-muted-foreground">
            Owed {formatKes(totals.owed)} · on credit {formatKes(totals.credit)}
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No customers yet. A customer is saved when a sale names one.</p>
        ) : (
          <>
            <div aria-hidden className={`hidden gap-x-3 border-b border-rule py-1.5 text-xs font-medium text-muted-foreground lg:grid ${COLUMNS}`}>
              <span>Name</span>
              <span>Phone</span>
              <span className="text-right">Orders</span>
              <span className="text-right">Owed</span>
              <span className="text-right">On credit</span>
              <span className="text-right">Last order</span>
            </div>
            <ul>
              {rows.map((c) => (
                <li key={c.id} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-rule py-2 text-sm ${COLUMNS}`}>
                  <Link href={`/admin/customers/${c.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  <span className="figures text-muted-foreground">{c.phone}</span>
                  <span className="figures hidden text-right lg:block">{c.orders}</span>
                  <span className={cn('figures text-right', c.owedCents > 0 ? 'text-owed-ink' : 'text-muted-foreground')}>
                    <span className="lg:hidden">Owed </span>
                    {formatKes(c.owedCents)}
                  </span>
                  <span className={cn('figures text-right', c.creditCents > 0 ? 'font-semibold text-credit' : 'text-muted-foreground')}>
                    <span className="lg:hidden">Credit </span>
                    {formatKes(c.creditCents)}
                  </span>
                  <span className="hidden text-right text-xs text-muted-foreground lg:block">{c.lastOrderAt ? when.format(c.lastOrderAt) : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Region>
    </>
  )
}
