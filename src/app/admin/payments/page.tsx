import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { listUnmatchedForAdmin } from '@/server/services/mpesa'
import { requireTenant } from '@/server/tenant'
import { AttachForm } from './payment-forms'

const when = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

export default function PaymentsPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Payments" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <PaymentsContent />
    </Suspense>
  )
}

async function PaymentsContent() {
  const ctx = await requireTenant()
  const rows = await listUnmatchedForAdmin(db, ctx)
  return (
    <>
      <PageHeader
        title="Payments"
        description="M-Pesa payments that arrived without a matching order number. Attach each one to its order; the order's balance updates straight away."
      />
      <Region id="unmatched-heading" title="To match" aside={<span className="text-xs text-muted-foreground">{rows.length}</span>}>
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">Nothing to match. Paybill payments with a valid order number are attached automatically.</p>
        ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.id} className="grid gap-2 border-b border-rule py-3 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <p>
                    <span className="font-mono text-[0.8rem] font-medium">{r.transId}</span>{' '}
                    <span className="figures font-semibold">{formatKes(r.amountCents)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {when.format(r.transTime)} · {r.payerName ?? 'Unknown payer'} {r.msisdn ?? ''}
                    {r.billRef && <> · account “{r.billRef}”</>}
                  </p>
                </div>
                <AttachForm transactionId={r.id} guess={r.billRef ?? ''} />
              </li>
            ))}
          </ul>
        )}
      </Region>
    </>
  )
}
