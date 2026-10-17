import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes, formatQty } from '@/domain/money'
import { ADJUST_REASON_LABELS } from '@/domain/stock'
import { DomainError } from '@/server/errors'
import { getItem, type Item } from '@/server/services/items'
import { listOutlets } from '@/server/services/outlets'
import { itemHistory, itemStockByOutlet, type Movement } from '@/server/services/stock'
import { requireTenant } from '@/server/tenant'
import { one, pickOutlet } from '../outlet-param'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

const LIMIT = 100
const COLUMNS = 'xl:grid-cols-[9.5rem_6rem_7rem_9rem_minmax(0,1fr)_7rem]'

const when = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

const KIND_LABELS: Record<Movement['kind'], string> = {
  receive: 'Received',
  adjust: 'Adjusted',
  collect: 'Collected',
}

export default function StockHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>
  searchParams: SearchParams
}) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Stock history" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <HistoryContent params={params} searchParams={searchParams} />
    </Suspense>
  )
}

function detail(m: Movement): string {
  const parts: string[] = []
  if (m.reason) parts.push(ADJUST_REASON_LABELS[m.reason])
  if (m.note) parts.push(m.note)
  return parts.join(' · ')
}

async function HistoryContent({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>
  searchParams: SearchParams
}) {
  const [{ itemId }, query] = await Promise.all([params, searchParams])
  const ctx = await requireTenant()
  const active = (await listOutlets(db, ctx)).filter((o) => o.active)
  const outlet = pickOutlet(active, one(query.outlet))

  let item: Item
  try {
    item = await getItem(db, ctx, itemId)
  } catch (e) {
    if (e instanceof DomainError && e.code === 'not_found') notFound()
    throw e
  }

  if (!outlet) {
    return (
      <>
        <PageHeader title={item.name} actions={<BackLink />} />
        <p className="py-3 text-sm text-muted-foreground">
          There is no outlet in your scope to show stock for.
        </p>
      </>
    )
  }

  const [movements, byOutlet] = await Promise.all([
    itemHistory(db, ctx, outlet.id, item.id, LIMIT),
    itemStockByOutlet(db, ctx, item.id),
  ])
  const here = byOutlet.find((r) => r.outletId === outlet.id)

  return (
    <>
      <PageHeader
        title={item.name}
        description={
          <>
            {item.sku && <span className="font-mono">{item.sku} · </span>}
            Stock history at <span className="font-medium text-foreground">{outlet.code} · {outlet.name}</span>
            {here && (
              <>
                . On hand now{' '}
                <span className="figures font-medium text-foreground">
                  {formatQty(here.onHandMilli)} {item.baseUnit}
                </span>
                {here.negative ? ' (negative)' : here.isLow ? ' (low)' : ''}.
              </>
            )}
          </>
        }
        actions={<BackLink outletId={outlet.id} />}
      />

      {active.length > 1 && (
        <nav aria-label="Outlet" className="flex flex-wrap gap-x-4 gap-y-1 pb-6 text-sm">
          {active.map((o) =>
            o.id === outlet.id ? (
              <span key={o.id} aria-current="page" className="font-mono text-[0.8rem] font-semibold">
                {o.code}
              </span>
            ) : (
              <Link
                key={o.id}
                href={`/admin/stock/${item.id}?outlet=${o.id}`}
                className="font-mono text-[0.8rem] text-primary underline-offset-4 hover:underline"
              >
                {o.code}
              </Link>
            ),
          )}
        </nav>
      )}

      <Region
        id="history-heading"
        title="Movements"
        aside={
          <span className="text-xs text-muted-foreground">
            {movements.length === LIMIT ? `Latest ${LIMIT}, newest first` : 'Newest first'}
          </span>
        }
      >
        {movements.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">No stock movements at this outlet yet.</p>
        ) : (
          <>
            <div
              aria-hidden
              className={`hidden items-baseline gap-x-3 border-b border-rule py-1.5 text-xs font-medium text-muted-foreground xl:grid ${COLUMNS}`}
            >
              <span>When</span>
              <span>Kind</span>
              <span className="text-right">Quantity</span>
              <span>By</span>
              <span>Reason or note</span>
              <span className="text-right">Unit cost</span>
            </div>
            <ul>
              {movements.map((m) => {
                const qty = `${m.qtyMilli > 0 ? '+' : ''}${formatQty(m.qtyMilli)}`
                const extra = detail(m)
                return (
                  <li
                    key={m.id}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-rule py-2 text-sm xl:min-h-9 ${COLUMNS}`}
                  >
                    <span className="figures text-xs text-muted-foreground xl:text-sm xl:text-foreground">
                      <time dateTime={m.occurredAt.toISOString()}>{when.format(m.occurredAt)}</time>
                    </span>
                    <span className="hidden font-medium xl:block">{KIND_LABELS[m.kind]}</span>
                    <span className="figures text-right font-semibold">
                      {qty} <span className="font-normal text-muted-foreground">{item.baseUnit}</span>
                    </span>
                    <span className="col-span-2 text-xs text-muted-foreground xl:hidden">
                      {[KIND_LABELS[m.kind], `By ${m.actorName}`, extra, m.unitCostCents !== null ? `at ${formatKes(m.unitCostCents)} each` : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="hidden xl:block">{m.actorName}</span>
                    <span className="hidden break-words xl:block">{extra}</span>
                    <span className="figures hidden text-right xl:block">
                      {m.unitCostCents !== null ? formatKes(m.unitCostCents) : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Region>
    </>
  )
}

function BackLink({ outletId }: { outletId?: string }) {
  return (
    <Link
      href={outletId ? `/admin/stock?outlet=${outletId}` : '/admin/stock'}
      className="text-sm text-primary underline-offset-4 hover:underline"
    >
      Back to stock
    </Link>
  )
}
