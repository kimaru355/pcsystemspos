import { Suspense } from 'react'
import Link from 'next/link'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { readOutletFilter } from '@/server/outlet-filter'
import { listOrders } from '@/server/services/orders'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'
import { inputClass } from '../_forms/styles'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

const when = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

const COLUMNS = 'xl:grid-cols-[10rem_minmax(0,1fr)_8rem_8rem_8rem_9rem]'

export default function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Orders" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <OrdersContent searchParams={searchParams} />
    </Suspense>
  )
}

async function OrdersContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  const outlets = (await listOutlets(db, ctx)).filter((o) => o.active)
  const filter = await readOutletFilter(outlets.map((o) => o.id))
  const q = one(params.q).trim()
  const status = one(params.status)
  const flagged = one(params.flagged) === '1'
  const rows = await listOrders(db, ctx, {
    outletId: filter === 'all' ? undefined : filter,
    status: status === 'open' || status === 'closed' ? status : undefined,
    search: q || undefined,
    flaggedOnly: flagged,
    limit: 200,
  })
  const filtered = q !== '' || status !== '' || flagged

  return (
    <>
      <PageHeader title="Orders" description="Every sale from the tills: what is paid, what is collected, and what is still owed." />
      <form method="get" role="search" className="grid gap-3 pb-6 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_12rem_auto_auto] xl:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="orders-q" className="text-sm font-medium">
            Search
          </label>
          <input id="orders-q" name="q" type="search" defaultValue={q} placeholder="Order number, customer name or phone" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="orders-status" className="text-sm font-medium">
            Status
          </label>
          <select id="orders-status" name="status" defaultValue={status} className={inputClass}>
            <option value="">Open and closed</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm xl:h-9">
          <input type="checkbox" name="flagged" value="1" defaultChecked={flagged} />
          Flagged only
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="lg">
            Filter
          </Button>
          {filtered && (
            <Link href="/admin/orders" className="text-sm text-primary underline-offset-4 hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      <Region id="orders-heading" title={filtered ? 'Matching orders' : 'Latest orders'} aside={<span className="text-xs text-muted-foreground">{rows.length}</span>}>
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {filtered ? 'No orders match.' : 'No orders yet. Sales made on the tills appear here once they sync.'}
          </p>
        ) : (
          <>
            <div aria-hidden className={`hidden gap-x-3 border-b border-rule py-1.5 text-xs font-medium text-muted-foreground xl:grid ${COLUMNS}`}>
              <span>Order</span>
              <span>Customer</span>
              <span className="text-right">Total</span>
              <span className="text-right">Paid</span>
              <span className="text-right">Owed</span>
              <span>Status</span>
            </div>
            <ul>
              {rows.map((o) => (
                <li key={o.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-sm ${COLUMNS}`}>
                  <span>
                    <Link href={`/admin/orders/${o.id}`} className="font-mono text-[0.8rem] font-medium text-primary underline-offset-4 hover:underline">
                      {o.number}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{when.format(o.occurredAt)}</span>
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground xl:text-foreground">
                    {o.customer ? `${o.customer.name} · ${o.customer.phone}` : 'Walk-in'}
                  </span>
                  <span className="figures text-right font-semibold">{formatKes(o.figures.totalCents)}</span>
                  <span className="figures hidden text-right xl:block">{formatKes(o.figures.paidCents)}</span>
                  <span className={cn('figures text-right', o.figures.balanceCents > 0 ? 'text-owed-ink' : 'text-muted-foreground')}>
                    <span className="xl:hidden">Owed </span>
                    {formatKes(Math.max(0, o.figures.balanceCents))}
                  </span>
                  <span className="text-xs">
                    {o.status === 'open' ? (o.figures.goodsOutstanding ? 'Open · to collect' : 'Open') : o.cancelled ? 'Closed · cancelled' : 'Closed'}
                    {o.figures.creditInUseCents > 0 && <span className="text-credit"> · credit</span>}
                    {o.flagged && <span className="font-medium text-credit"> · flagged</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Region>
    </>
  )
}
