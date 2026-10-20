import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cn } from 'cn'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { DomainError } from '@/server/errors'
import { listOrders } from '@/server/services/orders'
import { getCustomer } from '@/server/services/reports'
import { requireTenant } from '@/server/tenant'

const when = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' })

export default function CustomerPage({ params }: PageProps<'/admin/customers/[id]'>) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Customer" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <CustomerContent params={params} />
    </Suspense>
  )
}

async function CustomerContent({ params }: { params: PageProps<'/admin/customers/[id]'>['params'] }) {
  const { id } = await params
  const ctx = await requireTenant()
  let c
  try {
    c = await getCustomer(db, ctx, id)
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'not_found' || e.code === 'forbidden')) notFound()
    throw e
  }
  const orders = await listOrders(db, ctx, { customerId: c.id, limit: 200 })
  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <>
            {c.phone} · {c.orders} {c.orders === 1 ? 'order' : 'orders'} · owes{' '}
            <span className="font-medium text-owed-ink">{formatKes(c.owedCents)}</span> on open orders
            {c.creditCents > 0 && (
              <>
                , <span className="font-medium text-credit">{formatKes(c.creditCents)}</span> for goods taken on credit
              </>
            )}
          </>
        }
        actions={
          <Link href="/admin/customers" className="text-sm text-primary underline-offset-4 hover:underline">
            All customers
          </Link>
        }
      />
      <Region id="orders-heading" title="Orders">
        <ul>
          {orders.map((o) => (
            <li key={o.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule py-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_8rem_8rem]">
              <Link href={`/admin/orders/${o.id}`} className="font-mono text-[0.8rem] font-medium text-primary underline-offset-4 hover:underline">
                {o.number}
              </Link>
              <span className="text-xs text-muted-foreground sm:text-sm">{when.format(o.occurredAt)}</span>
              <span className="figures text-right font-semibold">{formatKes(o.figures.totalCents)}</span>
              <span className={cn('figures text-right', o.figures.balanceCents > 0 ? 'text-owed-ink' : 'text-muted-foreground')}>
                {o.status === 'open' ? `${formatKes(Math.max(0, o.figures.balanceCents))} owed` : 'Closed'}
              </span>
            </li>
          ))}
        </ul>
      </Region>
    </>
  )
}
