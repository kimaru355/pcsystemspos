import { Suspense } from 'react'
import Link from 'next/link'
import { ChevronRight, Circle, CircleCheck } from 'lucide-react'
import { cn } from 'cn'
import { db } from '@/db/client'
import { formatKes } from '@/domain/money'
import { can } from '@/domain/permissions'
import { ConfirmationThread, type Confirmation } from '@/components/shell/confirmation-line'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { SettlementBar } from '@/components/shell/settlement-bar'
import { readOutletFilter } from '@/server/outlet-filter'
import { listRecentActivity } from '@/server/services/activity'
import { listDevices } from '@/server/services/devices'
import { hasActiveItems } from '@/server/services/items'
import { attentionCounts, moneyOwed, paymentsByMethod, salesSummary } from '@/server/services/reports'
import { listOutlets } from '@/server/services/outlets'
import { listStaff } from '@/server/services/staff'
import { lowStockCounts } from '@/server/services/stock'
import { requireTenant } from '@/server/tenant'
import { toConfirmation } from './activity-lines'

export default function AdminOverviewPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Overview" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <OverviewContent />
    </Suspense>
  )
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' })

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', mark_paid: 'Marked paid', other: 'Other' }

/** From midnight in Nairobi until a day from now. */
function todayInNairobi(): { from: Date; to: Date } {
  const now = new Date()
  return { from: startOfNairobiDay(now), to: new Date(now.getTime() + 24 * 60 * 60 * 1000) }
}

/** Midnight in Nairobi (UTC+3 all year) of the day `now` falls on. */
function startOfNairobiDay(now: Date): Date {
  const [y, m, d] = dayKey.format(now).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) - 3 * 60 * 60 * 1000)
}
const dayLabel = new Intl.DateTimeFormat('en-KE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Africa/Nairobi',
})

async function OverviewContent() {
  const ctx = await requireTenant()
  const isOwner = can(ctx.role, 'business.settings')
  const [outlets, staff, lowStock] = await Promise.all([
    listOutlets(db, ctx),
    listStaff(db, ctx),
    lowStockCounts(db, ctx),
  ])
  const activity = await listRecentActivity(db, ctx, {
    outletIds: outlets.map((o) => o.id),
    membershipIds: staff.map((s) => s.membershipId),
  })
  const active = outlets.filter((o) => o.active)
  const filter = await readOutletFilter(active.map((o) => o.id))
  const scoped = filter === 'all' ? null : active.find((o) => o.id === filter)
  const todayRange = todayInNairobi()
  const scope = { outletId: scoped?.id ?? null }
  const [sales, devices, hasItems, owed, methods, attention] = await Promise.all([
    salesSummary(db, ctx, todayRange, scope),
    listDevices(db, ctx),
    hasActiveItems(db, ctx),
    moneyOwed(db, ctx, scope),
    paymentsByMethod(db, ctx, todayRange, scope),
    attentionCounts(db, ctx, scope),
  ])
  const tillsToCheck = devices.filter(
    (d) => !d.revokedAt && (d.pastReminder || d.clockJumps > 0) && (!scoped || d.outletId === scoped.id),
  )

  const lowRows = lowStock
    .filter((l) => !scoped || l.outletId === scoped.id)
    .flatMap((l) => {
      const o = active.find((a) => a.id === l.outletId)
      return o ? [{ ...o, count: l.count }] : []
    })

  const names = {
    outlets: new Map(outlets.map((o) => [o.id, { code: o.code, name: o.name }])),
    staff: new Map(staff.map((s) => [s.membershipId, s.name])),
  }
  const today = dayKey.format(new Date())
  const days: { key: string; label: string; lines: Confirmation[] }[] = []
  for (const e of activity) {
    const key = dayKey.format(e.at)
    let day = days.at(-1)
    if (!day || day.key !== key) {
      day = { key, label: key === today ? 'Today' : dayLabel.format(e.at), lines: [] }
      days.push(day)
    }
    day.lines.push(toConfirmation(e, names))
  }

  const team = staff.filter((s) => s.active && s.membershipId !== ctx.membershipId)
  const tillStaff = team.filter((s) => s.role !== 'owner')
  const withPin = tillStaff.filter((s) => s.hasPin).length
  const steps = [
    {
      done: active.length > 0,
      label: 'Open an outlet',
      detail: active.length > 0 ? `${active.length} open` : 'Each shop gets a short code',
      href: '/admin/outlets',
    },
    {
      done: tillStaff.length > 0,
      label: 'Add till staff',
      detail: tillStaff.length > 0 ? `${tillStaff.length} on the team` : 'Cashiers and managers',
      href: '/admin/staff',
    },
    {
      done: tillStaff.length > 0 && withPin === tillStaff.length,
      label: 'Set till PINs',
      detail: tillStaff.length > 0 ? `${withPin} of ${tillStaff.length} set` : 'After adding staff',
      href: '/admin/staff',
    },
    {
      done: hasItems,
      label: 'Add items and prices',
      detail: hasItems ? 'Items are in the catalog' : 'Add or import your items',
      href: '/admin/items',
    },
    {
      done: devices.some((d) => !d.revokedAt),
      label: 'Set up a till',
      detail: 'Open the till on the selling device',
      href: '/till',
    },
  ]
  const remaining = steps.filter((s) => !s.done).length

  const scopeLabel = scoped
    ? `${scoped.code} · ${scoped.name}`
    : ctx.outletScope === 'all'
      ? 'All outlets'
      : 'All your outlets'

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            Showing <span className="font-medium text-foreground">{scopeLabel}</span>. Change it from the
            outlet menu at the top.
          </>
        }
      />

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Region
          id="activity-heading"
          title="Activity"
          aside={<span className="text-xs text-muted-foreground">Who did what, latest first</span>}
        >
          {days.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              Nothing yet. Every change to outlets, staff and PINs is confirmed here with who did it, and
              sales, payments and collections will join it.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {days.map((d) => (
                <div key={d.key}>
                  <h3 className="border-b border-rule pb-1.5 text-xs font-medium text-muted-foreground">{d.label}</h3>
                  <ConfirmationThread items={d.lines} label={`Activity, ${d.label}`} />
                </div>
              ))}
            </div>
          )}
        </Region>

        <div className="flex flex-col gap-10">
          <Region
            id="money-heading"
            title="Money and goods today"
            aside={
              <Link href="/admin/orders" className="text-xs text-primary underline-offset-4 hover:underline">
                All orders
              </Link>
            }
          >
            <SettlementBar total={sales.totalCents} paid={sales.paidCents} collected={sales.collectedValueCents} />
            {sales.orders === 0 ? (
              <p className="text-sm text-foreground">No sales yet today.</p>
            ) : (
              <p className="figures mt-2 text-sm text-foreground">
                {sales.orders} {sales.orders === 1 ? 'order' : 'orders'} worth {formatKes(sales.totalCents)}
                {sales.owedCents > 0 && <span className="text-owed-ink">, {formatKes(sales.owedCents)} still owed</span>}.
              </p>
            )}
            {methods.length > 0 && (
              <ul className="figures mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {methods.map((m) => (
                  <li key={`${m.kind}-${m.method}`}>
                    <span className="text-muted-foreground">{m.kind === 'refund' ? 'Refunds ' : ''}{METHOD_LABELS[m.method] ?? m.method} </span>
                    <span className="font-semibold">{formatKes(m.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Orders taken today across {scoped ? scoped.name : 'your outlets'}, once the tills have synced.
            </p>
          </Region>

          <Region
            id="owed-heading"
            title="Owed to the shop"
            size="sm"
            aside={
              <Link href="/admin/customers" className="text-xs text-primary underline-offset-4 hover:underline">
                Customers
              </Link>
            }
          >
            <dl className="figures grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                On {owed.openOrders} open {owed.openOrders === 1 ? 'order' : 'orders'}
              </dt>
              <dd className={cn('text-right font-semibold', owed.owedCents > 0 && 'text-owed-ink')}>{formatKes(owed.owedCents)}</dd>
              <dt className="text-muted-foreground">Goods taken on credit</dt>
              <dd className={cn('text-right font-semibold', owed.creditCents > 0 && 'text-credit')}>{formatKes(owed.creditCents)}</dd>
            </dl>
          </Region>

          {(attention.unmatched > 0 || attention.negative > 0) && (
            <Region id="attention-heading" title="Needs attention" size="sm">
              <ul className="divide-y divide-rule text-sm">
                {attention.unmatched > 0 && (
                  <li>
                    <Link href="/admin/payments" className="-mx-2 flex items-baseline gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                      <span className="min-w-0 flex-1">M-Pesa payments to match</span>
                      <span className="figures font-semibold text-owed-ink">{attention.unmatched}</span>
                    </Link>
                  </li>
                )}
                {attention.negative > 0 && (
                  <li>
                    <Link href="/admin/stock?negative=1" className="-mx-2 flex items-baseline gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                      <span className="min-w-0 flex-1">Items below zero stock</span>
                      <span className="figures font-semibold text-credit">{attention.negative}</span>
                    </Link>
                  </li>
                )}
              </ul>
            </Region>
          )}

          {tillsToCheck.length > 0 && (
            <Region
              id="tills-heading"
              title="Tills to check"
              size="sm"
              aside={
                <Link href="/admin/devices" className="text-xs text-primary underline-offset-4 hover:underline">
                  All tills
                </Link>
              }
            >
              <ul className="divide-y divide-rule">
                {tillsToCheck.map((d) => (
                  <li key={d.id} className="flex items-baseline gap-3 py-1.5 text-sm">
                    <span className="font-mono text-[0.8rem] font-medium">
                      {d.outletCode}-{d.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <span className="text-xs font-medium text-owed-ink">
                      {d.pastReminder ? 'Not synced for a while' : 'Clock changed'}
                    </span>
                  </li>
                ))}
              </ul>
            </Region>
          )}

          <Region
            id="low-stock-heading"
            title="Low stock"
            size="sm"
            aside={
              <Link href="/admin/stock" className="text-xs text-primary underline-offset-4 hover:underline">
                All stock
              </Link>
            }
          >
            {lowRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is running low.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {lowRows.map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`/admin/stock?outlet=${o.id}&low=1`}
                      className="-mx-2 flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="w-14 font-mono text-[0.8rem] font-medium">{o.code}</span>
                      <span className="min-w-0 flex-1 truncate">{o.name}</span>
                      <span className="figures font-semibold text-owed-ink">
                        {o.count} low
                      </span>
                      <ChevronRight aria-hidden className="size-4 self-center text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Region>

          {isOwner && (
            <Region
              id="setup-heading"
              title="Getting ready to sell"
              size="sm"
              aside={
                <span className="text-xs text-muted-foreground">
                  {remaining === 0 ? 'All done' : `${remaining} to go`}
                </span>
              }
            >
              <ol className="flex flex-col">
                {steps.map((s) => {
                  const Icon = s.done ? CircleCheck : Circle
                  const body = (
                    <>
                      <Icon
                        aria-hidden
                        className={cn('size-4 shrink-0', s.done ? 'text-foreground' : 'text-input')}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn('text-sm', s.done ? 'text-muted-foreground' : 'font-medium')}>
                          {s.label}
                          <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">{s.detail}</span>
                      </span>
                    </>
                  )
                  return (
                    <li key={s.label}>
                      {s.href ? (
                        <Link
                          href={s.href}
                          className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                        </Link>
                      ) : (
                        <div className="-mx-2 flex items-center gap-3 px-2 py-1.5">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </Region>
          )}

          <Region id="outlets-heading" title={ctx.outletScope === 'all' ? 'Outlets' : 'Your outlets'} size="sm">
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isOwner ? 'No outlets yet.' : 'You are not assigned to an outlet yet. Ask the owner.'}
              </p>
            ) : (
              <ul className="divide-y divide-rule">
                {active.map((o) => (
                  <li
                    key={o.id}
                    className={cn(
                      'flex items-baseline gap-3 py-1.5 text-sm',
                      scoped && scoped.id !== o.id && 'text-muted-foreground',
                    )}
                  >
                    <span className="w-14 font-mono text-[0.8rem] font-medium">{o.code}</span>
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </Region>
        </div>
      </div>
    </>
  )
}
