import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cn } from 'cn'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { SettlementBar } from '@/components/shell/settlement-bar'
import { ConfirmationThread, type Confirmation } from '@/components/shell/confirmation-line'
import { db } from '@/db/client'
import { formatKes, formatQty, lineGross } from '@/domain/money'
import type { OrderEvent } from '@/domain/order-state'
import { outstandingMilli } from '@/domain/orders'
import { can } from '@/domain/permissions'
import { unitLabel } from '@/domain/units'
import { DomainError } from '@/server/errors'
import { getOrder } from '@/server/services/orders'
import { requireTenant } from '@/server/tenant'
import { CancelRemainderForm, RefundForm } from '../order-forms'

const METHOD: Record<string, string> = { cash: 'cash', mark_paid: 'marked paid', mpesa: 'M-Pesa', other: 'other' }

function eventLine(number: string, e: OrderEvent): Confirmation {
  const base = { code: number, by: e.by, at: new Date(e.at) }
  switch (e.kind) {
    case 'created':
      return { ...base, status: 'Created', tone: 'neutral' }
    case 'payment':
      return {
        ...base,
        status: e.method === 'mark_paid' ? 'Marked paid' : 'Paid',
        tone: 'paid',
        detail: `${formatKes(e.amountCents ?? 0)}${e.method === 'cash' ? ' cash' : ''}.${e.detail ? ` ${e.detail}.` : ''}`,
      }
    case 'refund':
      return { ...base, status: 'Refunded', tone: 'owed', detail: `${formatKes(e.amountCents ?? 0)} by ${METHOD[e.method ?? 'other']}. ${e.detail ?? ''}` }
    case 'collection':
      return {
        ...base,
        status: 'Collected',
        tone: (e.creditGrantedCents ?? 0) > 0 ? 'credit' : 'neutral',
        detail: `Goods worth ${formatKes(e.amountCents ?? 0)}.${(e.creditGrantedCents ?? 0) > 0 ? ` ${formatKes(e.creditGrantedCents!)} on credit.` : ''}`,
      }
    case 'cancelled':
      return { ...base, status: 'Remainder cancelled', tone: 'owed', detail: e.detail }
  }
}

export default function OrderPage({ params }: PageProps<'/admin/orders/[id]'>) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Order" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <OrderContent params={params} />
    </Suspense>
  )
}

async function OrderContent({ params }: { params: PageProps<'/admin/orders/[id]'>['params'] }) {
  const { id } = await params
  const ctx = await requireTenant()
  let d
  try {
    d = await getOrder(db, ctx, id)
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'not_found' || e.code === 'forbidden')) notFound()
    throw e
  }
  const { state: o, figures: f } = d
  const canCancel = can(ctx.role, 'order.cancel')
  return (
    <>
      <PageHeader
        title={o.number}
        description={
          <>
            {d.outletCode} · {d.outletName} · {o.customer ? `${o.customer.name} · ${o.customer.phone}` : 'Walk-in'} ·{' '}
            {o.status === 'open' ? 'Open' : 'Closed'}
            {o.flagged && <span className="font-medium text-credit"> · Flagged: goods went out beyond what was paid and approved</span>}
          </>
        }
        actions={
          <Link href="/admin/orders" className="text-sm text-primary underline-offset-4 hover:underline">
            All orders
          </Link>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-8">
          <Region id="lines-heading" title="Lines">
            <ul>
              {o.lines.map((l) => (
                <li key={l.lineId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-rule py-2 text-sm">
                  <span className="font-medium">{l.name}</span>
                  <span className="figures text-right font-semibold">{formatKes(lineGross(l.qtyMilli - l.cancelledMilli, l.unitPriceCents))}</span>
                  <span className="figures text-xs text-muted-foreground">
                    {formatQty(l.qtyMilli)} {unitLabel(l.qtyMilli, l.unitLabel)} at {formatKes(l.unitPriceCents)}
                    {l.unitPriceCents < l.listPriceCents && ` (list ${formatKes(l.listPriceCents)})`}
                    {l.cancelledMilli > 0 && ` · ${formatQty(l.cancelledMilli)} cancelled`}
                  </span>
                  <span className={cn('figures text-right text-xs', outstandingMilli(l) > 0 ? 'text-owed-ink' : 'text-muted-foreground')}>
                    {formatQty(l.collectedMilli)} of {formatQty(l.qtyMilli - l.cancelledMilli)} collected
                  </span>
                </li>
              ))}
            </ul>
          </Region>
          <Region id="history-heading" title="History">
            <ConfirmationThread label="Order history" items={o.events.map((e) => eventLine(o.number, e))} />
          </Region>
        </div>
        <div className="flex flex-col gap-8">
          <Region id="money-heading" title="Money and goods" size="sm">
            <SettlementBar total={f.totalCents} paid={f.paidCents} collected={f.collectedValueCents} className="py-2" />
            <dl className="figures grid grid-cols-[1fr_auto] gap-y-1 pt-2 text-sm">
              <dt className="text-muted-foreground">Total (VAT {formatKes(f.vatCents)})</dt>
              <dd className="text-right font-semibold">{formatKes(f.totalCents)}</dd>
              <dt className="text-muted-foreground">Paid</dt>
              <dd className="text-right">{formatKes(f.paidCents)}</dd>
              <dt className="text-muted-foreground">{f.balanceCents >= 0 ? 'Owed' : 'Paid beyond total'}</dt>
              <dd className={cn('text-right', f.balanceCents > 0 && 'text-owed-ink')}>{formatKes(Math.abs(f.balanceCents))}</dd>
              {o.creditCents > 0 && (
                <>
                  <dt className="text-muted-foreground">Credit approved</dt>
                  <dd className="text-right text-credit">{formatKes(o.creditCents)}</dd>
                </>
              )}
            </dl>
          </Region>
          {canCancel && f.goodsOutstanding && (
            <Region id="cancel-heading" title="Cancel what is left" size="sm">
              <p className="pb-2 text-sm text-muted-foreground">
                Goods not yet collected are cancelled and freed up. The money side is a separate refund.
              </p>
              <CancelRemainderForm orderId={o.id} />
            </Region>
          )}
          {canCancel && d.refundableCents > 0 && (
            <Region id="refund-heading" title="Refund" size="sm">
              <p className="pb-2 text-sm text-muted-foreground">
                Record money given back to the customer. The money itself moves outside the system.
              </p>
              <RefundForm orderId={o.id} max={formatKes(d.refundableCents)} />
            </Region>
          )}
          {d.cancelledAt && d.cancelReason && (
            <p className="text-sm text-muted-foreground">Cancelled: {d.cancelReason}</p>
          )}
        </div>
      </div>
    </>
  )
}
